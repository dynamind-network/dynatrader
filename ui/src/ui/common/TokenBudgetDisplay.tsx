import React from 'react';
import { Text } from 'ink';

export interface TokenBudgetDisplayProps {
  used: number;
  budget: number;
  elapsedMs: number;
  rateLimitRemaining?: number | null;
}

/**
 * Format a number compactly for terminal display.
 * 0-999: as-is, 1000-999999: X.Xk, 1000000+: X.Xm
 */
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}

/**
 * Get color based on usage percentage.
 * Green: <50%, Yellow: 50-80%, Red: >80%
 */
export function getTokenBudgetColor(pct: number): string {
  if (pct < 50) return 'green';
  if (pct <= 80) return 'yellow';
  return 'red';
}

/**
 * Format a duration in seconds to a human-readable string.
 */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m${secs}s`;
}

interface BuildTokenBudgetTextOptions {
  used: number;
  budget: number;
  elapsedMs: number;
}

/**
 * Build the token budget text string.
 * Returns "used / budget (pct%)" with optional ETA.
 */
export function buildTokenBudgetText(options: BuildTokenBudgetTextOptions): string {
  const { used, budget, elapsedMs } = options;
  const pct = budget > 0 ? Math.round((used / budget) * 100) : 0;
  const remaining = budget - used;

  // Only show ETA when we have enough data for a meaningful rate
  const rate = elapsedMs > 5000 && used >= 2000 ? used / elapsedMs : 0;
  const eta = rate > 0 && remaining > 0 ? ` ~${formatDuration(remaining / rate)}` : '';

  return `${formatTokenCount(used)} / ${formatTokenCount(budget)} (${pct}%)${eta}`;
}

/**
 * Build rate limit countdown text.
 * Returns null when no rate limit info available.
 */
export function buildRateLimitText(remaining?: number | null): string | null {
  if (!remaining || remaining <= 0) return null;
  return `Rate limit: ${remaining}s`;
}

/**
 * Token budget display component for the status line.
 * Shows: tokens used / budget, percentage, ETA, and rate limit countdown.
 */
function TokenBudgetDisplayInner({
  used,
  budget,
  elapsedMs,
  rateLimitRemaining,
}: TokenBudgetDisplayProps) {
  if (budget <= 0) return null;

  const pct = budget > 0 ? Math.round((used / budget) * 100) : 0;
  const color = getTokenBudgetColor(pct);
  const budgetText = buildTokenBudgetText({ used, budget, elapsedMs });
  const rateLimitText = buildRateLimitText(rateLimitRemaining);

  return (
    <>
      <Text color={color}>{budgetText}</Text>
      {rateLimitText && (
        <>
          <Text color="gray"> · </Text>
          <Text color="yellow">{rateLimitText}</Text>
        </>
      )}
    </>
  );
}

export const TokenBudgetDisplay = React.memo(TokenBudgetDisplayInner);
