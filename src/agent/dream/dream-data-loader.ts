/**
 * Dream Cycle — Data Loader
 *
 * Loads skills from memory stores.
 */

import type { SkillManifest } from '@dyna/contracts';

import type { DreamContext } from './dream-context';
import { AGENT_MEMORY_SCOPE, SEARCH_TOP_K } from './dream-context';

// ---------------------------------------------------------------------------
// Internal Types
// ---------------------------------------------------------------------------

export interface SkillEntry {
  id: string;
  strategy: SkillManifest;
  description: string;
  timestamp: Date;
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Load all skill entries from the agent memory scope.
 */
export async function loadSkills(ctx: DreamContext): Promise<SkillEntry[]> {
  try {
    const results = await ctx.memoryStore.search({
      scope: AGENT_MEMORY_SCOPE,
      text: '',
      topK: SEARCH_TOP_K,
    });

    const skills: SkillEntry[] = [];
    for (const result of results) {
      const payload = result.payload as Record<string, unknown>;
      if (!payload || typeof payload !== 'object') continue;

      // Match skill_created entries (have SkillManifest fields like id, venue, symbol)
      if ('venue' in payload && 'symbol' in payload && 'id' in payload) {
        skills.push({
          id: result.id,
          strategy: payload as unknown as SkillManifest,
          description: (payload.description as string) ?? '',
          timestamp: result.timestamp,
        });
      }
    }
    return skills;
  } catch {
    ctx.logger.warn('Failed to load skills from memory');
    return [];
  }
}
