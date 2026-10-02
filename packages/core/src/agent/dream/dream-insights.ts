/**
 * Dream Cycle — Insight Generation
 *
 * Generates new insights from accumulated data and patterns.
 * Insights are stored in memory, making them available for future strategy creation.
 */

import type { DreamAction, DreamPattern } from './dream-types';
import type { DreamContext } from './dream-context';

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Generate new insights from accumulated data and patterns.
 */
export async function generateInsights(
  ctx: DreamContext,
  patterns: DreamPattern[],
): Promise<{ actions: DreamAction[] }> {
  const actions: DreamAction[] = [];

  // Index each high-confidence pattern in cross-session recall
  for (const pattern of patterns) {
    if (pattern.confidence < 0.6) continue;

    // Index in cross-session recall
    await ctx.crossSessionRecall.index(
      `dream-insight-${pattern.id}`,
      `Insight: ${pattern.description}`,
    );

    actions.push({
      type: 'insight_generated',
      description: `Generated insight from ${pattern.type} pattern`,
      detail: pattern.description,
      confidence: pattern.confidence,
    });
  }

  return { actions };
}
