import { useState, useMemo, useCallback, useLayoutEffect, useRef } from 'react';
import type { Message } from '../types.js';
import { getChatViewportMetrics, clampScrollOffset, messagesToDisplayLines } from '../../utils/chatViewport.js';

export interface ChatViewportControls {
  scrollOffset: number;
  setScrollOffset: (offset: number | ((prev: number) => number)) => void;
  maxScrollOffset: number;
  pageSize: number;
  viewportWidth: number;
  pageUp: () => void;
  pageDown: () => void;
  lineUp: () => void;
  lineDown: () => void;
  jumpTop: () => void;
  jumpBottom: () => void;
  jumpToMessage: (messageIndex: number) => void;
  isAtBottom: boolean;
  isUserScrolledUp: boolean;
}

/**
 * Pure scroll handler factory - extracts testable logic from the hook.
 *
 * Scroll offset semantics:
 * - scrollOffset = 0: at the bottom (newest messages visible)
 * - scrollOffset = maxScrollOffset: at the top (oldest messages visible)
 *
 * User expectations:
 * - Arrow Up: scroll up to see older messages (increase offset)
 * - Arrow Down: scroll down to see newer messages (decrease offset)
 */
export function createScrollHandlers(
  setScrollOffset: (updater: number | ((prev: number) => number)) => void,
  maxScrollOffset: number,
  pageSize: number
) {
  return {
    pageUp: () => {
      // Scroll up to see older messages (increase offset)
      setScrollOffset((prev: number) => clampScrollOffset(prev + pageSize, maxScrollOffset));
    },
    pageDown: () => {
      // Scroll down to see newer messages (decrease offset)
      setScrollOffset((prev: number) => clampScrollOffset(prev - pageSize, maxScrollOffset));
    },
    lineUp: () => {
      // Scroll up to see older messages (increase offset)
      setScrollOffset((prev: number) => clampScrollOffset(prev + 1, maxScrollOffset));
    },
    lineDown: () => {
      // Scroll down to see newer messages (decrease offset)
      setScrollOffset((prev: number) => clampScrollOffset(prev - 1, maxScrollOffset));
    },
    jumpTop: () => {
      // Jump to top (oldest messages)
      setScrollOffset(maxScrollOffset);
    },
    jumpBottom: () => {
      // Jump to bottom (newest messages)
      setScrollOffset(0);
    },
  };
}

/**
 * Keep the same visible rows in place while content is appended below them.
 * Stay pinned to the bottom when the user is already there or close to it.
 */
export function getAdjustedScrollOffset(
  currentOffset: number,
  previousRows: number,
  currentRows: number,
  pageSize: number,
  maxScrollOffset: number
): number {
  const rowDelta = currentRows - previousRows;
  if (rowDelta === 0) return clampScrollOffset(currentOffset, maxScrollOffset);

  // Percentage-based threshold: 10% of viewport or 3 rows, whichever is larger.
  const threshold = Math.max(3, Math.floor(pageSize * 0.1));
  const nextOffset = rowDelta > 0 && currentOffset <= threshold
    ? 0
    : currentOffset + rowDelta;
  return clampScrollOffset(nextOffset, maxScrollOffset);
}

/**
 * Pure scroll state computation.
 */
export function computeScrollState(scrollOffset: number) {
  return {
    isAtBottom: scrollOffset === 0,
    isUserScrolledUp: scrollOffset > 0,
  };
}

export function useChatViewport(
  chatHistory: Message[],
  viewportWidth: number,
  mainAreaHeight: number,
  showThinking = true
): ChatViewportControls {
  const [scrollOffset, setScrollOffset] = useState(0);

  const metrics = useMemo(() => {
    return getChatViewportMetrics(
      chatHistory,
      viewportWidth,
      mainAreaHeight,
      0,
      scrollOffset,
      showThinking
    );
  }, [chatHistory, viewportWidth, mainAreaHeight, scrollOffset, showThinking]);

  const previousRowsRef = useRef(metrics.totalRows);

  const { pageSize, maxScrollOffset } = metrics;

  const handlers = useMemo(() => {
    return createScrollHandlers(setScrollOffset, maxScrollOffset, pageSize);
  }, [maxScrollOffset, pageSize]);

  const jumpToMessage = useCallback((messageIndex: number) => {
    const visible = chatHistory.filter((message: any) => !message.hidden);
    const lines = messagesToDisplayLines(visible as any, Math.max(20, viewportWidth - 1), showThinking);
    const lineIndex = lines.findIndex((line) => line.messageIndex === messageIndex);
    if (lineIndex >= 0) setScrollOffset(clampScrollOffset(lines.length - lineIndex - pageSize, maxScrollOffset));
  }, [chatHistory, viewportWidth, showThinking, pageSize, maxScrollOffset]);

  useLayoutEffect(() => {
    const nextOffset = getAdjustedScrollOffset(
      scrollOffset,
      previousRowsRef.current,
      metrics.totalRows,
      pageSize,
      maxScrollOffset
    );
    if (nextOffset !== scrollOffset) {
      setScrollOffset(nextOffset);
    }
    previousRowsRef.current = metrics.totalRows;
  }, [metrics.totalRows, maxScrollOffset, scrollOffset, pageSize]);

  const { isAtBottom, isUserScrolledUp } = computeScrollState(scrollOffset);

  return {
    scrollOffset,
    setScrollOffset,
    maxScrollOffset,
    pageSize,
    viewportWidth,
    pageUp: handlers.pageUp,
    pageDown: handlers.pageDown,
    lineUp: handlers.lineUp,
    lineDown: handlers.lineDown,
    jumpTop: handlers.jumpTop,
    jumpBottom: handlers.jumpBottom,
    jumpToMessage,
    isAtBottom,
    isUserScrolledUp,
  };
}

