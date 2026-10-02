/**
 * PythonStrategyBridge
 *
 * Spawns the Python DynaTrader SDK strategy server as a child process and speaks
 * JSON-RPC 2.0 over newline-delimited stdio (JSON-Lines). Mirrors
 * mcp-stdio-transport: buffered line parsing, per-request timeouts, and
 * process error/close propagation.
 *
 * The child is spawned lazily on the first request and kept alive until
 * stop() is called or the process exits.
 */

import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Protocol types (mirror dynamind/server.py responses)
// ---------------------------------------------------------------------------

export interface StrategySignal {
  symbol: string;
  action: "buy" | "sell" | "hold";
  confidence: number;
  reasoning: string;
  meta?: Record<string, unknown>;
}

export interface BacktestMetrics {
  total_return: number;
  max_drawdown: number;
  max_drawdown_pct: number;
  win_rate: number;
  total_trades: number;
  wins: number;
  losses: number;
  avg_win: number;
  avg_loss: number;
  profit_factor: number | null;
  net_pnl: number;
  empty: boolean;
}

export interface RiskGate {
  approved: boolean;
  reason: string;
  suggested_size: number;
}

export interface PluginInfo {
  name: string;
  long_name: string;
  version: string;
  description: string;
  methods: string[];
}

export interface HealthStatus {
  status: string;
  name: string;
  pid: number;
  uptime_s: number;
}

export interface Notification {
  method: string;
  params?: unknown;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Bridge error carrying the JSON-RPC error code returned by the child. */
export class PythonBridgeError extends Error {
  override readonly cause?: unknown;

  constructor(
    readonly code: number,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "PythonBridgeError";
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Child process abstraction (injectable for tests)
// ---------------------------------------------------------------------------

export interface ChildStream {
  on(event: string, listener: (...args: unknown[]) => void): this;
}

export interface ChildStdin {
  readonly writable: boolean;
  write(
    chunk: string,
    encoding?: BufferEncoding,
    cb?: (error?: Error | null) => void,
  ): boolean;
  end(cb?: () => void): this;
}

export interface ChildProcessLike {
  readonly pid?: number;
  readonly killed: boolean;
  stdin: ChildStdin;
  stdout?: ChildStream;
  stderr?: ChildStream;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "error", listener: (err: Error) => void): this;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

export interface SpawnOptionsLike {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio: "pipe";
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsLike,
) => ChildProcessLike;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface PythonBridgeOptions {
  /** Command to spawn. Defaults to $DYNAMIND_PYTHON_CMD or "python". */
  command?: string;
  /** Arguments passed to the command. Defaults to ["-m", "dynamind.server"]. */
  args?: string[];
  /** Working directory for the child process. */
  cwd?: string;
  /** Environment for the child process. Defaults to the parent env. */
  env?: NodeJS.ProcessEnv;
  /** Per-request timeout in milliseconds. Defaults to 15000. */
  timeoutMs?: number;
  /** Injectable spawn function (tests). Defaults to node:child_process spawn. */
  spawnFn?: SpawnFn;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
}

// ---------------------------------------------------------------------------
// PythonStrategyBridge
// ---------------------------------------------------------------------------

export class PythonStrategyBridge extends EventEmitter {
  private process_: ChildProcessLike | null = null;
  private pendingRequests: Map<number, PendingRequest> = new Map();
  private buffer: string = "";
  private messageId: number = 0;
  private startPromise: Promise<ChildProcessLike> | null = null;
  private stopped: boolean = false;

  constructor(private readonly options: PythonBridgeOptions = {}) {
    super();
  }

  /** True while a child process is running. */
  isRunning(): boolean {
    return this.process_ !== null && !this.process_.killed;
  }

  /**
   * Send a JSON-RPC request and await the matching response. Spawns the child
   * process lazily on first use.
   */
  async request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const child = await this.start();
    if (!child.stdin.writable) {
      throw new PythonBridgeError(
        -32000,
        "python strategy process stdin is not writable",
      );
    }

    const timeoutMs = this.options.timeoutMs ?? 15000;
    const id = ++this.messageId;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(
          new PythonBridgeError(
            -32001,
            `python strategy request '${method}' timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      const payload =
        JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }) +
        "\n";
      try {
        child.stdin.write(payload, "utf-8");
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(new PythonBridgeError(-32000, "failed to write request", err));
      }
    });
  }

  // -------------------------------------------------------------------------
  // Typed convenience methods
  // -------------------------------------------------------------------------

  info(): Promise<PluginInfo> {
    return this.request<PluginInfo>("plugin.info", {});
  }

  health(): Promise<HealthStatus> {
    return this.request<HealthStatus>("health", {});
  }

  onMarket(symbol: string): Promise<StrategySignal> {
    return this.request<StrategySignal>("strategy.on_market", { symbol });
  }

  generateSignals(symbols: string[]): Promise<StrategySignal[]> {
    return this.request<StrategySignal[]>("strategy.generate_signals", {
      symbols,
    });
  }

  validateBacktest(result: Record<string, unknown>): Promise<BacktestMetrics> {
    return this.request<BacktestMetrics>("strategy.validate_backtest", {
      result,
    });
  }

  riskCheck(
    signal: Record<string, unknown>,
    positionSize: number,
    maxRisk: number,
  ): Promise<RiskGate> {
    return this.request<RiskGate>("strategy.risk_check", {
      signal,
      position_size: positionSize,
      max_risk: maxRisk,
    });
  }

  /**
   * Kill the child process and reject every pending request.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.rejectAllPending(new PythonBridgeError(-32000, "bridge stopped"));
    const child = this.process_;
    this.process_ = null;
    this.startPromise = null;
    if (child && !child.killed) {
      try {
        child.kill();
      } catch {
        // Child already gone.
      }
    }
  }

  // -------------------------------------------------------------------------
  // Process lifecycle
  // -------------------------------------------------------------------------

  private start(): Promise<ChildProcessLike> {
    if (this.process_) {
      return Promise.resolve(this.process_);
    }
    if (!this.startPromise) {
      this.startPromise = this.spawnProcess();
    }
    return this.startPromise;
  }

  private spawnProcess(): Promise<ChildProcessLike> {
    const command = this.options.command ?? process.env["DYNAMIND_PYTHON_CMD"] ?? "python";
    const args = this.options.args ?? ["-m", "dynamind.server"];
    const spawnFn = this.options.spawnFn ?? spawn;

    const child = spawnFn(command, args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: "pipe",
    });
    this.process_ = child;

    child.stderr?.on("data", (chunk: unknown) => {
      console.debug(`[PythonStrategyBridge] stderr:`, String(chunk).trimEnd());
    });

    child.stdout?.on("data", (chunk: unknown) => {
      this.buffer += String(chunk);
      this.processBuffer();
    });

    child.on("error", (err) => {
      this.process_ = null;
      this.startPromise = null;
      this.rejectAllPending(
        new PythonBridgeError(-32000, `python strategy process error`, err),
      );
    });

    child.on("close", (code) => {
      if (this.stopped) {
        return;
      }
      this.process_ = null;
      this.startPromise = null;
      this.rejectAllPending(
        new PythonBridgeError(
          -32000,
          `python strategy process exited with code ${code ?? "null"}`,
        ),
      );
      console.debug(
        `[PythonStrategyBridge] process exited with code ${code ?? "null"}`,
      );
    });

    return Promise.resolve(child);
  }

  // -------------------------------------------------------------------------
  // Response parsing
  // -------------------------------------------------------------------------

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        console.debug(
          `[PythonStrategyBridge] ignoring non-JSON line: ${trimmed}`,
        );
        continue;
      }

      if (frame === null || typeof frame !== "object" || frame["jsonrpc"] !== "2.0") {
        continue;
      }

      const id = frame["id"];
      if (typeof id === "number") {
        this.resolveResponse(id, frame);
      } else if (id === undefined || id === null) {
        this.emit("notification", {
          method: frame["method"],
          params: frame["params"],
        } as Notification);
      }
    }
  }

  private resolveResponse(
    id: number,
    frame: Record<string, unknown>,
  ): void {
    const pending = this.pendingRequests.get(id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingRequests.delete(id);

    const error = frame["error"] as
      | { code?: unknown; message?: unknown }
      | undefined;
    if (error) {
      pending.reject(
        new PythonBridgeError(
          typeof error.code === "number" ? error.code : -32603,
          typeof error.message === "string" ? error.message : "json-rpc error",
        ),
      );
      return;
    }
    pending.resolve(frame["result"]);
  }

  private rejectAllPending(error: PythonBridgeError): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }
}