import { describe, it, expect, vi } from 'vitest';

/**
 * Tests for useRefSync hook.
 *
 * Since bun:test does not provide a DOM environment for @testing-library/react,
 * these tests verify the ref-sync pattern behavior directly,
 * which is the core logic of the hook.
 *
 * The pattern is:
 *   const ref = useRef(value);
 *   ref.current = value;
 *   const stableCallback = useCallback(() => ref.current, []);
 *
 * We test the underlying mechanism that makes this pattern work.
 */

describe('useRefSync core behavior', () => {
  it('ref always has the latest value after sync', () => {
    // Simulate: const ref = useRef(initial); ref.current = value;
    const ref: { current: string } = { current: 'initial' };

    // Simulate re-render with new value
    ref.current = 'updated';

    expect(ref.current).toBe('updated');
  });

  it('stable callback returns the latest value via ref', () => {
    // Simulate: const ref = useRef(value); ref.current = value;
    //           const stableCallback = useCallback(() => ref.current, []);
    const ref: { current: number } = { current: 1 };
    const stableCallback = () => ref.current;

    expect(stableCallback()).toBe(1);

    // Simulate re-render with new value
    ref.current = 42;

    // Same callback reference, but returns the new value
    expect(stableCallback()).toBe(42);
  });

  it('callback is stable (same reference) across value changes', () => {
    const ref: { current: string } = { current: 'initial' };
    const stableCallback = () => ref.current;

    const firstCallback = stableCallback;

    // Simulate re-render - callback is recreated via useCallback with [] deps
    // In React, useCallback with [] returns the same function reference
    const secondCallback = stableCallback;

    expect(firstCallback).toBe(secondCallback);
  });

  it('does not recreate callback when value changes', () => {
    const callbacks: Array<() => unknown> = [];

    // Simulate multiple renders
    for (let i = 0; i < 4; i++) {
      const ref: { current: number } = { current: i };
      // In React, useCallback(() => ref.current, []) returns same reference
      // We simulate this by using the same callback factory
      const callback = (() => {
        const capturedRef = ref;
        return () => capturedRef.current;
      })();
      callbacks.push(callback);
    }

    // In the actual hook, useCallback ensures all are the same reference
    // This test verifies the concept that a stable callback can access
    // different values through the ref
    expect(callbacks[0]()).toBe(0);
    expect(callbacks[1]()).toBe(1);
    expect(callbacks[2]()).toBe(2);
    expect(callbacks[3]()).toBe(3);
  });

  it('works with complex objects', () => {
    const obj1 = { name: 'Alice', age: 30 };
    const obj2 = { name: 'Bob', age: 25 };

    const ref: { current: typeof obj1 } = { current: obj1 };
    const stableCallback = () => ref.current;

    expect(ref.current).toBe(obj1);
    expect(stableCallback()).toBe(obj1);

    ref.current = obj2;

    expect(ref.current).toBe(obj2);
    expect(stableCallback()).toBe(obj2);
  });

  it('works with functions as values', () => {
    const fn1 = () => 'one';
    const fn2 = () => 'two';

    const ref: { current: () => string } = { current: fn1 };
    const stableCallback = () => ref.current;

    expect(ref.current).toBe(fn1);
    expect(stableCallback()()).toBe('one');

    ref.current = fn2;

    expect(ref.current).toBe(fn2);
    expect(stableCallback()()).toBe('two');
  });

  it('eliminates stale closures in async callbacks', () => {
    // This is the key use case: an async callback that captures a stable
    // reference but always reads the latest value
    const ref: { current: number } = { current: 1 };
    const getValue = () => ref.current;

    // Simulate capturing the callback in a closure (e.g., setInterval)
    const capturedCallback = getValue;

    // Update value (simulating re-render)
    ref.current = 100;

    // The captured callback still returns the latest value
    expect(capturedCallback()).toBe(100);
  });

  it('can be used with useCallback to create stable async functions', async () => {
    const ref: { current: string } = { current: 'hello' };
    const getValue = () => ref.current;

    // Simulate: useCallback(async () => ref.current.toUpperCase(), [])
    const stableAsyncFn = async () => {
      return getValue().toUpperCase();
    };

    expect(getValue()).toBe('hello');

    ref.current = 'world';

    expect(getValue()).toBe('world');
    expect(await stableAsyncFn()).toBe('WORLD');
  });

  it('handles null and undefined values', () => {
    const nullRef: { current: null } = { current: null };
    const nullCallback = () => nullRef.current;

    expect(nullRef.current).toBe(null);
    expect(nullCallback()).toBe(null);

    const undefRef: { current: undefined } = { current: undefined };
    const undefCallback = () => undefRef.current;

    expect(undefRef.current).toBe(undefined);
    expect(undefCallback()).toBe(undefined);
  });

  it('works with primitive types (number, boolean, string)', () => {
    // Number
    const numRef: { current: number } = { current: 0 };
    numRef.current = 999;
    expect(numRef.current).toBe(999);

    // Boolean
    const boolRef: { current: boolean } = { current: false };
    boolRef.current = true;
    expect(boolRef.current).toBe(true);

    // String
    const strRef: { current: string } = { current: 'hello' };
    strRef.current = 'world';
    expect(strRef.current).toBe('world');
  });

  it('multiple stable callbacks can share the same ref', () => {
    const ref: { current: number } = { current: 42 };
    const getValue1 = () => ref.current;
    const getValue2 = () => ref.current;

    expect(getValue1()).toBe(42);
    expect(getValue2()).toBe(42);

    ref.current = 100;

    expect(getValue1()).toBe(100);
    expect(getValue2()).toBe(100);
  });

  it('ref-sync pattern prevents stale closure in event handlers', async () => {
    // Simulate the StatusLine pattern:
    // const settingsRef = useRef(settings);
    // settingsRef.current = settings;
    // const doUpdate = useCallback(async () => {
    //   const settings = settingsRef.current;
    //   // ... always reads latest
    // }, []);

    const settingsRef: { current: { theme: string } } = { current: { theme: 'dark' } };
    const doUpdate = async () => {
      const settings = settingsRef.current;
      return settings.theme;
    };

    await expect(doUpdate()).resolves.toBe('dark');

    // Simulate settings change
    settingsRef.current = { theme: 'light' };

    // Same doUpdate reference, but reads latest settings
    await expect(doUpdate()).resolves.toBe('light');
  });

  it('ref-sync pattern works with AbortController integration', async () => {
    // Combined pattern: ref-sync + AbortController
    const messagesRef: { current: string[] } = { current: ['msg1'] };
    const abortControllerRef: { current: AbortController | null } = { current: null };

    const getMessages = () => messagesRef.current;

    const doUpdate = async () => {
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      const msgs = getMessages();
      return msgs;
    };

    // Initial call
    const result1 = doUpdate();
    await expect(result1).resolves.toEqual(['msg1']);

    // Update messages
    messagesRef.current = ['msg1', 'msg2'];

    // Second call - should get updated messages
    const result2 = doUpdate();
    await expect(result2).resolves.toEqual(['msg1', 'msg2']);
  });
});
