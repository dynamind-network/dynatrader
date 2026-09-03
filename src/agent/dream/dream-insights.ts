/**
 * Dream Cycle — Insight Generation
 *
 * Generates new insight learnings from accumulated data and patterns.
 * Insights are new Learning objects stored in the learning engine's
 * scope, making them available for future strategy creation.
 */

import type { Learning } from '@dyna/agent-core';

import type { DreamAction, DreamPattern } from './dream-types';
import type { DreamContext } from './dream-context';
import { LEARNING_SCOPE } from './dream-context';

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Generate new insight learnings from accumulated data and patterns.
 */
export async function generateInsights(
  ctx: DreamContext,
  learnings: Learning[],
  patterns: DreamPattern[],
): Promise<{ actions: DreamAction[] }> {
  const actions: DreamAction[] = [];

  // Generate insight from each high-confidence pattern
  for (const pattern of patterns) {
    if (pattern.confidence < 0.6) continue;

    const category = pattern.type === 'recurring_loss' || pattern.type === 'regime_shift'
      ? ('risk' as const)
      : ('entry' as const);

    const type: 'pattern' | 'success' | 'mistake' | 'regime' | 'timing' =
      pattern.type === 'recurring_win' ? 'success' :
      pattern.type === 'recurring_loss' ? 'mistake' :
      pattern.type === 'regime_shift' ? 'regime' :
      'timing';

    const insight: Learning = {
      id: `insight-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      type,
      content: pattern.description,
      confidence: pattern.confidence * 0.9, // Slightly discount derived insights
      evidence: pattern.evidence,
      category,
      applicableSymbols: pattern.symbol ? [pattern.symbol] : [],
      applicableRegimes: [],
      createdAt: Date.now(),
      timesUsed: 0,
      successRate: 0,
    };

    // Persist insight as a learning
    await ctx.memoryStore.put({
      scope: LEARNING_SCOPE,
      kind: `learning_${type}`,
      payload: insight,
      ts: new Date(),
    });

    // Index in cross-session recall
    await ctx.crossSessionRecall.index(
      `dream-insight-${insight.id}`,
      `Insight: ${pattern.description}`,
    );

    actions.push({
      type: 'insight_generated',
      description: `Generated ${type} insight from ${pattern.type} pattern`,
      detail: pattern.description,
      confidence: insight.confidence,
    });
  }

  return { actions };
}
