/**
 * TurnController — Per-Session FIFO, Cross-Session Parallelism
 *
 * Atomic Agent pattern. Every entry point (chat, CLI, daemon, cron)
 * funnels through enqueue(). At most one run() executes concurrently
 * per sessionId. Different sessions never block each other.
 *
 * Events are per-session: two submissions on different sessions never
 * share a hook.
 */

export type TurnOrigin = "cli" | "tui" | "http" | "daemon" | "cron" | "telegram";

export type TurnEventHook = (event: TurnEvent) => void;

export interface TurnEvent {
  type: string;
  [key: string]: unknown;
}

export interface TurnSubmission<T> {
  sessionId: string;
  origin: TurnOrigin;
  run: () => Promise<T>;
  eventHook?: TurnEventHook;
  signal?: AbortSignal;
}

export interface TurnControllerConfig {
  onHookError?: (err: unknown, context: { sessionId: string; origin: TurnOrigin }) => void;
}

export class TurnController {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly currentHooks = new Map<string, TurnEventHook>();
  private readonly busy = new Set<string>();
  private readonly onHookError?: TurnControllerConfig["onHookError"];

  constructor(config?: TurnControllerConfig) {
    this.onHookError = config?.onHookError;
  }

  /**
   * Submit a turn. Resolves when run() completes.
   * If session is busy, waits behind the in-flight submission (FIFO).
   * If signal aborts before run() starts, rejects without executing.
   */
  async enqueue<T>(submission: TurnSubmission<T>): Promise<T> {
    const { sessionId, eventHook, signal, run } = submission;

    if (signal?.aborted) {
      throw abortReason(signal);
    }

    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const previousSettled = previous.catch(() => undefined);

    let release!: () => void;
    const ownTurn = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.queues.set(sessionId, ownTurn);

    try {
      await waitOrAbort(previousSettled, signal);
      if (eventHook) {
        this.currentHooks.set(sessionId, eventHook);
      }
      this.busy.add(sessionId);
      try {
        return await run();
      } finally {
        this.busy.delete(sessionId);
        if (eventHook) {
          this.currentHooks.delete(sessionId);
        }
      }
    } finally {
      release();
      if (this.queues.get(sessionId) === ownTurn) {
        this.queues.delete(sessionId);
      }
    }
  }

  /**
   * Forward an event to the active submission's hook.
   * No-op when no submission is running for sessionId.
   */
  emit(sessionId: string, event: TurnEvent): void {
    const hook = this.currentHooks.get(sessionId);
    if (!hook) return;
    try {
      hook(event);
    } catch (err) {
      this.onHookError?.(err, { sessionId, origin: "http" });
    }
  }

  isBusy(sessionId: string): boolean {
    return this.busy.has(sessionId);
  }

  busySessionIds(): readonly string[] {
    return [...this.busy];
  }
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined && signal.reason !== null) {
    return signal.reason;
  }
  return new DOMException("aborted", "AbortError");
}

function waitOrAbort(p: Promise<unknown>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return p.then(() => undefined);
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    p.then(
      () => { cleanup(); resolve(); },
      () => { cleanup(); resolve(); },
    );
  });
}
