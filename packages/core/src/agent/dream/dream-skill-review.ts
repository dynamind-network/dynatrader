/**
 * Dream Cycle — Skill Review & Archival
 *
 * Reviews skills and archives those with low usage or age.
 */

import type { DreamAction } from './dream-types';
import type { DreamContext } from './dream-context';
import { AGENT_MEMORY_SCOPE } from './dream-context';
import type { SkillEntry } from './dream-data-loader';

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Review each skill and archive those that are old or rarely used.
 */
export async function reviewAndArchiveSkills(
  ctx: DreamContext,
  skills: SkillEntry[],
): Promise<{ actions: DreamAction[]; archivedCount: number }> {
  const actions: DreamAction[] = [];
  let archivedCount = 0;

  const now = Date.now();
  const maxAgeMs = 90 * 24 * 60 * 60 * 1000; // 90 days

  for (const skill of skills) {
    const age = now - skill.timestamp.getTime();
    const shouldArchive = age > maxAgeMs;

    if (shouldArchive) {
      await archiveSkill(ctx, skill);
      archivedCount++;
      actions.push({
        type: 'skill_archived',
        description: `Archived skill "${skill.strategy.id}" for ${skill.strategy.symbol}`,
        detail: `Skill is older than 90 days`,
        skillName: skill.strategy.id,
      });
      ctx.logger.info(`Archived skill ${skill.strategy.id} (age: ${Math.round(age / 1000 / 60 / 60 / 24)}d)`);
    }
  }

  return { actions, archivedCount };
}

/**
 * Archive a skill by creating an archive marker in memory.
 */
async function archiveSkill(
  ctx: DreamContext,
  skill: SkillEntry,
): Promise<void> {
  await ctx.memoryStore.put({
    scope: AGENT_MEMORY_SCOPE,
    kind: 'skill_archived',
    payload: {
      type: 'skill_archived',
      originalSkillId: skill.strategy.id,
      symbol: skill.strategy.symbol,
      archivedAt: Date.now(),
      originalPayload: skill.strategy,
      description: skill.description,
    },
    ts: new Date(),
  });
}
