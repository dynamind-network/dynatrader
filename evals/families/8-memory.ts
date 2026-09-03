/**
 * Eval Family 8: Memory
 *
 * Tests whether the agent recalls and applies past experiences.
 */

import type { EvalScenario, EvalFamily } from '../harness/types';
import { registerEvaluator, registerHardFailureChecker, checkMemoryRecall } from '../harness/evaluators';
import { BTC_HIGH_VOLATILITY } from '../scenarios/shared/fixtures';

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

export const memoryScenarios: EvalScenario[] = [
  {
    id: 'mem-recall-001',
    family: 'memory' as EvalFamily,
    name: 'Pattern Recall',
    description: 'Agent should recall a previous similar pattern and apply the learning',
    tags: ['memory', 'recall'],
    task: `Two weeks ago, you made a BTC breakout trade during a low-volume Asian session.
The trade failed because breakouts during low-volume sessions historically produce poor follow-through.

Now you see another BTC breakout setup during an Asian session (low volume). What should we do?

Remember your past experience and apply it.`,
    snapshot: BTC_HIGH_VOLATILITY,
    expected: {
      decision: ['CAUTIOUS', 'WAIT', 'NO', 'HOLD', 'SKIP', 'LOW VOLUME'],
      pass_thresholds: { task_success: 0.3 },
    },
  },
  {
    id: 'mem-relevance-001',
    family: 'memory' as EvalFamily,
    name: 'Relevant Memory Retrieval',
    description: 'Agent should retrieve memories relevant to the current scenario',
    tags: ['memory', 'relevance'],
    task: `We're considering a BTC position. Check your memory for any relevant past experiences with similar market conditions (high volatility, extreme funding rates).

What lessons have we learned from similar situations?`,
    snapshot: BTC_HIGH_VOLATILITY,
    expected: {
      pass_thresholds: { task_success: 0.3 },
    },
  },
  {
    id: 'mem-stale-001',
    family: 'memory' as EvalFamily,
    name: 'Stale Memory Detection',
    description: 'Agent should not apply outdated learnings to changed conditions',
    tags: ['memory', 'stale'],
    task: `In January, you learned that BTC tends to rally after Fed rate cuts.
Since then, the macro regime has shifted - the market now reacts negatively to rate cuts due to recession fears.

Given current conditions, should we apply the January learning?`,
    snapshot: BTC_HIGH_VOLATILITY,
    expected: {
      decision: ['NO', 'OUTDATED', 'STALE', 'CHANGED', 'DIFFERENT', 'REGIME SHIFT'],
      pass_thresholds: { task_success: 0.3 },
    },
  },
];

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

registerEvaluator('memory', (trajectory, scenario) => {
  const decision = trajectory
    .filter(s => s.action === 'decision' || s.action === 'reasoning')
    .map(s => String(s.output ?? ''))
    .join(' ')
    .toLowerCase();

  const scores: Record<string, number> = {};

  // Memory recall check
  // Memory search - check for tool calls OR reasoning that references past experience
  const memorySearchCalls = trajectory.filter(s =>
    s.action === 'tool_call' && (s.tool === 'memory_search' || s.tool === 'memory_get'),
  );
  const reasoningText = trajectory
    .filter(s => s.action === 'reasoning')
    .map(s => String(s.output ?? ''))
    .join(' ')
    .toLowerCase();
  const hasMemoryReference = /\b(?:remember|recall|memory|previously|before|last time|past|history|learned|experience|two weeks? ago|month ago|similar (?:trade|situation|scenario))\b/i.test(reasoningText);
  scores.memory_search_performed = memorySearchCalls.length > 0 ? 1 : (hasMemoryReference ? 0.8 : 0);

  // Past experience application
  const experienceWords = ['learned', 'before', 'previously', 'last time', 'experience', 'history', 'past'];
  const appliedExperience = experienceWords.filter(w => decision.includes(w)).length;
  scores.experience_applied = Math.min(1, appliedExperience / 2);

  // Learning extraction
  const learningWords = ['lesson', 'takeaway', 'insight', 'pattern', 'rule'];
  const extractedLearning = learningWords.filter(w => decision.includes(w)).length;
  scores.learning_extraction = Math.min(1, extractedLearning / 2);

  // Memory relevance - check if reasoning references relevant past experience
  const expectedKeywords = ['breakout', 'low volume', 'asian session', 'similar', 'past', 'before'];
  const keywordHits = expectedKeywords.filter(k => reasoningText.includes(k)).length;
  scores.memory_relevance = Math.min(1, keywordHits / 2);

  // Stale memory detection
  const staleWords = ['outdated', 'stale', 'changed', 'different', 'regime', 'shift', 'evolved'];
  const detectedStaleness = staleWords.filter(w => decision.includes(w)).length;
  scores.stale_detection = Math.min(1, detectedStaleness / 2);

  // Composite task_success
  scores.task_success = (
    (scores.memory_search_performed ?? 0) * 0.20 +
    (scores.experience_applied ?? 0) * 0.25 +
    (scores.learning_extraction ?? 0) * 0.20 +
    (scores.memory_relevance ?? 0) * 0.15 +
    (scores.stale_detection ?? 0) * 0.20
  );

  return scores;
});

registerHardFailureChecker('memory', () => {
  // No hard failures for memory evals - it's about quality, not safety
  return [];
});
