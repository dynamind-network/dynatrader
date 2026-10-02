/**
 * Per-Tool Timeout Controller
 *
 * Provides AbortController-based timeouts for tool execution.
 */

export class TimeoutError extends Error {
  constructor(message?: string) {
    super(message ?? "Operation timed out");
    this.name = "TimeoutError";
  }
}

/**
 * Wraps a promise with a timeout.
 * If the timeout expires before the promise settles, rejects with TimeoutError
 * and calls abort() on the AbortController if one is provided.
 *
 * @param promise - The operation to wrap
 * @param timeoutMs - Timeout in milliseconds
 * @param abortController - Optional AbortController to abort on timeout
 * @returns The result of the wrapped promise
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  abortController?: AbortController,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      abortController?.abort();
      reject(new TimeoutError(`Operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutHandle!);
    return result;
  } catch (error) {
    clearTimeout(timeoutHandle!);
    throw error;
  }
}

/**
 * Creates a promise that rejects when the signal is aborted.
 * Useful when you want to support cancellation beyond timeouts.
 *
 * @param signal - AbortSignal to listen to
 * @returns A promise that rejects when the signal is aborted
 */
export function cancelTimeout(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(new Error("Operation cancelled"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        reject(new Error("Operation cancelled"));
      },
      { once: true },
    );
  });
}
