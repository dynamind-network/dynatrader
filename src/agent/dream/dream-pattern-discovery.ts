/**
 * Dream Cycle — Pattern Discovery
 *
 * Analyzes learnings to discover recurring patterns such as
 * win/loss clustering, timing tendencies, and regime shifts.
 */

import type { Learning } from '@dyna/agent-core';

import type { DreamAction, DreamPattern } from './dream-types';
import type { DreamContext } from './dream-context';
import {
  DREAM_SCOPE,
  MIN_PATTERN_EVIDENCE,
  WIN_RATE_THRESHOLD_HIGH,
  WIN_RATE_THRESHOLD_LOW,
  PATTERN_CONFIDENCE_BASE,
} from './dream-context';

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Analyze learnings to discover recurring patterns.
 *
 * Patterns are grouped by:
 * - Symbol + regime combinations
 * - Win/loss clustering
 * - Timing (day-of-week, time-of-day tendencies)
 */
export async function discoverPatterns(
  ctx: DreamContext,
  learnings: Learning[],
): Promise<{ patterns: DreamPattern[]; actions: DreamAction[] }> {
  const patterns: DreamPattern[] = [];
  const actions: DreamAction[] = [];

  // General task learnings do not necessarily have market symbols. Group them
  // by an explicit domain/category and discover reusable cross-session patterns.
  const byDomain = new Map<string, Learning[]>();
  for (const learning of learnings) {
    const generic = learning as Learning & { domain?: string; taskType?: string; tags?: string[] };
    if ((learning.applicableSymbols?.length ?? 0) > 0) continue;
    const domain =
      generic.domain ?? generic.taskType ?? learning.category ?? generic.tags?.[0] ?? 'uncategorized';
    const group = byDomain.get(domain) ?? [];
    group.push(learning);
    byDomain.set(domain, group);
  }

  for (const [domain, domainLearnings] of byDomain) {
    if (domainLearnings.length < MIN_PATTERN_EVIDENCE) continue;
    const confidence = Math.min(0.9, PATTERN_CONFIDENCE_BASE + domainLearnings.length * 0.05);
    const pattern = createPattern({
      type: 'general_pattern',
      description: `Reusable ${domain} task pattern found across ${domainLearnings.length} learnings`,
      confidence,
      evidence: domainLearnings.map((learning) => learning.id),
      domain,
    });
    patterns.push(pattern);
    actions.push({
      type: 'pattern_discovered',
      description: pattern.description,
      detail: `Domain: ${domain}; confidence: ${confidence.toFixed(2)}`,
      confidence,
    });
  }

  // Group learnings by symbol
  const bySymbol = new Map<string, Learning[]>();
  for (const learning of learnings) {
    for (const symbol of learning.applicableSymbols) {
      if (!bySymbol.has(symbol)) {
        bySymbol.set(symbol, []);
      }
      bySymbol.get(symbol)!.push(learning);
    }
  }

  // Analyze each symbol group
  for (const [symbol, symbolLearnings] of bySymbol) {
    if (symbolLearnings.length < MIN_PATTERN_EVIDENCE) continue;

    // Count by type
    let successCount = 0;
    let mistakeCount = 0;
    let regimeCount = 0;
    let timingCount = 0;

    for (const l of symbolLearnings) {
      if (l.type === 'success' || l.type === 'pattern') successCount++;
      if (l.type === 'mistake') mistakeCount++;
      if (l.type === 'regime') regimeCount++;
      if (l.type === 'timing') timingCount++;
    }

    const total = successCount + mistakeCount + regimeCount + timingCount;
    if (total === 0) continue;

    const winRate = successCount / (successCount + mistakeCount || 1);

    // Recurring win pattern
    if (successCount >= MIN_PATTERN_EVIDENCE && winRate >= WIN_RATE_THRESHOLD_HIGH) {
      const pattern = createPattern({
        type: 'recurring_win',
        description: `Consistent winning pattern on ${symbol}: ${successCount} successes vs ${mistakeCount} losses (${(winRate * 100).toFixed(0)}% win rate)`,
        confidence: Math.min(0.9, PATTERN_CONFIDENCE_BASE + winRate * 0.3),
        evidence: symbolLearnings.filter(l => l.type === 'success' || l.type === 'pattern').map(l => l.id),
        symbol,
      });
      patterns.push(pattern);
      actions.push({
        type: 'pattern_discovered',
        description: pattern.description,
        detail: `Confidence: ${pattern.confidence.toFixed(2)}`,
        confidence: pattern.confidence,
      });
    }

    // Recurring loss pattern
    if (mistakeCount >= MIN_PATTERN_EVIDENCE && winRate <= WIN_RATE_THRESHOLD_LOW) {
      const pattern = createPattern({
        type: 'recurring_loss',
        description: `Consistent losing pattern on ${symbol}: ${mistakeCount} losses vs ${successCount} successes (${(winRate * 100).toFixed(0)}% win rate)`,
        confidence: Math.min(0.85, PATTERN_CONFIDENCE_BASE + (1 - winRate) * 0.25),
        evidence: symbolLearnings.filter(l => l.type === 'mistake').map(l => l.id),
        symbol,
      });
      patterns.push(pattern);
      actions.push({
        type: 'pattern_discovered',
        description: pattern.description,
        detail: `Confidence: ${pattern.confidence.toFixed(2)}`,
        confidence: pattern.confidence,
      });
    }

    // Timing pattern
    if (timingCount >= MIN_PATTERN_EVIDENCE) {
      const pattern = createPattern({
        type: 'timing_pattern',
        description: `Timing pattern detected on ${symbol}: ${timingCount} timing-related learnings suggest specific holding periods or entry times`,
        confidence: Math.min(0.75, PATTERN_CONFIDENCE_BASE + timingCount * 0.05),
        evidence: symbolLearnings.filter(l => l.type === 'timing').map(l => l.id),
        symbol,
      });
      patterns.push(pattern);
      actions.push({
        type: 'pattern_discovered',
        description: pattern.description,
        detail: `Confidence: ${pattern.confidence.toFixed(2)}`,
        confidence: pattern.confidence,
      });
    }

    // Regime shift pattern
    if (regimeCount >= MIN_PATTERN_EVIDENCE) {
      const pattern = createPattern({
        type: 'regime_shift',
        description: `Market regime pattern detected on ${symbol}: ${regimeCount} regime-related learnings suggest adapting to changing market conditions`,
        confidence: Math.min(0.7, PATTERN_CONFIDENCE_BASE + regimeCount * 0.04),
        evidence: symbolLearnings.filter(l => l.type === 'regime').map(l => l.id),
        symbol,
      });
      patterns.push(pattern);
      actions.push({
        type: 'pattern_discovered',
        description: pattern.description,
        detail: `Confidence: ${pattern.confidence.toFixed(2)}`,
        confidence: pattern.confidence,
      });
    }
  }

  // Persist patterns to memory for cross-session retrieval
  for (const pattern of patterns) {
    await persistPattern(ctx, pattern);
    await ctx.crossSessionRecall.index(
      `dream-pattern-${pattern.id}`,
      `Pattern: ${pattern.description}`,
    );
  }

  return { patterns, actions };
}

/**
 * Create a DreamPattern with a unique ID.
 */
function createPattern(params: {
  type: DreamPattern['type'];
  description: string;
  confidence: number;
  evidence: string[];
  symbol?: string;
  timeframe?: string;
  domain?: string;
}): DreamPattern {
  return {
    id: `pattern-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
    type: params.type,
    description: params.description,
    confidence: params.confidence,
    evidence: params.evidence,
    symbol: params.symbol,
    timeframe: params.timeframe,
    domain: params.domain,
  };
}

/**
 * Persist a DreamPattern to memory.
 */
async function persistPattern(ctx: DreamContext, pattern: DreamPattern): Promise<void> {
  await ctx.memoryStore.put({
    scope: DREAM_SCOPE,
    kind: 'dream_pattern',
    payload: pattern,
    ts: new Date(),
  });
}
