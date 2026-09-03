/**
 * Dream Cycle — Skill Creation from Patterns
 *
 * Uses SkillFactory to create new SkillManifest objects from high-confidence
 * patterns, then persists them to memory.
 */

import type { Learning, MarketConditions, MarketRegime } from '@dyna/agent-core';

import type { DreamAction, DreamPattern } from './dream-types';
import type { DreamContext } from './dream-context';
import { AGENT_MEMORY_SCOPE } from './dream-context';

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Use SkillFactory to create new SkillManifest objects from high-confidence
 * patterns, then persist them to memory.
 */
export async function createSkillsFromPatterns(
  ctx: DreamContext,
  patterns: DreamPattern[],
  learnings: Learning[],
): Promise<{ actions: DreamAction[] }> {
  const actions: DreamAction[] = [];

  for (const pattern of patterns) {
    // Only create skills from high-confidence patterns
    if (pattern.confidence < 0.65) continue;
    // Gather supporting learnings
    const supportingLearnings = learnings.filter(
      (l) => pattern.evidence.includes(l.id),
    );

    if (supportingLearnings.length < 2) continue;

    if (pattern.type === 'general_pattern') {
      const domainLabel = pattern.domain?.trim() || 'uncategorized';
      const factory = ctx.skillFactory as unknown as {
        createSkillFromTask?: (input: {
          title: string; description: string; outcome: string; steps: string[];
          evidence: string[]; tags: string[]; successful: boolean;
        }) => Promise<unknown>;
      };
      if (!factory.createSkillFromTask) continue;
      const skill = await factory.createSkillFromTask({
        title: `${domainLabel} reusable task pattern`,
        description: pattern.description,
        outcome: supportingLearnings.map((learning) => learning.content).join('\n'),
        steps: supportingLearnings.map((learning) => learning.content),
        evidence: pattern.evidence,
        tags: [domainLabel, 'dream-generated'],
        successful: true,
      });
      if (!skill) continue;
      await ctx.memoryStore.put({ scope: AGENT_MEMORY_SCOPE, kind: 'skill_created', payload: skill, ts: new Date() });
      actions.push({
        type: 'skill_created',
        description: `Created reusable ${domainLabel} skill from dream pattern`,
        detail: pattern.description,
        confidence: pattern.confidence,
      });
      continue;
    }

    if (!pattern.symbol) continue;

    // Determine market conditions from pattern type
    const conditions: MarketConditions = {
      regime: inferRegime(pattern),
      volatility: 0.02,
      trend: pattern.type === 'recurring_win' ? 'bullish' : 'neutral',
      volume: 'normal' as const,
    };

    // Use SkillFactory to create a new strategy proposal.
    const newStrategy = ctx.skillFactory.createStrategy(
      supportingLearnings,
      conditions,
      pattern.symbol,
    );

    if (!newStrategy) {
      ctx.logger.debug(
        `SkillFactory returned null for pattern ${pattern.id} on ${pattern.symbol}`,
      );
      continue;
    }

    const proposal = await ctx.skillFactory.proposeStrategy(
      newStrategy,
      supportingLearnings,
      conditions,
    );

    if (!proposal) {
      ctx.logger.debug(`Strategy proposal rejected for pattern ${pattern.id} on ${pattern.symbol}`);
      continue;
    }

    await ctx.memoryStore.put({
      scope: AGENT_MEMORY_SCOPE,
      kind: 'skill_proposed',
      payload: {
        type: 'skill_proposed',
        approvalState: proposal.approvalState,
        directory: proposal.directory,
        path: proposal.path,
        ...proposal.skill,
        description: `Dream-created from pattern: ${pattern.description}`,
        sourcePattern: pattern.id,
      },
      ts: new Date(),
    });

    // Index in cross-session recall
    await ctx.crossSessionRecall.index(
      `dream-skill-${newStrategy.id}`,
      `Dream-created proposal for ${pattern.symbol}: ${pattern.description}`,
    );

    actions.push({
      type: 'skill_proposed',
      description: `Created new skill proposal ${newStrategy.id} for ${pattern.symbol} from pattern`,
      detail: pattern.description,
      skillName: proposal.skill.id,
      confidence: pattern.confidence,
    });

    ctx.logger.info(
      `Created skill proposal ${proposal.skill.id} from pattern on ${pattern.symbol}`,
    );
  }

  return { actions };
}

/**
 * Infer a market regime from a pattern type.
 */
function inferRegime(pattern: DreamPattern): MarketRegime {
  switch (pattern.type) {
    case 'recurring_win':
      return 'trending';
    case 'recurring_loss':
      return 'volatile';
    case 'regime_shift':
      return 'ranging';
    case 'timing_pattern':
      return 'calm';
    case 'general_pattern':
      return 'ranging';
    default:
      return 'ranging';
  }
}
