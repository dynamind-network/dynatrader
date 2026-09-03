import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import type { Message } from '../types.js';
import { getChatViewportMetrics, clampScrollOffset } from '../../utils/chatViewport.js';

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
 * Pure auto-scroll logic - extracts testable behavior from the hook.
 *
 * Uses a percentage-based threshold: if the user is within 10% of the bottom
 * (or within 3 rows, whichever is larger), new messages auto-scroll to bottom.
 * This prevents the old behavior where scrolling up by even 1-2 rows would
 * disable auto-scroll, while still respecting user intent when they've clearly
 * scrolled up to read older content.
 */
export function getAutoScrollOffset(
  currentOffset: number,
  prevHistoryLength: number,
  currentHistoryLength: number,
  pageSize: number
): number | null {
  if (currentHistoryLength <= prevHistoryLength) return null;
  // Percentage-based threshold: 10% of viewport or 3 rows, whichever is larger
  const threshold = Math.max(3, Math.floor(pageSize * 0.1));
  if (currentOffset <= threshold) return 0;
  return null;
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
  const prevHistoryLengthRef = useRef(chatHistory.length);

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

  const { pageSize, maxScrollOffset } = metrics;

  const handlers = useMemo(() => {
    return createScrollHandlers(setScrollOffset, maxScrollOffset, pageSize);
  }, [maxScrollOffset, pageSize]);

  useEffect(() => {
    const newOffset = getAutoScrollOffset(
      scrollOffset,
      prevHistoryLengthRef.current,
      chatHistory.length,
      pageSize
    );
    if (newOffset !== null) {
      setScrollOffset(newOffset);
    }
    prevHistoryLengthRef.current = chatHistory.length;
  }, [chatHistory.length, scrollOffset, pageSize]);

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
    isAtBottom,
    isUserScrolledUp,
  };
}
