import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useStdout } from 'ink';

/**
 * Represents a DOM element with yoga layout node (ink's internal structure).
 */
export type DOMElement = {
  yogaNode: {
    getComputedHeight: () => number;
    getComputedTop: () => number;
  } | null;
  parentNode: DOMElement | null;
  scrollTop?: number;
};

/**
 * Result of the useTerminalViewport hook.
 */
export type ViewportResult = {
  /** Whether the element is currently within the terminal viewport */
  isVisible: boolean;
  /** Number of rows the element occupies (0 if not attached) */
  visibleRows: number;
  /** Callback ref to attach to the element to track */
  setRef: (element: DOMElement | null) => void;
};

/**
 * Pure function to compute viewport visibility for a DOM element.
 *
 * Walks the DOM ancestor chain to compute absolute Y position, then compares
 * against terminal rows to determine visibility.
 *
 * @param element - The DOM element to check (must have a yogaNode)
 * @param terminalRows - Number of rows in the terminal
 * @returns Object with isVisible and visibleRows
 */
export function computeViewportVisibility(
  element: DOMElement | null,
  terminalRows: number
): { isVisible: boolean; visibleRows: number } {
  if (!element?.yogaNode) {
    return { isVisible: true, visibleRows: 0 };
  }

  const height = element.yogaNode.getComputedHeight();

  // Walk the DOM parent chain (not yoga.getParent()) so we can detect
  // scroll containers and subtract their scrollTop. Yoga computes layout
  // positions without scroll offset — scrollTop is applied at render time.
  let absoluteTop = element.yogaNode.getComputedTop();
  let parent: DOMElement | null = element.parentNode;
  let root = element.yogaNode;
  while (parent) {
    if (parent.yogaNode) {
      absoluteTop += parent.yogaNode.getComputedTop();
      root = parent.yogaNode;
    }
    // scrollTop is only ever set on scroll containers.
    // Non-scroll nodes have undefined scrollTop → falsy fast-path.
    if (parent.scrollTop) absoluteTop -= parent.scrollTop;
    parent = parent.parentNode;
  }

  // Only the root's height matters
  const screenHeight = root.getComputedHeight();

  const bottom = absoluteTop + height;
  // When content overflows the viewport (screenHeight > rows), the
  // cursor-restore at frame end scrolls one extra row into scrollback.
  // We must match, otherwise an element at the boundary is considered
  // "visible" here but its row is treated as scrollback by log-update.
  const cursorRestoreScroll = screenHeight > terminalRows ? 1 : 0;
  const viewportY = Math.max(0, screenHeight - terminalRows) + cursorRestoreScroll;
  const viewportBottom = viewportY + terminalRows;
  const visible = bottom > viewportY && absoluteTop < viewportBottom;

  return { isVisible: visible, visibleRows: height };
}

/**
 * Hook to detect if a component is within the terminal viewport.
 *
 * Walks the DOM ancestor chain to compute absolute Y position, then compares
 * against terminal rows to determine visibility. Used by useAnimationFrame to
 * pause offscreen animations.
 *
 * Visibility changes do NOT trigger re-renders on their own — callers that
 * re-render for other reasons (e.g. animation ticks) will pick up the latest
 * value naturally. This avoids infinite update loops.
 *
 * @example
 * const { isVisible, visibleRows, setRef } = useTerminalViewport();
 * return <Box ref={setRef}><Animation enabled={isVisible}>...</Animation></Box>;
 */
export function useTerminalViewport(): ViewportResult {
  const { stdout } = useStdout();
  const elementRef = useRef<DOMElement | null>(null);
  const entryRef = useRef({ isVisible: true, visibleRows: 0 });
  const [, forceUpdate] = useState(0);

  const setRef = useCallback((el: DOMElement | null) => {
    elementRef.current = el;
  }, []);

  // Runs on every render because yoga layout values can change
  // without React being aware. Only updates the ref — no setState
  // to avoid cascading re-renders during the commit phase.
  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element?.yogaNode || !stdout) {
      return;
    }

    const result = computeViewportVisibility(element, stdout.rows);

    if (
      result.isVisible !== entryRef.current.isVisible ||
      result.visibleRows !== entryRef.current.visibleRows
    ) {
      entryRef.current = result;
      forceUpdate((n) => n + 1);
    }
  });

  return {
    isVisible: entryRef.current.isVisible,
    visibleRows: entryRef.current.visibleRows,
    setRef,
  };
}
