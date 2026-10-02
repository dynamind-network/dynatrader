import { useEffect, useRef, useCallback } from 'react';

/**
 * useAbortableEffect - Wraps useEffect with AbortController lifecycle management.
 *
 * Creates an AbortController, passes its signal to the effect callback,
 * and aborts on cleanup or when dependencies change. This eliminates
 * stale async operations and prevents memory leaks from in-flight requests.
 *
 * Reference pattern: StatusLine.tsx lines 193-195
 *   abortControllerRef.current?.abort();
 *   const controller = new AbortController();
 *   abortControllerRef.current = controller;
 *
 * @param effect - Callback receiving an AbortSignal. Can perform async work
 *                 that should be cancellable via signal.addEventListener('abort', ...).
 * @param deps - Dependency array, same semantics as useEffect.
 * @returns The AbortController instance for external access if needed.
 *
 * @example
 * const controller = useAbortableEffect((signal) => {
 *   const fetchData = async () => {
 *     signal.addEventListener('abort', () => {
 *       // Cleanup in-flight request
 *     }, { once: true });
 *     const res = await fetch('/api/data', { signal });
 *     setData(await res.json());
 *   };
 *   void fetchData();
 * }, [userId]);
 */
export function useAbortableEffect(
  effect: (signal: AbortSignal) => void | (() => void),
  deps: unknown[]
): AbortController {
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;

    const cleanup = effect(controller.signal);

    return () => {
      controller.abort();
      if (typeof cleanup === 'function') {
        cleanup();
      }
    };
  }, deps);

  // Return a stable reference to the current controller
  return controllerRef.current!;
}

