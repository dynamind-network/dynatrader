/**
 * Session-scoped execution primitives for language REPL adapters.
 *
 * Security boundary: this module is lifecycle/orchestration code, not a
 * sandbox. A kernel that evaluates arbitrary source MUST provide its own
 * process/container isolation, filesystem/network policy, and resource limits.
 * Do not implement an adapter with node:vm and describe it as secure isolation.
 * The SDK bridge intentionally exposes only explicitly registered capabilities;
 * it never forwards process.env, credentials, or arbitrary host objects.
 */

import { DYNA_SDK_METHODS } from "../sdk/dynatrader-sdk";
import type { DynaSdkInvoker, DynaSdkMethod } from "../sdk/dynatrader-sdk";
export { DYNA_SDK_METHODS } from "../sdk/dynatrader-sdk";

export type ReplLanguage = "node" | "python";

/** Narrow RPC surface passed to an isolated kernel. Implementations should
 * enforce authorization at the capability boundary for every call. */
export interface LocalSdkBridge {
  /** Mirrors the Python-side `sdk.call(method, **kwargs)` convention. */
  call<T = unknown>(method: DynaSdkMethod, params: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
  readonly methods: readonly DynaSdkMethod[];
}

export interface ReplExecutionResult {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly value?: unknown;
}

/** Adapter contract for a persistent language process/kernel. */
export interface ReplKernel {
  execute(source: string, sdk: LocalSdkBridge, signal: AbortSignal): Promise<ReplExecutionResult>;
  /** Must terminate the underlying execution environment and release resources. */
  dispose(): Promise<void>;
}

export interface ReplKernelFactory {
  create(input: {
    readonly language: ReplLanguage;
    readonly sessionId: string;
    readonly sdk: LocalSdkBridge;
  }): Promise<ReplKernel>;
}

export interface ReplRuntimeOptions {
  readonly timeoutMs?: number;
  readonly maxOutputChars?: number;
}

export interface ReplExecutionOutput extends ReplExecutionResult {
  readonly truncated: boolean;
  readonly durationMs: number;
}

export class ReplRuntimeError extends Error {
  constructor(message: string, readonly code: "TIMEOUT" | "CANCELLED" | "CLOSED" | "INVALID") {
    super(message);
    this.name = "ReplRuntimeError";
  }
}

interface Session {
  readonly key: string;
  readonly language: ReplLanguage;
  readonly sessionId: string;
  kernel: ReplKernel | null;
  sdk: LocalSdkBridge | null;
  queue: Promise<void>;
  active: AbortController | null;
  closed: boolean;
}

/**
 * Owns lazy, persistent kernels keyed by language and conversation session.
 * Calls within one kernel are serialized; different sessions can run in
 * parallel. Timeout/cancellation disposes the kernel so stuck interpreter
 * state cannot silently continue into the next turn.
 */
export class SessionReplRuntime {
  private readonly sessions = new Map<string, Session>();
  private readonly closedSessions = new Set<string>();
  private readonly timeoutMs: number;
  private readonly maxOutputChars: number;

  constructor(
    private readonly factory: ReplKernelFactory,
    private readonly sdk: DynaSdkInvoker,
    options: ReplRuntimeOptions = {},
  ) {
    this.timeoutMs = positiveInteger(options.timeoutMs, 30_000);
    this.maxOutputChars = positiveInteger(options.maxOutputChars, 32_000);
  }

  async execute(
    language: ReplLanguage,
    sessionId: string,
    source: string,
    signal?: AbortSignal,
  ): Promise<ReplExecutionOutput> {
    if (!sessionId.trim() || !source.trim()) throw new ReplRuntimeError("session id and source are required", "INVALID");
    if (signal?.aborted) throw new ReplRuntimeError("execution cancelled", "CANCELLED");
    if (this.closedSessions.has(sessionKey(language, sessionId))) throw new ReplRuntimeError("REPL session is closed", "CLOSED");
    const session = this.getSession(language, sessionId);

    let release!: () => void;
    const prior = session.queue;
    session.queue = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      if (session.closed) throw new ReplRuntimeError("REPL session is closed", "CLOSED");
      if (signal?.aborted) throw new ReplRuntimeError("execution cancelled", "CANCELLED");
      if (!session.kernel) {
        session.sdk = createSessionBridge(this.sdk, session);
        session.kernel = await this.factory.create({ language, sessionId, sdk: session.sdk });
      }
      return await this.runInKernel(session, source, signal);
    } finally {
      release();
    }
  }

  /** Explicitly permits a previously closed conversation to start a new kernel. */
  open(language: ReplLanguage, sessionId: string): void {
    if (!sessionId.trim()) throw new ReplRuntimeError("session id is required", "INVALID");
    this.closedSessions.delete(sessionKey(language, sessionId));
  }

  async cancel(language: ReplLanguage, sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionKey(language, sessionId));
    if (!session) return false;
    session.active?.abort();
    await this.disposeKernel(session);
    return true;
  }

  async close(language: ReplLanguage, sessionId: string): Promise<boolean> {
    const key = sessionKey(language, sessionId);
    const session = this.sessions.get(key);
    if (!session) return false;
    session.closed = true;
    this.closedSessions.add(key);
    session.active?.abort();
    await this.disposeKernel(session);
    this.sessions.delete(key);
    return true;
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    for (const session of sessions) {
      session.closed = true;
      session.active?.abort();
    }
    await Promise.all(sessions.map((session) => this.disposeKernel(session)));
    this.sessions.clear();
    this.closedSessions.clear();
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  private getSession(language: ReplLanguage, sessionId: string): Session {
    const key = sessionKey(language, sessionId);
    let session = this.sessions.get(key);
    if (!session) {
      session = { key, language, sessionId, kernel: null, sdk: null, queue: Promise.resolve(), active: null, closed: false };
      this.sessions.set(key, session);
    }
    return session;
  }

  private async runInKernel(session: Session, source: string, external?: AbortSignal): Promise<ReplExecutionOutput> {
    const controller = new AbortController();
    session.active = controller;
    const abort = (): void => controller.abort();
    external?.addEventListener("abort", abort, { once: true });
    let timedOut = false;
    let rejectAbort!: (error: ReplRuntimeError) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onAbort = (): void => {
      rejectAbort(new ReplRuntimeError(timedOut ? `execution exceeded ${this.timeoutMs}ms` : "execution cancelled", timedOut ? "TIMEOUT" : "CANCELLED"));
      // Termination is delegated to the kernel adapter. The runtime never
      // relies on interpreter code cooperatively returning after cancellation.
      void this.disposeKernel(session);
    };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    const started = Date.now();
    try {
      const result = await Promise.race([
        session.kernel!.execute(source, session.sdk!, controller.signal),
        aborted,
      ]);
      if (timedOut) throw new ReplRuntimeError(`execution exceeded ${this.timeoutMs}ms`, "TIMEOUT");
      if (external?.aborted) throw new ReplRuntimeError("execution cancelled", "CANCELLED");
      const bounded = boundOutput(result, this.maxOutputChars);
      return { ...bounded.result, truncated: bounded.truncated, durationMs: Date.now() - started };
    } catch (error) {
      if (timedOut) throw new ReplRuntimeError(`execution exceeded ${this.timeoutMs}ms`, "TIMEOUT");
      if (external?.aborted || controller.signal.aborted) throw new ReplRuntimeError("execution cancelled", "CANCELLED");
      throw error;
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      external?.removeEventListener("abort", abort);
      session.active = null;
      if (controller.signal.aborted) await this.disposeKernel(session);
    }
  }

  private async disposeKernel(session: Session): Promise<void> {
    const kernel = session.kernel;
    session.kernel = null;
    session.sdk = null;
    if (kernel) await kernel.dispose();
  }
}

/** Language-specific services expose a small integration surface to tool wiring. */
export abstract class LanguageReplService {
  protected constructor(
    private readonly runtime: SessionReplRuntime,
    readonly language: ReplLanguage,
  ) {}

  execute(sessionId: string, source: string, signal?: AbortSignal): Promise<ReplExecutionOutput> {
    return this.runtime.execute(this.language, sessionId, source, signal);
  }

  cancel(sessionId: string): Promise<boolean> {
    return this.runtime.cancel(this.language, sessionId);
  }

  close(sessionId: string): Promise<boolean> {
    return this.runtime.close(this.language, sessionId);
  }

  open(sessionId: string): void {
    this.runtime.open(this.language, sessionId);
  }
}

export class NodeReplService extends LanguageReplService {
  constructor(runtime: SessionReplRuntime) { super(runtime, "node"); }
}

export class PythonReplService extends LanguageReplService {
  constructor(runtime: SessionReplRuntime) { super(runtime, "python"); }
}

function sessionKey(language: ReplLanguage, sessionId: string): string {
  return `${language}\0${sessionId}`;
}

function createSessionBridge(invoker: DynaSdkInvoker, session: Session): LocalSdkBridge {
  const methods: readonly DynaSdkMethod[] = DYNA_SDK_METHODS;
  const allowed = new Set<string>(methods);
  return {
    methods,
    call<T>(method: DynaSdkMethod, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
      if (!allowed.has(method)) return Promise.reject(new ReplRuntimeError(`SDK method is not available to REPLs: ${String(method)}`, "INVALID"));
      const activeSignal = signal ?? session.active?.signal;
      if (activeSignal?.aborted) return Promise.reject(new ReplRuntimeError("SDK call cancelled", "CANCELLED"));
      return invoker.invoke<T>(method, params, { sessionId: session.sessionId, signal: activeSignal });
    },
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

function boundOutput(result: ReplExecutionResult, limit: number): { result: ReplExecutionResult; truncated: boolean } {
  let remaining = limit;
  let truncated = false;
  const take = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    if (value.length <= remaining) { remaining -= value.length; return value; }
    truncated = true;
    const bounded = value.slice(0, Math.max(0, remaining));
    remaining = 0;
    return bounded;
  };
  const stdout = take(result.stdout);
  const stderr = take(result.stderr);
  let value = result.value;
  if (value !== undefined) {
    let serialized: string;
    try { serialized = JSON.stringify(value) ?? String(value); } catch { serialized = "[unserializable value]"; }
    if (serialized.length > remaining) {
      truncated = true;
      value = serialized.slice(0, Math.max(0, remaining));
    }
  }
  return { result: { stdout, stderr, value }, truncated };
}
