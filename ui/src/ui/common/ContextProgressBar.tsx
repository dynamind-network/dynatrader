import React from 'react';
import { Text } from 'ink';
import { COLORS, GLYPHS } from '../design/tokens.js';
import type { ContextUsage } from '../../services/ContextUsageService.js';

interface ContextProgressBarProps {
  usage: ContextUsage | null;
  width?: number;
  showPercentage?: boolean;
  showTokenCount?: boolean;
}

/**
 * Unicode block characters for sub-character-precision progress bars.
 * 9 levels: empty space through full block.
 */
export const BLOCKS = [
  ' ',
  '\u258F',
  '\u258E',
  '\u258D',
  '\u258C',
  '\u258B',
  '\u258A',
  '\u2589',
  '\u2588',
];

/**
 * Build a progress bar string using Unicode block characters.
 * Each character position can show partial fill (9 levels vs 1).
 *
 * @param percent - Progress percentage (0-100, clamped)
 * @param width - Number of character positions
 * @returns String of exactly `width` characters
 */
export function buildProgressBarString(percent: number, width: number): string {
  return buildProgressBarStringWithMinimum(percent, width, false);
}

export function buildProgressBarStringWithMinimum(
  percent: number,
  width: number,
  ensureVisible: boolean
): string {
  const clamped = Math.min(100, Math.max(0, percent));
  if (ensureVisible && clamped === 0) {
    return BLOCKS[1] + BLOCKS[0].repeat(Math.max(0, width - 1));
  }
  const ratio = clamped / 100;
  const whole = Math.floor(ratio * width);
  const segments: string[] = [BLOCKS[BLOCKS.length - 1].repeat(whole)];

  if (whole < width) {
    const remainder = ratio * width - whole;
    const middle = Math.floor(remainder * BLOCKS.length);
    segments.push(BLOCKS[middle]);

    const empty = width - whole - 1;
    if (empty > 0) {
      segments.push(BLOCKS[0].repeat(empty));
    }
  }

  return segments.join('');
}

export function getBarColor(level: ContextUsage['level']): string {
  switch (level) {
    case 'ok':
      return COLORS.success;
    case 'warning':
      return COLORS.warning;
    case 'error':
      return COLORS.error;
    case 'critical':
      return COLORS.error;
    default:
      return COLORS.success;
  }
}

/**
 * Format a token count as a human-readable string (e.g. 45000 -> "45K").
 */
function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) {
    const k = tokens / 1000;
    return k % 1 === 0 ? `${k}K` : `${k.toFixed(1)}K`;
  }
  return String(tokens);
}

/**
 * Get the bracket and fill color based on usage percentage.
 * 0-50%: green (success), 51-80%: yellow (warning), 81-100%: red (error).
 */
function getBracketColor(percent: number): string {
  if (percent <= 50) return COLORS.success;
  if (percent <= 80) return COLORS.warning;
  return COLORS.error;
}

/**
 * Custom props equality function for React.memo on ContextProgressBar.
 * Prevents re-renders when usage reference, width, showPercentage, or showTokenCount haven't changed.
 * Uses reference equality for usage object (caller should memoize usage upstream).
 */
export function contextProgressBarPropsEqual(
  prev: ContextProgressBarProps,
  next: ContextProgressBarProps
): boolean {
  return (
    prev.usage === next.usage &&
    prev.width === next.width &&
    prev.showPercentage === next.showPercentage &&
    prev.showTokenCount === next.showTokenCount
  );
}

function ContextProgressBarInner({
  usage,
  width = 20,
  showPercentage = true,
  showTokenCount = false,
}: ContextProgressBarProps) {
  // No blink interval — static display to prevent flickering

  if (!usage) return null;

  const bar = buildProgressBarStringWithMinimum(usage.percent, width, usage.used > 0);
  const barColor = getBarColor(usage.level);
  const bracketColor = getBracketColor(usage.percent);
  const percentLabel = Math.round(usage.percent);

  const isCritical = usage.percent > 80;
  const isInverse = usage.percent > 90;

  // For inverse styling: swap foreground/background on the bar itself
  const effectiveBarColor = isInverse ? COLORS.muted : barColor;
  const effectiveBracketColor = isInverse ? COLORS.muted : bracketColor;

  // Token count text: "45K / 128K"
  const tokenCountText = showTokenCount
    ? `${formatTokenCount(usage.used)} / ${formatTokenCount(usage.total)}`
    : null;

  // Always show label (no blinking to prevent flicker)
  const showLabel = true;

  return (
    <Text>
      <Text color={effectiveBracketColor}>[</Text>
      <Text color={effectiveBarColor}>{bar}</Text>
      <Text color={effectiveBracketColor}>]</Text>
      {showPercentage && showLabel && (
        <Text color={isInverse ? COLORS.primary : barColor}> {percentLabel}%</Text>
      )}
      {tokenCountText && showLabel && (
        <Text color={COLORS.muted}>
          {' '}
          {GLYPHS.separator} {tokenCountText}
        </Text>
      )}
    </Text>
  );
}

export const ContextProgressBar = React.memo(ContextProgressBarInner, contextProgressBarPropsEqual);
