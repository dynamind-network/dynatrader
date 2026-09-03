import React, { useMemo, useRef } from 'react';
import { Box, Text } from 'ink';
import type { Message } from '../types.js';

interface VirtualizedListProps {
  items: Message[];
  estimatedItemHeight: number;
  renderItem: (item: Message, index: number) => React.ReactNode;
  height: number;
  width: number;
  scrollOffset: number;
  onScrollOffsetChange?: (offset: number) => void;
  overscan?: number;
}

export function VirtualizedList({
  items,
  estimatedItemHeight,
  renderItem,
  height,
  width,
  scrollOffset,
  onScrollOffsetChange,
  overscan = 5,
}: VirtualizedListProps) {
  const totalHeight = items.length * estimatedItemHeight;
  const maxScrollOffset = Math.max(0, totalHeight - height);
  const clampedScrollOffset = Math.max(0, Math.min(scrollOffset, maxScrollOffset));

  const visibleRange = useMemo(() => {
    const startIndex = Math.max(
      0,
      Math.floor(clampedScrollOffset / estimatedItemHeight) - overscan
    );
    const endIndex = Math.min(
      items.length,
      Math.ceil((clampedScrollOffset + height) / estimatedItemHeight) + overscan
    );
    return { startIndex, endIndex };
  }, [clampedScrollOffset, height, estimatedItemHeight, overscan, items.length]);

  const visibleItems = useMemo(() => {
    return items.slice(visibleRange.startIndex, visibleRange.endIndex);
  }, [items, visibleRange]);

  const topSpacerHeight = visibleRange.startIndex * estimatedItemHeight;
  const bottomSpacerHeight = Math.max(0, totalHeight - visibleRange.endIndex * estimatedItemHeight);

  return (
    <Box flexDirection="column" height={height}>
      {topSpacerHeight > 0 && <Box height={topSpacerHeight} />}
      {visibleItems.map((item, idx) => renderItem(item, visibleRange.startIndex + idx))}
      {bottomSpacerHeight > 0 && <Box height={bottomSpacerHeight} />}
    </Box>
  );
}

export function useVirtualization(
  items: Message[],
  estimatedItemHeight: number,
  viewportHeight: number
) {
  const totalHeight = items.length * estimatedItemHeight;
  const maxScrollOffset = Math.max(0, totalHeight - viewportHeight);

  const getVisibleRange = (scrollOffset: number) => {
    const clampedOffset = Math.max(0, Math.min(scrollOffset, maxScrollOffset));
    const startIndex = Math.max(0, Math.floor(clampedOffset / estimatedItemHeight));
    const endIndex = Math.min(
      items.length,
      Math.ceil((clampedOffset + viewportHeight) / estimatedItemHeight)
    );
    return { startIndex, endIndex, totalHeight, maxScrollOffset };
  };

  return { totalHeight, maxScrollOffset, getVisibleRange };
}

/**
 * Incremental key array hook for virtualized lists.
 *
 * Instead of rebuilding the full key array on every render, this hook
 * appends only new keys when messages are added. It detects removals
 * or reorders by checking if the first item changed or length decreased,
 * and rebuilds the full array in those cases.
 *
 * This avoids O(n) allocation churn during streaming where messages
 * are appended one at a time.
 *
 * @param items - The array of items to generate keys for
 * @param itemKey - Function to extract a unique key from an item
 * @returns The current key array (maintained in a ref for stability)
 */
export function useIncrementalKeyArray<T>(
  items: readonly T[],
  itemKey: (item: T) => string
): string[] {
  const keysRef = useRef<string[]>([]);
  const prevItemsRef = useRef(items);
  const prevItemKeyRef = useRef(itemKey);

  // Detect if we need a full rebuild:
  // 1. itemKey function changed
  // 2. Items were removed (length decreased)
  // 3. First item changed (indicates reorder or replacement)
  if (
    prevItemKeyRef.current !== itemKey ||
    items.length < keysRef.current.length ||
    items[0] !== prevItemsRef.current[0]
  ) {
    keysRef.current = items.map((item) => itemKey(item));
  } else {
    // Incremental append: only add keys for new items
    for (let i = keysRef.current.length; i < items.length; i++) {
      keysRef.current.push(itemKey(items[i]!));
    }
  }

  prevItemsRef.current = items;
  prevItemKeyRef.current = itemKey;

  return keysRef.current;
}
