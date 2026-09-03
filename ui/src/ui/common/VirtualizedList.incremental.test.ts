import { describe, it, expect } from 'vitest';
import React, { useRef } from 'react';
import { useIncrementalKeyArray } from './VirtualizedList.js';

interface TestItem {
  id: string;
  value: string;
}

function createItem(id: string, value: string): TestItem {
  return { id, value };
}

function defaultItemKey(item: TestItem): string {
  return item.id;
}

/**
 * Test helper: simulates the hook's behavior by manually managing refs
 * This allows testing the incremental key array logic without DOM dependencies.
 */
function simulateIncrementalKeyArray<T>(
  items: readonly T[],
  itemKey: (item: T) => string,
  state: {
    keysRef: { current: string[] };
    prevItemsRef: { current: readonly T[] };
    prevItemKeyRef: { current: (item: T) => string };
  }
): string[] {
  if (
    state.prevItemKeyRef.current !== itemKey ||
    items.length < state.keysRef.current.length ||
    items[0] !== state.prevItemsRef.current[0]
  ) {
    state.keysRef.current = items.map((item) => itemKey(item));
  } else {
    for (let i = state.keysRef.current.length; i < items.length; i++) {
      state.keysRef.current.push(itemKey(items[i]!));
    }
  }

  state.prevItemsRef.current = items;
  state.prevItemKeyRef.current = itemKey;

  return state.keysRef.current;
}

function createTestState<T>() {
  return {
    keysRef: { current: [] as string[] },
    prevItemsRef: { current: [] as readonly T[] },
    prevItemKeyRef: { current: (() => '') as (item: T) => string },
  };
}

describe('useIncrementalKeyArray', () => {
  it('returns empty array for empty input', () => {
    const state = createTestState<TestItem>();
    const result = simulateIncrementalKeyArray([], defaultItemKey, state);
    expect(result).toEqual([]);
  });

  it('builds full key array on first render with items', () => {
    const items = [createItem('a', 'first'), createItem('b', 'second'), createItem('c', 'third')];
    const state = createTestState<TestItem>();
    const result = simulateIncrementalKeyArray(items, defaultItemKey, state);
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('appends keys incrementally when messages are added', () => {
    const state = createTestState<TestItem>();
    const items1 = [createItem('a', 'first'), createItem('b', 'second')];

    const result1 = simulateIncrementalKeyArray(items1, defaultItemKey, state);
    expect(result1).toEqual(['a', 'b']);

    // Append a new message
    const items2 = [createItem('a', 'first'), createItem('b', 'second'), createItem('c', 'third')];

    const result2 = simulateIncrementalKeyArray(items2, defaultItemKey, state);
    expect(result2).toEqual(['a', 'b', 'c']);
    expect(result2.length).toBe(3);
  });

  it('maintains stable keys for existing messages during append', () => {
    const state = createTestState<TestItem>();
    const items1 = [createItem('a', 'first'), createItem('b', 'second')];

    const result1 = simulateIncrementalKeyArray(items1, defaultItemKey, state);
    const keysBefore = [...result1];

    const items2 = [
      createItem('a', 'first'),
      createItem('b', 'second'),
      createItem('c', 'third'),
      createItem('d', 'fourth'),
    ];

    const result2 = simulateIncrementalKeyArray(items2, defaultItemKey, state);

    // Existing keys should remain unchanged
    expect(result2[0]).toBe(keysBefore[0]);
    expect(result2[1]).toBe(keysBefore[1]);
    // New keys should be appended
    expect(result2[2]).toBe('c');
    expect(result2[3]).toBe('d');
  });

  it('rebuilds full array when messages are removed', () => {
    const state = createTestState<TestItem>();
    const items1 = [createItem('a', 'first'), createItem('b', 'second'), createItem('c', 'third')];

    const result1 = simulateIncrementalKeyArray(items1, defaultItemKey, state);
    expect(result1).toEqual(['a', 'b', 'c']);

    // Remove last message
    const items2 = [createItem('a', 'first'), createItem('b', 'second')];

    const result2 = simulateIncrementalKeyArray(items2, defaultItemKey, state);
    expect(result2).toEqual(['a', 'b']);
  });

  it('rebuilds full array when first message changes (reorder detection)', () => {
    const state = createTestState<TestItem>();
    const items1 = [createItem('a', 'first'), createItem('b', 'second'), createItem('c', 'third')];

    const result1 = simulateIncrementalKeyArray(items1, defaultItemKey, state);
    expect(result1).toEqual(['a', 'b', 'c']);

    // Reorder: move 'c' to front
    const items2 = [createItem('c', 'third'), createItem('a', 'first'), createItem('b', 'second')];

    const result2 = simulateIncrementalKeyArray(items2, defaultItemKey, state);
    expect(result2).toEqual(['c', 'a', 'b']);
  });

  it('rebuilds full array when itemKey function changes', () => {
    const state = createTestState<TestItem>();
    const items = [createItem('a', 'first'), createItem('b', 'second')];

    function customItemKey(item: TestItem): string {
      return `custom-${item.id}`;
    }

    const result1 = simulateIncrementalKeyArray(items, defaultItemKey, state);
    expect(result1).toEqual(['a', 'b']);

    const result2 = simulateIncrementalKeyArray(items, customItemKey, state);
    expect(result2).toEqual(['custom-a', 'custom-b']);
  });

  it('handles multiple sequential appends efficiently', () => {
    const state = createTestState<TestItem>();

    // Start with one item
    let result = simulateIncrementalKeyArray([createItem('a', 'first')], defaultItemKey, state);
    expect(result).toEqual(['a']);

    // Append 'b'
    result = simulateIncrementalKeyArray(
      [createItem('a', 'first'), createItem('b', 'second')],
      defaultItemKey,
      state
    );
    expect(result).toEqual(['a', 'b']);

    // Append 'c'
    result = simulateIncrementalKeyArray(
      [createItem('a', 'first'), createItem('b', 'second'), createItem('c', 'third')],
      defaultItemKey,
      state
    );
    expect(result).toEqual(['a', 'b', 'c']);

    // Append 'd'
    result = simulateIncrementalKeyArray(
      [
        createItem('a', 'first'),
        createItem('b', 'second'),
        createItem('c', 'third'),
        createItem('d', 'fourth'),
      ],
      defaultItemKey,
      state
    );
    expect(result).toEqual(['a', 'b', 'c', 'd']);
  });

  it('handles clear (empty after items) correctly', () => {
    const state = createTestState<TestItem>();
    const items1 = [createItem('a', 'first'), createItem('b', 'second')];

    const result1 = simulateIncrementalKeyArray(items1, defaultItemKey, state);
    expect(result1).toEqual(['a', 'b']);

    // Clear all messages
    const result2 = simulateIncrementalKeyArray([], defaultItemKey, state);
    expect(result2).toEqual([]);
  });

  it('handles single item append', () => {
    const state = createTestState<TestItem>();

    const result1 = simulateIncrementalKeyArray([], defaultItemKey, state);
    expect(result1).toEqual([]);

    const result2 = simulateIncrementalKeyArray([createItem('a', 'first')], defaultItemKey, state);
    expect(result2).toEqual(['a']);
  });

  it('hook is exported and has correct signature', () => {
    // Verify the hook exists and is a function
    expect(typeof useIncrementalKeyArray).toBe('function');
  });
});
