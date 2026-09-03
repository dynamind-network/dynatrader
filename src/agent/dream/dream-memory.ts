/**
 * Dream Cycle — Memory Operations
 *
 * Handles memory compaction, report persistence, and report history retrieval.
 */

import type { DreamAction, DreamMetrics, DreamReport } from './dream-types';
import type { DreamContext } from './dream-context';
import {
  DREAM_SCOPE,
  AGENT_MEMORY_SCOPE,
} from './dream-context';

// ---------------------------------------------------------------------------
// Memory Compaction
// ---------------------------------------------------------------------------

/**
 * Compact old/irrelevant data from memory scopes.
 */
export async function compactMemory(ctx: DreamContext): Promise<void> {
  try {
    await ctx.memoryStore.compact({ scope: AGENT_MEMORY_SCOPE });
    await ctx.memoryStore.compact({ scope: DREAM_SCOPE });
    ctx.logger.debug('Memory compaction completed');
  } catch (error) {
    ctx.logger.warn('Memory compaction failed', error);
  }
}

// ---------------------------------------------------------------------------
// Report Finalization
// ---------------------------------------------------------------------------

/**
 * Build the final DreamReport from collected actions and metrics.
 */
export function finalizeReport(
  startTime: number,
  actions: DreamAction[],
  metrics: DreamMetrics,
): DreamReport {
  const durationMs = Math.round(performance.now() - startTime);

  const summary = actions.length > 0
    ? `Dream cycle completed: ${metrics.skillsReviewed} skills reviewed, ` +
      `${metrics.skillsArchived} archived, ${metrics.skillsCreated} created, ` +
      `${metrics.patternsFound} patterns, ${metrics.insightsGenerated} insights`
    : 'Dream cycle completed with no actions';

  return {
    id: `dream-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
    timestamp: new Date(),
    durationMs,
    summary,
    actions,
    metrics,
  };
}

// ---------------------------------------------------------------------------
// Report Persistence
// ---------------------------------------------------------------------------

/**
 * Persist a DreamReport to memory for historical tracking.
 */
export async function persistReport(
  ctx: DreamContext,
  report: DreamReport,
): Promise<void> {
  await ctx.memoryStore.put({
    scope: DREAM_SCOPE,
    kind: 'dream_report',
    payload: report,
    ts: report.timestamp,
  });
}

// ---------------------------------------------------------------------------
// Report History
// ---------------------------------------------------------------------------

/**
 * Retrieve dream report history from memory.
 */
export async function getDreamHistory(
  ctx: DreamContext,
  limit: number = 10,
): Promise<DreamReport[]> {
  try {
    const results = await ctx.memoryStore.search({
      scope: DREAM_SCOPE,
      text: '',
      topK: limit,
    });

    return results
      .filter((r) => {
        const p = r.payload as Record<string, unknown>;
        return p && typeof p === 'object' && 'summary' in p;
      })
      .map((r) => r.payload as DreamReport)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  } catch {
    return [];
  }
}
