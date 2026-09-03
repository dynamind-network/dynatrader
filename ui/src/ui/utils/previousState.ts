import { useRef, useCallback } from 'react';

/**
 * Shallow equality check for primitives, arrays, and plain objects.
 *
 * - Primitives: strict equality (===)
 * - Arrays: same length, each element strictly equal
 * - Objects: same keys, each value strictly equal
 *
 * This is NOT deep equality - nested objects/arrays are compared by reference.
 */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (a === b) return true;

  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  // If one is array and the other is not, they're not equal
  if (Array.isArray(a) || Array.isArray(b)) return false;

  if (typeof a === 'object' && typeof b === 'object') {
    const keysA = Object.keys(a as object);
    const keysB = Object.keys(b as object);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
      if (
        !Object.prototype.hasOwnProperty.call(b, key) ||
        (a as Record<string, unknown>)[key] !== (b as Record<string, unknown>)[key]
      ) {
        return false;
      }
    }
    return true;
  }

  return false;
}

/**
 * usePreviousState - Tracks the previous value and detects changes.
 *
 * Returns { value, previousValue, hasChanged } where hasChanged uses
 * shallow equality by default, or a custom equality function if provided.
 *
 * Reference pattern: StatusLine.tsx lines 170-182
 *   const previousStateRef = useRef<{ messageId: string | null; ... }>({...});
 *
 * @param value - The current value to track.
 * @param isEqual - Optional custom equality function. Defaults to shallowEqual.
 * @returns Object with current value, previous value, and hasChanged flag.
 *
 * @example
 * function StatusLine({ messageId, model }) {
 *   const { hasChanged } = usePreviousState(
 *     { messageId, model },
 *     (a, b) => a.messageId === b.messageId && a.model === b.model
 *   );
 *
 *   // Only log when something actually changed
 *   if (hasChanged) {
 *     console.log('Status changed');
 *   }
 * }
 */
export function usePreviousState<T>(
  value: T,
  isEqual?: (a: T, b: T) => boolean
): { value: T; previousValue: T | undefined; hasChanged: boolean } {
  const eq = isEqual ?? shallowEqual;

  const previousRef = useRef<{ value: T | undefined; initialized: boolean }>({
    value: undefined,
    initialized: false,
  });

  const previousValue = previousRef.current.value;
  const hasChanged = !previousRef.current.initialized || !eq(value, previousValue as T);

  previousRef.current.value = value;
  previousRef.current.initialized = true;

  return { value, previousValue, hasChanged };
}

/**
 * useMemoizedValue - Memoizes expensive computations with manual cache control.
 *
 * Unlike React.useMemo, this hook accepts an external cache object that can be
 * manually cleared to force recomputation. This is useful when you need fine-grained
 * control over when cached values are invalidated.
 *
 * @param compute - Function that computes the expensive value.
 * @param deps - Dependency array. Value is recomputed when deps change (shallow comparison).
 * @param cache - Optional external cache object. If not provided, uses internal cache.
 * @returns The memoized value.
 *
 * @example
 * function ExpensiveComponent({ data }) {
 *   const processed = useMemoizedValue(
 *     () => heavyProcessing(data),
 *     [data]
 *   );
 *
 *   // Or with manual cache control:
 *   const cacheRef = useRef({ current: undefined });
 *   const processed = useMemoizedValue(
 *     () => heavyProcessing(data),
 *     [data],
 *     cacheRef
 *   );
 *   // Force recompute: cacheRef.current = undefined;
 * }
 */
export function useMemoizedValue<T, D extends unknown[]>(
  compute: () => T,
  deps: D,
  cache?: { current: { value: T; deps: D } | undefined }
): T {
  // Use internal cache if no external cache provided
  const internalCacheRef = useRef<{ value: T; deps: D } | undefined>(undefined);
  const c = cache ?? internalCacheRef;

  if (c.current && shallowEqual(c.current.deps, deps)) {
    return c.current.value;
  }

  const value = compute();
  c.current = { value, deps };
  return value;
}
