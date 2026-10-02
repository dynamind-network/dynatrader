// Terminal utilities for responsive layouts and formatting

import type { TerminalSize } from '../hooks/useTerminalSize.js';

export type { TerminalSize };
export type TerminalSizeType = TerminalSize;

/**
 * Create a separator line for terminal display
 */
export function createSeparator(width: number, char: string = '-'): string {
  return char.repeat(Math.max(0, width - 4));
}

/**
 * Calculate optimal column widths for responsive tables
 */
export function getOptimalColumnWidths(
  terminalWidth: number,
  columns: Array<{ minWidth: number; maxWidth?: number; weight: number }>
): number[] {
  const availableWidth = terminalWidth - 4; // Account for padding
  const totalWeight = columns.reduce((sum, col) => sum + col.weight, 0);
  const minWidthTotal = columns.reduce((sum, col) => sum + col.minWidth, 0);

  if (availableWidth <= minWidthTotal) {
    return columns.map((col) => col.minWidth);
  }

  const extraWidth = availableWidth - minWidthTotal;

  return columns.map((col) => {
    const maxWidth = col.maxWidth ?? Math.floor(availableWidth / columns.length);
    const allocatedWidth = Math.floor((col.weight / totalWeight) * extraWidth);
    return Math.min(col.minWidth + allocatedWidth, maxWidth);
  });
}

/**
 * Get screen breakpoints for responsive layouts
 */
export function getScreenBreakpoints(width: number): {
  isCompact: boolean;
  isMedium: boolean;
  isWide: boolean;
  columnCount: number;
} {
  return {
    isCompact: width < 60,
    isMedium: width >= 60 && width < 100,
    isWide: width >= 100,
    columnCount: width < 60 ? 1 : width < 100 ? 2 : 3,
  };
}

/**
 * Truncate text to fit within a maximum width
 */
export function truncateText(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) {
    return text;
  }

  const ellipsis = '...';
  const availableWidth = maxWidth - ellipsis.length;

  if (availableWidth <= 0) {
    return ellipsis.slice(0, maxWidth);
  }

  return text.slice(0, availableWidth) + ellipsis;
}

// Re-export formatting functions from the canonical location
export { formatPrice, formatQuantity, formatPercent, formatPnL } from './number-formatting.js';

