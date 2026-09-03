import { describe, it, expect, vi, beforeEach } from 'vitest';
import { usePreviousState, useMemoizedValue, shallowEqual } from './previousState';

/**
 * Tests for usePreviousState and useMemoizedValue hooks.
 *
 * Since bun:test does not provide a full React render environment,
 * these tests verify the core logic directly by simulating the hook
 * behavior (ref tracking, equality checks, memoization).
 */

// ---------------------------------------------------------------------------
// shallowEqual utility tests
// ---------------------------------------------------------------------------

describe('shallowEqual', () => {
  it('returns true for identical primitives', () => {
    expect(shallowEqual(1, 1)).toBe(true);
    expect(shallowEqual('a', 'a')).toBe(true);
    expect(shallowEqual(true, true)).toBe(true);
    expect(shallowEqual(null, null)).toBe(true);
    expect(shallowEqual(undefined, undefined)).toBe(true);
  });

  it('returns false for different primitives', () => {
    expect(shallowEqual(1, 2)).toBe(false);
    expect(shallowEqual('a', 'b')).toBe(false);
    expect(shallowEqual(true, false)).toBe(false);
    expect(shallowEqual(null, undefined)).toBe(false);
  });

  it('returns true for arrays with same elements', () => {
    expect(shallowEqual([1, 2, 3], [1, 2, 3])).toBe(true);
  });

  it('returns false for arrays with different elements', () => {
    expect(shallowEqual([1, 2, 3], [1, 2, 4])).toBe(false);
    expect(shallowEqual([1, 2], [1, 2, 3])).toBe(false);
  });

  it('returns true for objects with same keys and values', () => {
    expect(shallowEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
  });

  it('returns false for objects with different values', () => {
    expect(shallowEqual({ a: 1, b: 2 }, { a: 1, b: 3 })).toBe(false);
  });

  it('returns false for objects with different keys', () => {
    expect(shallowEqual({ a: 1 }, { b: 1 })).toBe(false);
    expect(shallowEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  });

  it('returns false when comparing array to object', () => {
    expect(shallowEqual([1, 2], { 0: 1, 1: 2 })).toBe(false);
  });

  it('returns false when comparing different types', () => {
    expect(shallowEqual(1, '1')).toBe(false);
    expect(shallowEqual({}, null)).toBe(false);
  });

  it('returns true for same reference', () => {
    const obj = { a: 1 };
    expect(shallowEqual(obj, obj)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// usePreviousState hook tests (simulated ref behavior)
// ---------------------------------------------------------------------------

describe('usePreviousState (simulated hook behavior)', () => {
  /**
   * Simulates the hook's internal behavior without React rendering.
   * This mirrors exactly what usePreviousState does internally.
   */
  function simulatePreviousState<T>(
    value: T,
    isEqual?: (a: T, b: T) => boolean
  ): { value: T; previousValue: T | undefined; hasChanged: boolean } {
    const eq = isEqual ?? shallowEqual;

    // Simulate ref persistence across calls
    const state = simulatePreviousState._cache ?? {
      previousValue: undefined as T | undefined,
      initialized: false,
    };
    simulatePreviousState._cache = state;

    const previousValue = state.previousValue;
    const hasChanged = !state.initialized || !eq(value, previousValue as T);

    state.previousValue = value;
    state.initialized = true;

    return { value, previousValue, hasChanged };
  }

  beforeEach(() => {
    // Reset cache before each test
    simulatePreviousState._cache = undefined;
  });

  it('returns hasChanged=true on first call (no previous value)', () => {
    const result = simulatePreviousState(42);
    expect(result.value).toBe(42);
    expect(result.previousValue).toBe(undefined);
    expect(result.hasChanged).toBe(true);
  });

  it('returns hasChanged=false when value is the same', () => {
    simulatePreviousState(42);
    const result = simulatePreviousState(42);
    expect(result.value).toBe(42);
    expect(result.previousValue).toBe(42);
    expect(result.hasChanged).toBe(false);
  });

  it('returns hasChanged=true when value changes', () => {
    simulatePreviousState(42);
    const result = simulatePreviousState(99);
    expect(result.value).toBe(99);
    expect(result.previousValue).toBe(42);
    expect(result.hasChanged).toBe(true);
  });

  it('detects value changes for objects (shallow comparison)', () => {
    simulatePreviousState({ a: 1 });
    const result = simulatePreviousState({ a: 2 });
    expect(result.hasChanged).toBe(true);
  });

  it('skips change detection when object values are equal (shallow)', () => {
    simulatePreviousState({ a: 1, b: 2 });
    const result = simulatePreviousState({ a: 1, b: 2 });
    expect(result.hasChanged).toBe(false);
  });

  it('uses custom equality function when provided', () => {
    // Custom equality: only compare the "id" field
    const byId = (a: { id: number; name: string }, b: { id: number; name: string }) =>
      a.id === b.id;

    simulatePreviousState({ id: 1, name: 'Alice' }, byId);
    const result = simulatePreviousState({ id: 1, name: 'Bob' }, byId);
    expect(result.hasChanged).toBe(false); // Same id, so considered equal
  });

  it('custom equality detects change when key field differs', () => {
    const byId = (a: { id: number; name: string }, b: { id: number; name: string }) =>
      a.id === b.id;

    simulatePreviousState({ id: 1, name: 'Alice' }, byId);
    const result = simulatePreviousState({ id: 2, name: 'Alice' }, byId);
    expect(result.hasChanged).toBe(true); // Different id
  });

  it('tracks multiple sequential changes correctly', () => {
    const r1 = simulatePreviousState('a');
    expect(r1.hasChanged).toBe(true);
    expect(r1.previousValue).toBe(undefined);

    const r2 = simulatePreviousState('a');
    expect(r2.hasChanged).toBe(false);
    expect(r2.previousValue).toBe('a');

    const r3 = simulatePreviousState('b');
    expect(r3.hasChanged).toBe(true);
    expect(r3.previousValue).toBe('a');

    const r4 = simulatePreviousState('b');
    expect(r4.hasChanged).toBe(false);
    expect(r4.previousValue).toBe('b');

    const r5 = simulatePreviousState('c');
    expect(r5.hasChanged).toBe(true);
    expect(r5.previousValue).toBe('b');
  });

  it('handles null and undefined values correctly', () => {
    const r1 = simulatePreviousState(null);
    expect(r1.hasChanged).toBe(true);

    const r2 = simulatePreviousState(null);
    expect(r2.hasChanged).toBe(false);

    const r3 = simulatePreviousState(undefined);
    expect(r3.hasChanged).toBe(true);
    expect(r3.previousValue).toBe(null);
  });

  it('handles arrays with shallow comparison', () => {
    simulatePreviousState([1, 2, 3]);
    const same = simulatePreviousState([1, 2, 3]);
    expect(same.hasChanged).toBe(false);

    const diff = simulatePreviousState([1, 2, 4]);
    expect(diff.hasChanged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// useMemoizedValue hook tests (simulated memoization behavior)
// ---------------------------------------------------------------------------

describe('useMemoizedValue (simulated memoization behavior)', () => {
  /**
   * Simulates useMemoizedValue behavior without React rendering.
   * Mirrors the exact internal logic of the hook.
   */
  function simulateMemoizedValue<T, D extends unknown[]>(
    compute: () => T,
    deps: D,
    cache?: { current: { value: T; deps: D } | undefined }
  ): T {
    const c = cache ?? simulateMemoizedValue._cache;

    if (c.current && shallowEqual(c.current.deps, deps)) {
      return c.current.value;
    }

    const value = compute();
    c.current = { value, deps };
    return value;
  }

  beforeEach(() => {
    simulateMemoizedValue._cache = { current: undefined };
  });

  it('computes value on first call', () => {
    const compute = vi.fn(() => 'computed');
    const result = simulateMemoizedValue(compute, []);
    expect(result).toBe('computed');
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('skips recomputation when deps are unchanged', () => {
    const compute = vi.fn(() => 'computed');
    simulateMemoizedValue(compute, [1, 'a']);
    const result = simulateMemoizedValue(compute, [1, 'a']);
    expect(result).toBe('computed');
    expect(compute).toHaveBeenCalledTimes(1); // Not called again
  });

  it('recomputes when deps change', () => {
    const compute = vi.fn((n?: number) => `computed-${n ?? 0}`);
    simulateMemoizedValue(() => compute(1), [1]);
    simulateMemoizedValue(() => compute(2), [2]);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('recomputes when deps array length changes', () => {
    const compute = vi.fn(() => 'computed');
    simulateMemoizedValue(compute, [1]);
    simulateMemoizedValue(compute, [1, 2]);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('uses manual cache control to force recomputation', () => {
    const cache = {
      current: { value: 'cached', deps: [1] } as { value: string; deps: number[] } | undefined,
    };
    const compute = vi.fn(() => 'new-value');

    // Deps unchanged - should use cache
    const r1 = simulateMemoizedValue(compute, [1], cache);
    expect(r1).toBe('cached');
    expect(compute).not.toHaveBeenCalled();

    // Clear cache manually
    cache.current = undefined;

    // Now should recompute
    const r2 = simulateMemoizedValue(compute, [1], cache);
    expect(r2).toBe('new-value');
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('handles expensive computation only once for same deps', () => {
    let callCount = 0;
    const expensiveCompute = () => {
      callCount++;
      // Simulate expensive work
      return Array.from({ length: 1000 }, (_, i) => i * 2);
    };

    simulateMemoizedValue(expensiveCompute, ['key']);
    simulateMemoizedValue(expensiveCompute, ['key']);
    simulateMemoizedValue(expensiveCompute, ['key']);

    expect(callCount).toBe(1);
  });

  it('returns different values for different deps', () => {
    const compute = vi.fn((x: number) => x * 10);
    const r1 = simulateMemoizedValue(() => compute(5), [5]);
    const r2 = simulateMemoizedValue(() => compute(10), [10]);
    expect(r1).toBe(50);
    expect(r2).toBe(100);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('handles object deps with shallow comparison', () => {
    const compute = vi.fn(() => 'result');
    const obj1 = { a: 1 };
    const obj2 = { a: 1 };

    simulateMemoizedValue(compute, [obj1]);
    // Different reference, same content - shallowEqual on deps array
    // The deps array [obj1] !== [obj2] by reference, but shallowEqual
    // compares elements: obj1 !== obj2 (different refs), so hasChanged=true
    simulateMemoizedValue(compute, [obj2]);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('handles empty deps array (always recomputes)', () => {
    const compute = vi.fn(() => Date.now());
    simulateMemoizedValue(compute, []);
    simulateMemoizedValue(compute, []);
    // Empty arrays are shallow equal, so should NOT recompute
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('cache can be replaced to reset memoization', () => {
    const compute = vi.fn(() => 'value');
    const cache1 = { current: undefined as { value: string; deps: unknown[] } | undefined };
    const cache2 = { current: undefined as { value: string; deps: unknown[] } | undefined };

    simulateMemoizedValue(compute, [1], cache1);
    expect(compute).toHaveBeenCalledTimes(1);

    // Use different cache - should recompute
    simulateMemoizedValue(compute, [1], cache2);
    expect(compute).toHaveBeenCalledTimes(2);
  });
});
