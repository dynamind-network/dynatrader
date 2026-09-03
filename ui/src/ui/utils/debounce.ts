import { useRef, useCallback } from 'react';

/**
 * createDebouncer - Pure utility for debouncing in non-React contexts.
 *
 * Returns a debouncer object with schedule() and cancel() methods.
 * Each call to schedule() cancels any pending invocation and starts
 * a fresh timer. Only the most recently scheduled function executes.
 *
 * @param delay - Debounce delay in milliseconds.
 * @returns Debouncer with schedule() and cancel() methods.
 *
 * @example
 * const debouncer = createDebouncer(300);
 * debouncer.schedule(() => console.log('fired'));
 * debouncer.cancel(); // cancels pending call
 */
export function createDebouncer(delay: number) {
  let timerId: ReturnType<typeof setTimeout> | undefined;

  return {
    /** Schedule a function to run after the debounce delay. */
    schedule(fn: () => void): void {
      if (timerId !== undefined) {
        clearTimeout(timerId);
      }
      timerId = setTimeout(() => {
        timerId = undefined;
        fn();
      }, delay);
    },

    /** Cancel any pending scheduled call. */
    cancel(): void {
      if (timerId !== undefined) {
        clearTimeout(timerId);
        timerId = undefined;
      }
    },
  };
}

/**
 * useDebouncedCallback - Returns a stable debounced callback that always
 * invokes the latest version of the provided callback.
 *
 * The returned function reference is stable (useCallback with [] deps),
 * so it can be safely used in effect dependency arrays without causing
 * re-runs. Internally, a ref tracks the latest callback implementation.
 *
 * Reference pattern: StatusLine.tsx lines 226-234
 *   const scheduleUpdate = useCallback(() => {
 *     if (debounceTimerRef.current !== undefined) {
 *       clearTimeout(debounceTimerRef.current);
 *     }
 *     debounceTimerRef.current = setTimeout((ref, doUpdate) => {
 *       ref.current = undefined;
 *       void doUpdate();
 *     }, 300, debounceTimerRef, doUpdate);
 *   }, [doUpdate]);
 *
 * @param callback - The function to debounce.
 * @param delay - Debounce delay in milliseconds.
 * @returns A stable debounced function with a cancel() method.
 *
 * @example
 * function MyComponent({ value }) {
 *   const debouncedLog = useDebouncedCallback(
 *     (v) => console.log(v),
 *     300
 *   );
 *
 *   // debouncedLog is stable - safe in useEffect deps
 *   useEffect(() => {
 *     debouncedLog(value);
 *   }, [value, debouncedLog]);
 * }
 */
export function useDebouncedCallback<T extends (...args: unknown[]) => void>(
  callback: T,
  delay: number
): ((...args: Parameters<T>) => void) & { cancel: () => void } {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const debounced = Object.assign(
    (...args: Parameters<T>) => {
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(
        (ref, cb, capturedArgs) => {
          ref.current = undefined;
          cb(...capturedArgs);
        },
        delay,
        timerRef,
        callbackRef.current,
        args
      );
    },
    {
      cancel: () => {
        if (timerRef.current !== undefined) {
          clearTimeout(timerRef.current);
          timerRef.current = undefined;
        }
      },
    }
  );

  return debounced;
}
