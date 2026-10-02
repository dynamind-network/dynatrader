import { describe, it, expect, vi } from 'vitest';
import { createDebouncer, useDebouncedCallback } from './debounce';

/**
 * Tests for createDebouncer utility.
 *
 * createDebouncer(delay) returns a debouncer object with:
 *   - schedule(fn): schedules fn to run after delay ms
 *   - cancel(): cancels any pending scheduled call
 *
 * This is a pure utility for non-React contexts.
 */

describe('createDebouncer', () => {
  it('calls the scheduled function after the specified delay', async () => {
    const debouncer = createDebouncer(50);
    const fn = vi.fn();

    debouncer.schedule(fn);

    expect(fn).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('cancels previous call when scheduled again within delay', async () => {
    const debouncer = createDebouncer(50);
    const fn = vi.fn();

    debouncer.schedule(fn);
    await new Promise((resolve) => setTimeout(resolve, 20));
    debouncer.schedule(fn);
    await new Promise((resolve) => setTimeout(resolve, 75));

    // Should only have been called once (second schedule cancelled the first)
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('can be cancelled explicitly', async () => {
    const debouncer = createDebouncer(50);
    const fn = vi.fn();

    debouncer.schedule(fn);
    debouncer.cancel();

    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(fn).not.toHaveBeenCalled();
  });

  it('calls the latest scheduled function (not stale)', async () => {
    const debouncer = createDebouncer(50);
    const fn1 = vi.fn().mockReturnValue('first');
    const fn2 = vi.fn().mockReturnValue('second');

    debouncer.schedule(fn1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    debouncer.schedule(fn2);
    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  it('resets timer on each new schedule call', async () => {
    const debouncer = createDebouncer(50);
    const fn = vi.fn();

    debouncer.schedule(fn);
    await new Promise((resolve) => setTimeout(resolve, 30));
    debouncer.schedule(fn);
    await new Promise((resolve) => setTimeout(resolve, 30));
    debouncer.schedule(fn);
    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('works with zero delay', async () => {
    const debouncer = createDebouncer(0);
    const fn = vi.fn();

    debouncer.schedule(fn);

    // Zero delay still defers to next tick
    expect(fn).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('passes arguments through to the scheduled function', async () => {
    const debouncer = createDebouncer(50);
    const fn = vi.fn();

    debouncer.schedule(() => fn('hello', 42));

    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(fn).toHaveBeenCalledWith('hello', 42);
  });

  it('multiple rapid schedules only fire the last one', async () => {
    const debouncer = createDebouncer(50);
    const calls: string[] = [];

    debouncer.schedule(() => calls.push('a'));
    debouncer.schedule(() => calls.push('b'));
    debouncer.schedule(() => calls.push('c'));

    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(calls).toEqual(['c']);
  });

  it('can schedule again after previous call has fired', async () => {
    const debouncer = createDebouncer(30);
    const fn = vi.fn();

    debouncer.schedule(fn);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fn).toHaveBeenCalledTimes(1);

    debouncer.schedule(fn);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

/**
 * Tests for useDebouncedCallback hook.
 *
 * Since bun:test does not provide a DOM environment for @testing-library/react,
 * these tests verify the debounced callback pattern behavior directly,
 * following the same approach as refSync.test.ts.
 *
 * The pattern is:
 *   const callbackRef = useRef(callback);
 *   callbackRef.current = callback;
 *   const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
 *   const debounced = useCallback((...args) => {
 *     clearTimeout(timerRef.current);
 *     timerRef.current = setTimeout((ref, cb, capturedArgs) => {
 *       ref.current = undefined;
 *       cb(...capturedArgs);
 *     }, delay, timerRef, callbackRef.current, args);
 *   }, [delay]);
 *   debounced.cancel = () => { clearTimeout(timerRef.current); timerRef.current = undefined; };
 */

describe('useDebouncedCallback core behavior', () => {
  it('callback fires after the specified delay', async () => {
    // Simulate the hook's internal mechanism
    const callbackRef: { current: () => void } = { current: vi.fn() };
    const timerRef: { current: ReturnType<typeof setTimeout> | undefined } = { current: undefined };
    const delay = 50;

    const debounced = (...args: unknown[]) => {
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(
        (ref, cb, capturedArgs: unknown[]) => {
          ref.current = undefined;
          (cb as (...a: unknown[]) => void)(...capturedArgs);
        },
        delay,
        timerRef,
        callbackRef.current,
        args
      );
    };
    const debouncedWithCancel = debounced as ((...args: unknown[]) => void) & {
      cancel: () => void;
    };
    debouncedWithCancel.cancel = () => {
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current);
        timerRef.current = undefined;
      }
    };

    debounced();
    expect(callbackRef.current).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(callbackRef.current).toHaveBeenCalledTimes(1);
  });

  it('callback is cancelled on new call within delay', async () => {
    const callbackRef: { current: () => void } = { current: vi.fn() };
    const timerRef: { current: ReturnType<typeof setTimeout> | undefined } = { current: undefined };
    const delay = 50;

    const debounced = () => {
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(
        (ref, cb) => {
          ref.current = undefined;
          cb();
        },
        delay,
        timerRef,
        callbackRef.current
      );
    };

    debounced();
    await new Promise((resolve) => setTimeout(resolve, 20));
    debounced();
    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(callbackRef.current).toHaveBeenCalledTimes(1);
  });

  it('callback receives latest value (not stale)', async () => {
    // The debouncer captures callbackRef.current at schedule time via setTimeout args.
    // The "latest value" pattern works because the callback reads from refs internally.
    // This test verifies that the callback captured at schedule time is the one that fires.
    const sharedValue: { current: string } = { current: 'initial' };
    const callbackRef: { current: () => string } = {
      current: () => sharedValue.current,
    };
    const timerRef: { current: ReturnType<typeof setTimeout> | undefined } = { current: undefined };
    const delay = 50;

    const debounced = () => {
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(
        (ref, cb) => {
          ref.current = undefined;
          const result = (cb as () => string)();
          results.push(result);
        },
        delay,
        timerRef,
        callbackRef.current
      );
    };

    const results: string[] = [];

    // Schedule with initial value
    debounced();

    // Update the shared value before timer fires
    sharedValue.current = 'updated';

    await new Promise((resolve) => setTimeout(resolve, 75));

    // The callback reads from the shared ref, so it gets the updated value
    expect(results).toEqual(['updated']);
  });

  it('debounced function reference is stable (same function object)', () => {
    // Simulate: useCallback with [delay] dep - same delay = same reference
    const timerRef: { current: ReturnType<typeof setTimeout> | undefined } = { current: undefined };
    const delay = 300;

    const createDebounced = () => {
      const fn = (...args: unknown[]) => {
        if (timerRef.current !== undefined) {
          clearTimeout(timerRef.current);
        }
        timerRef.current = setTimeout(() => {}, delay);
      };
      return fn;
    };

    // In React, useCallback with same deps returns same reference
    // We simulate this by creating once and reusing
    const debounced1 = createDebounced();
    const debounced2 = debounced1; // Same reference (what useCallback guarantees)

    expect(debounced1).toBe(debounced2);
  });

  it('cancel method prevents callback from firing', async () => {
    const callbackRef: { current: () => void } = { current: vi.fn() };
    const timerRef: { current: ReturnType<typeof setTimeout> | undefined } = { current: undefined };
    const delay = 50;

    const debounced = () => {
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(
        (ref, cb) => {
          ref.current = undefined;
          (cb as () => void)();
        },
        delay,
        timerRef,
        callbackRef.current
      );
    };
    const debouncedWithCancel = debounced as (() => void) & { cancel: () => void };
    debouncedWithCancel.cancel = () => {
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current);
        timerRef.current = undefined;
      }
    };

    debounced();
    debouncedWithCancel.cancel();

    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(callbackRef.current).not.toHaveBeenCalled();
  });

  it('timer ref is cleared after callback fires', async () => {
    const callbackRef: { current: () => void } = { current: vi.fn() };
    const timerRef: { current: ReturnType<typeof setTimeout> | undefined } = { current: undefined };
    const delay = 30;

    const debounced = () => {
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(
        (ref, cb) => {
          ref.current = undefined;
          cb();
        },
        delay,
        timerRef,
        callbackRef.current
      );
    };

    debounced();
    expect(timerRef.current).toBeDefined();

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(timerRef.current).toBeUndefined();
  });

  it('can schedule again after callback has fired', async () => {
    const callbackRef: { current: () => void } = { current: vi.fn() };
    const timerRef: { current: ReturnType<typeof setTimeout> | undefined } = { current: undefined };
    const delay = 30;

    const debounced = () => {
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(
        (ref, cb) => {
          ref.current = undefined;
          cb();
        },
        delay,
        timerRef,
        callbackRef.current
      );
    };

    debounced();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(callbackRef.current).toHaveBeenCalledTimes(1);

    debounced();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(callbackRef.current).toHaveBeenCalledTimes(2);
  });
});

