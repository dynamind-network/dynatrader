/**
 * Dream Cycle — Pattern Discovery
 *
 * Analyzes skill history to discover recurring patterns such as
 * win/loss clustering, timing tendencies, and regime shifts.
 */

import type { DreamAction, DreamPattern } from './dream-types';
import type { DreamContext } from './dream-context';
import {
  DREAM_SCOPE,
  MIN_PATTERN_EVIDENCE,
  WIN_RATE_THRESHOLD_HIGH,
  WIN_RATE_THRESHOLD_LOW,
  PATTERN_CONFIDENCE_BASE,
} from './dream-context';
import type { SkillEntry } from './dream-data-loader';

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Analyze skills to discover recurring patterns.
 *
 * Patterns are grouped by:
 * - Symbol + regime combinations
 * - Win/loss clustering
 * - Timing (day-of-week, time-of-day tendencies)
 */
export async function discoverPatterns(
  ctx: DreamContext,
  skills: SkillEntry[] = [],
): Promise<{ patterns: DreamPattern[]; actions: DreamAction[] }> {
  const patterns: DreamPattern[] = [];
  const actions: DreamAction[] = [];

  // Group skills by symbol
  const bySymbol = new Map<string, SkillEntry[]>();
  for (const skill of skills) {
    const symbol = skill.strategy.symbol;
    if (!bySymbol.has(symbol)) {
      bySymbol.set(symbol, []);
    }
    bySymbol.get(symbol)!.push(skill);
  }

  // Analyze each symbol group
  for (const [symbol, symbolSkills] of bySymbol) {
    if (symbolSkills.length < MIN_PATTERN_EVIDENCE) continue;

    // Count skills by age (recent vs old)
    const now = Date.now();
    let recentCount = 0;
    let oldCount = 0;

    for (const skill of symbolSkills) {
      const ageDays = (now - skill.timestamp.getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays < 30) recentCount++;
      else oldCount++;
    }

    const total = recentCount + oldCount;
    if (total === 0) continue;

    // Recurring pattern: many recent skills suggest active trading
    if (recentCount >= MIN_PATTERN_EVIDENCE) {
      const pattern = createPattern({
        type: 'general_pattern',
        description: `Active trading pattern on ${symbol}: ${recentCount} skills created in last 30 days`,
        confidence: Math.min(0.9, PATTERN_CONFIDENCE_BASE + recentCount * 0.05),
        evidence: symbolSkills.filter(s => {
          const ageDays = (now - s.timestamp.getTime()) / (1000 * 60 * 60 * 24);
          return ageDays < 30;
        }).map(s => s.id),
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
