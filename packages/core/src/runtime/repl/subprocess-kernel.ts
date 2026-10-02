/**
 * Persistent Node/Python subprocess kernels.
 *
 * IMPORTANT SECURITY LIMITATION: a child process is not an OS security
 * sandbox. These workers run as the current user and can access that user's
 * files/network or spawn descendants. We pass a minimal environment and do
 * not include DynaTrader credentials, but this is suitable only when the
 * caller accepts same-user code execution. Use OS/container isolation before
 * enabling untrusted prompts. The Node vm context is for persistent globals,
 * not security isolation.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { ChildProcess } from "node:child_process";
import type { Socket } from "node:net";
import { DYNA_SDK_METHODS } from "../sdk/dynatrader-sdk";
import type { DynaSdkMethod } from "../sdk/dynatrader-sdk";
import type {
  LocalSdkBridge,
  ReplKernel,
  ReplKernelFactory,
  ReplLanguage,
  ReplExecutionResult,
} from "./session-runtime";

export interface SubprocessReplOptions {
  readonly nodeExecutable?: string;
  readonly pythonExecutable?: string;
  readonly cwd?: string;
  readonly startupTimeoutMs?: number;
  readonly maxProtocolLineBytes?: number;
}

type WorkerMessage =
  | { type: "ready" }
  | { type: "sdk_call"; id: number; method: string; params: Record<string, unknown> }
  | { type: "result"; id: number; stdout?: string; stderr?: string; value?: unknown }
  | { type: "fatal"; message: string };

type ParentMessage =
  | { type: "execute"; id: number; source: string }
  | { type: "sdk_result"; id: number; ok: true; result: unknown }
  | { type: "sdk_result"; id: number; ok: false; error: string };

/** Creates one persistent subprocess per kernel/session. */
export class SubprocessReplKernelFactory implements ReplKernelFactory {
  constructor(private readonly options: SubprocessReplOptions = {}) {}

  async create(input: { readonly language: ReplLanguage; readonly sessionId: string; readonly sdk: LocalSdkBridge }): Promise<ReplKernel> {
    const command = input.language === "node"
      ? (this.options.nodeExecutable ?? process.execPath)
      : resolvePython(this.options.pythonExecutable);
    const args = input.language === "node"
      ? ["-e", NODE_WORKER]
      : ["-I", "-u", "-c", PYTHON_WORKER];
    const child = spawn(command, args, {
      cwd: this.options.cwd ?? tmpdir(),
      env: minimalEnvironment(),
      stdio: ["pipe", "ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const control = child.stdio[3] as Socket | null;
    if (!control) {
      child.kill();
      throw new Error("REPL subprocess control pipe was not created");
    }
    const kernel = new SubprocessReplKernel(child, control, input.sdk, this.options);
    try {
      await kernel.ready();
      return kernel;
    } catch (error) {
      await kernel.dispose();
      throw error;
    }
  }
}

class SubprocessReplKernel implements ReplKernel {
  private buffer = "";
  private requestId = 0;
  private rpcId = 0;
  private pending: { id: number; resolve: (result: ReplExecutionResult) => void; reject: (error: Error) => void; signal: AbortSignal | null } | null = null;
  private readonly readyPromise: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readySettled = false;
  private closed = false;
  private protocolError: Error | null = null;
  private stderrBuffer = "";
  private readonly maxLineBytes: number;

  constructor(
    private readonly child: ChildProcess,
    private readonly control: Socket,
    private readonly sdk: LocalSdkBridge,
    private readonly options: SubprocessReplOptions,
  ) {
    this.maxLineBytes = positive(options.maxProtocolLineBytes, 4 * 1024 * 1024);
    this.readyPromise = new Promise<void>((resolveReady, rejectReady) => {
      this.readyResolve = resolveReady;
      this.readyReject = rejectReady;
    });
    control.setEncoding("utf8");
    control.on("data", (chunk: string) => this.onData(chunk));
    control.on("error", (error) => this.fail(error));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrBuffer = appendBounded(this.stderrBuffer, chunk, 16_000);
    });
    child.on("error", (error) => this.fail(error));
    child.on("close", (code, signal) => {
      if (this.closed) return;
      this.fail(new Error(`REPL subprocess exited (code=${code ?? "null"}, signal=${signal ?? "none"})${this.stderrBuffer ? `: ${this.stderrBuffer}` : ""}`));
    });
    const timer = setTimeout(() => this.fail(new Error("REPL subprocess startup timed out")), positive(options.startupTimeoutMs, 10_000));
    void this.readyPromise.finally(() => clearTimeout(timer)).catch(() => undefined);
  }

  ready(): Promise<void> { return this.readyPromise; }

  execute(source: string, _sdk: LocalSdkBridge, signal: AbortSignal): Promise<ReplExecutionResult> {
    if (this.closed) return Promise.reject(new Error("REPL subprocess is closed"));
    if (this.protocolError) return Promise.reject(this.protocolError);
    if (this.pending) return Promise.reject(new Error("REPL subprocess already has an active request"));
    const id = ++this.requestId;
    return new Promise<ReplExecutionResult>((resolveResult, rejectResult) => {
      const onAbort = (): void => {
        this.pending = null;
        rejectResult(new Error("REPL subprocess execution cancelled"));
        void this.dispose();
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending = {
        id,
        resolve: (result) => { signal.removeEventListener("abort", onAbort); resolveResult(result); },
        reject: (error) => { signal.removeEventListener("abort", onAbort); rejectResult(error); },
        signal,
      };
      this.send({ type: "execute", id, source });
    });
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const active = this.pending;
    this.pending = null;
    active?.reject(new Error("REPL subprocess disposed"));
    this.control.destroy();
    if (this.child.exitCode !== null) return;
    const exited = new Promise<void>((resolveExit) => this.child.once("close", () => resolveExit()));
    try { this.child.stdin?.end(); } catch { /* process may already have exited */ }
    if (!this.child.killed) {
      try { this.child.kill(); } catch { /* process may already have exited */ }
    }
    await Promise.race([exited, delay(500)]);
    if (this.child.exitCode === null) {
      try { this.child.kill("SIGKILL"); } catch { /* best effort */ }
      await Promise.race([exited, delay(500)]);
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxLineBytes && !this.buffer.includes("\n")) {
      this.fail(new Error("REPL protocol frame exceeded size limit"));
      return;
    }
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, "utf8") > this.maxLineBytes) {
        this.fail(new Error("REPL protocol frame exceeded size limit"));
        return;
      }
      let message: WorkerMessage;
      try { message = JSON.parse(line) as WorkerMessage; }
      catch { this.fail(new Error("REPL worker emitted invalid protocol JSON")); return; }
      this.onMessage(message);
    }
  }

  private onMessage(message: WorkerMessage): void {
    if (message.type === "ready") {
      if (!this.readySettled) { this.readySettled = true; this.readyResolve(); }
      return;
    }
    if (message.type === "fatal") { this.fail(new Error(message.message)); return; }
    if (message.type === "sdk_call") {
      void this.handleSdkCall(message);
      return;
    }
    if (message.type === "result") {
      const pending = this.pending;
      if (!pending || pending.id !== message.id) return;
      this.pending = null;
      pending.resolve({
        stdout: message.stdout,
        stderr: appendBounded(message.stderr ?? "", this.stderrBuffer, 16_000),
        value: message.value,
      });
    }
  }

  private async handleSdkCall(message: Extract<WorkerMessage, { type: "sdk_call" }>): Promise<void> {
    const method = message.method as DynaSdkMethod;
    if (!DYNA_SDK_METHODS.includes(method) || !this.pending) {
      this.send({ type: "sdk_result", id: message.id, ok: false, error: "SDK method is unavailable" });
      return;
    }
    try {
      const result = await this.sdk.call(method, message.params, this.pending.signal ?? undefined);
      this.send({ type: "sdk_result", id: message.id, ok: true, result });
    } catch (error) {
      this.send({ type: "sdk_result", id: message.id, ok: false, error: errorMessage(error) });
    }
  }

  private send(message: ParentMessage): void {
    if (this.closed || !this.child.stdin?.writable) return;
    try { this.child.stdin.write(`${JSON.stringify(message)}\n`); }
    catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }

  private fail(error: Error): void {
    if (!this.readySettled) {
      this.readySettled = true;
      this.readyReject(error);
    }
    if (this.protocolError) return;
    this.protocolError = error;
    const pending = this.pending;
    this.pending = null;
    pending?.reject(error);
    if (!this.closed) void this.dispose();
  }
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

function resolvePython(configured?: string): string {
  const command = configured ?? process.env.DYNAMIND_PYTHON_CMD ?? "python";
  if (command.includes("/") || command.includes("\\")) return resolve(command);
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
    : [""];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`Python executable '${command}' was not found on PATH`);
}

function positive(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

function appendBounded(current: string, addition: string, max: number): string {
  const joined = `${current}${addition}`;
  return joined.length <= max ? joined : joined.slice(-max);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

const NODE_WORKER = String.raw`
const fs = require('node:fs');
const vm = require('node:vm');
const readline = require('node:readline');
const util = require('node:util');
let nextCall = 0;
let active = null;
const waiting = new Map();
const send = (value) => fs.writeSync(3, JSON.stringify(value) + '\n');
const safeValue = (value) => {
  if (value === undefined) return undefined;
  try { JSON.stringify(value); return value; } catch { return util.inspect(value, { depth: 3, maxArrayLength: 50 }); }
};
const sdkCall = (method, params = {}) => {
  return new Promise((resolve, reject) => {
    const id = ++nextCall;
    waiting.set(id, { resolve, reject });
    send({ type: 'sdk_call', id, method, params });
  });
};
const sdk = Object.freeze({
  call: sdkCall,
  tools: Object.freeze({
    list: () => sdkCall('tools.list'),
    call: (name, args = {}) => sdkCall('tools.call', { name, args }),
  }),
});
const logs = { stdout: [], stderr: [] };
const capture = (target, args) => target.push(util.format(...args));
const context = vm.createContext({
  sdk,
  console: Object.freeze({
    log: (...args) => capture(logs.stdout, args), info: (...args) => capture(logs.stdout, args),
    warn: (...args) => capture(logs.stderr, args), error: (...args) => capture(logs.stderr, args),
    debug: (...args) => capture(logs.stdout, args),
  }),
}, { name: 'DynaTrader REPL' });
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
send({ type: 'ready' });
input.on('line', async (line) => {
  let frame;
  try { frame = JSON.parse(line); } catch { return; }
  if (frame.type === 'sdk_result') {
    const call = waiting.get(frame.id);
    if (!call) return;
    waiting.delete(frame.id);
    if (frame.ok) call.resolve(frame.result); else call.reject(new Error(frame.error || 'SDK call failed'));
    return;
  }
  if (frame.type !== 'execute' || active) return;
  active = frame.id;
  logs.stdout.length = 0; logs.stderr.length = 0;
  try {
    let script;
    const compile = (body) => new vm.Script(body, { filename: 'dyna-repl.js' });
    try { script = compile('(async () => (' + frame.source + '\n))()'); }
    catch {
      // Preserve the common REPL convention of returning the final expression
      // after preceding statements, without adding a parser dependency.
      const separators = [...frame.source.matchAll(/[;\n]/g)].map((match) => match.index).reverse();
      for (const index of separators) {
        const tail = frame.source.slice(index + 1).trim();
        if (!tail || tail.startsWith('//')) continue;
        try {
          script = compile('(async () => {\n' + frame.source.slice(0, index + 1) + '\nreturn (' + tail + '\n)\n})()');
          break;
        } catch { /* test the previous statement boundary */ }
      }
      if (!script) script = compile('(async () => {\n' + frame.source + '\n})()');
    }
    const value = await script.runInContext(context, { timeout: 1000 });
    send({ type: 'result', id: frame.id, stdout: logs.stdout.join('\n'), stderr: logs.stderr.join('\n'), value: safeValue(value) });
  } catch (error) {
    logs.stderr.push(error && error.stack ? error.stack : String(error));
    send({ type: 'result', id: frame.id, stdout: logs.stdout.join('\n'), stderr: logs.stderr.join('\n') });
  } finally { active = null; }
});
`;

const PYTHON_WORKER = String.raw`
import ast, builtins, contextlib, io, json, os, sys, traceback
CONTROL = 3
next_call = 0
def send(frame):
    os.write(CONTROL, (json.dumps(frame, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))
def read_frame():
    line = sys.stdin.readline()
    if not line:
        raise RuntimeError("host control stream closed")
    return json.loads(line)
class SDK:
    def call(self, method, **kwargs):
        global next_call
        next_call += 1
        call_id = next_call
        send({"type":"sdk_call", "id":call_id, "method":method, "params":kwargs})
        while True:
            frame = read_frame()
            if frame.get("type") != "sdk_result" or frame.get("id") != call_id:
                raise RuntimeError("unexpected host frame while awaiting SDK result")
            if frame.get("ok"):
                return frame.get("result")
            raise RuntimeError(frame.get("error", "SDK call failed"))
class SDKTools:
    def list(self):
        return sdk.call("tools.list")
    def call(self, name, args=None):
        return sdk.call("tools.call", name=name, args=args or {})
sdk = SDK()
sdk.tools = SDKTools()
def safe_value(value):
    try:
        json.dumps(value)
        return value
    except Exception:
        return repr(value)
namespace = {"__name__":"__main__", "sdk":sdk}
send({"type":"ready"})
while True:
    line = sys.stdin.readline()
    if not line:
        break
    try:
        frame = json.loads(line)
    except Exception:
        continue
    if frame.get("type") != "execute":
        continue
    stdout, stderr = io.StringIO(), io.StringIO()
    value = None
    try:
        tree = ast.parse(frame["source"], filename="<dyna-repl>", mode="exec")
        final_expr = tree.body[-1] if tree.body and isinstance(tree.body[-1], ast.Expr) else None
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            if final_expr:
                tree.body = tree.body[:-1]
                if tree.body:
                    exec(compile(tree, "<dyna-repl>", "exec"), namespace, namespace)
                value = eval(compile(ast.Expression(final_expr.value), "<dyna-repl>", "eval"), namespace, namespace)
            else:
                exec(compile(tree, "<dyna-repl>", "exec"), namespace, namespace)
    except BaseException:
        traceback.print_exc(file=stderr)
    send({"type":"result", "id":frame["id"], "stdout":stdout.getvalue(), "stderr":stderr.getvalue(), "value":safe_value(value)})
`;
