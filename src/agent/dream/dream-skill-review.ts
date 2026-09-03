/**
 * Dream Cycle — Skill Review & Archival
 *
 * Reviews skills against accumulated learnings and archives
 * those with derived confidence below the threshold.
 */

import type { Learning } from '@dyna/agent-core';

import type { DreamAction } from './dream-types';
import type { DreamContext } from './dream-context';
import { AGENT_MEMORY_SCOPE } from './dream-context';
import type { SkillEntry } from './dream-data-loader';

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Review each skill against accumulated learnings and archive those
 * with derived confidence below the threshold.
 */
export async function reviewAndArchiveSkills(
  ctx: DreamContext,
  skills: SkillEntry[],
  learnings: Learning[],
): Promise<{ actions: DreamAction[]; archivedCount: number }> {
  const actions: DreamAction[] = [];
  let archivedCount = 0;

  for (const skill of skills) {
    const confidence = deriveSkillConfidence(skill, learnings, ctx.config.skillConfidenceThreshold);

    if (confidence < ctx.config.skillConfidenceThreshold) {
      await archiveSkill(ctx, skill, confidence);
      archivedCount++;
      actions.push({
        type: 'skill_archived',
        description: `Archived skill "${skill.strategy.id}" for ${skill.strategy.symbol}`,
        detail: `Confidence ${confidence.toFixed(2)} is below threshold ${ctx.config.skillConfidenceThreshold}`,
        skillName: skill.strategy.id,
        confidence,
      });
      ctx.logger.info(
        `Archived skill ${skill.strategy.id} (confidence: ${confidence.toFixed(2)})`,
      );
    }
  }

  return { actions, archivedCount };
}

/**
 * Derive a skill's confidence from its associated learnings.
 *
 * For each skill, we look up learnings that match the skill's symbol
 * and calculate a weighted average confidence. If no learnings exist,
 * we default to a neutral 0.5.
 */
function deriveSkillConfidence(
  skill: SkillEntry,
  learnings: Learning[],
  _threshold: number,
): number {
  const symbol = skill.strategy.symbol;

  const matchingLearnings = learnings.filter(
    (l) =>
      l.applicableSymbols.length === 0 ||
      l.applicableSymbols.includes(symbol) ||
      l.applicableSymbols.includes('*'),
  );

  if (matchingLearnings.length === 0) {
    return 0.5; // neutral — no evidence either way
  }

  // Weighted average: higher weight for more recent and more used learnings
  const now = Date.now();
  let totalWeight = 0;
  let weightedSum = 0;

  for (const learning of matchingLearnings) {
    // Use confidence as base weight
    let weight = learning.confidence;

    // Boost by usage count (but cap the boost)
    weight += Math.min(learning.timesUsed * 0.05, 0.2);

    // Decay by age
    const ageInDays = (now - learning.createdAt) / (1000 * 60 * 60 * 24);
    weight *= Math.max(0.3, 1 - ageInDays * 0.01);

    weightedSum += learning.confidence * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return 0.5;

  return Math.max(0, Math.min(1, weightedSum / totalWeight));
}

/**
 * Archive a skill by creating an archive marker in memory.
 */
async function archiveSkill(
  ctx: DreamContext,
  skill: SkillEntry,
  confidence: number,
): Promise<void> {
  await ctx.memoryStore.put({
    scope: AGENT_MEMORY_SCOPE,
    kind: 'skill_archived',
    payload: {
      type: 'skill_archived',
      originalSkillId: skill.strategy.id,
      symbol: skill.strategy.symbol,
      confidence,
      archivedAt: Date.now(),
      originalPayload: skill.strategy,
      description: skill.description,
    },
    ts: new Date(),
  });
}
