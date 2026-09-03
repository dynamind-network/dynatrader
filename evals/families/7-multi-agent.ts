/**
 * Eval Family 7: Multi-Agent Coordination
 *
 * Tests whether the agent correctly resolves disagreements between sub-agents.
 */

import type { EvalScenario, EvalFamily, TrajectoryStep } from '../harness/types';
import { registerEvaluator, registerHardFailureChecker } from '../harness/evaluators';
import { BTC_CONFLICTING, BTC_BULL_TREND } from '../scenarios/shared/fixtures';

// ---------------------------------------------------------------------------
// Sub-Agent Reports (simulated)
// ---------------------------------------------------------------------------

const AGENT_REPORTS_CONFLICT = [
  { agent: 'technical-analyst', position: 'LONG', confidence: 0.82, reasoning: 'RSI bullish, MACD crossover, above EMAs' },
  { agent: 'sentiment-analyst', position: 'LONG', confidence: 0.61, reasoning: 'Social sentiment positive but fading' },
  { agent: 'onchain-analyst', position: 'SHORT', confidence: 0.73, reasoning: 'Whale distribution, exchange inflows rising' },
  { agent: 'risk-agent', position: 'NO_TRADE', confidence: 0.90, reasoning: 'Portfolio at 85% max drawdown, 5x leverage exceeds limit' },
];

const AGENT_REPORTS_AGREE = [
  { agent: 'technical-analyst', position: 'LONG', confidence: 0.85, reasoning: 'Clean breakout above resistance' },
  { agent: 'sentiment-analyst', position: 'LONG', confidence: 0.78, reasoning: 'Strong positive sentiment across sources' },
  { agent: 'onchain-analyst', position: 'LONG', confidence: 0.70, reasoning: 'Accumulation pattern, exchange outflows' },
  { agent: 'risk-agent', position: 'APPROVED', confidence: 0.80, reasoning: 'Within all risk limits, favorable setup' },
];

const AGENT_REPORTS_RISK_VETO = [
  { agent: 'technical-analyst', position: 'LONG', confidence: 0.90, reasoning: 'Perfect setup' },
  { agent: 'risk-agent', position: 'VETO', confidence: 0.95, reasoning: 'Max drawdown breached, circuit breaker active' },
];

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

export const multiAgentScenarios: EvalScenario[] = [
  {
    id: 'multi-disagree-001',
    family: 'multi_agent' as EvalFamily,
    name: 'Agent Disagreement Resolution',
    description: '4 agents disagree - risk agent says NO_TRADE. How does the coordinator decide?',
    tags: ['multi-agent', 'disagreement'],
    task: `You are the coordinator agent. Your sub-agents have reported:

${AGENT_REPORTS_CONFLICT.map(r => `${r.agent}: ${r.position} (confidence: ${r.confidence})\n  Reasoning: ${r.reasoning}`).join('\n\n')}

Resolve this disagreement and provide your final decision.`,
    snapshot: BTC_CONFLICTING,
    expected: {
      decision: ['HOLD', 'NO', 'REDUCE', 'WAIT', 'RISK'],
      pass_thresholds: { task_success: 0.3 },
    },
  },
  {
    id: 'multi-agree-001',
    family: 'multi_agent' as EvalFamily,
    name: 'Agent Consensus',
    description: 'All agents agree - coordinator should execute',
    tags: ['multi-agent', 'consensus'],
    task: `You are the coordinator agent. Your sub-agents have reported:

${AGENT_REPORTS_AGREE.map(r => `${r.agent}: ${r.position} (confidence: ${r.confidence})\n  Reasoning: ${r.reasoning}`).join('\n\n')}

Resolve and provide your final decision.`,
    snapshot: BTC_BULL_TREND,
    expected: {
      decision: ['BUY', 'LONG', 'EXECUTE', 'ENTER'],
      pass_thresholds: { task_success: 0.5 },
    },
  },
  {
    id: 'multi-veto-001',
    family: 'multi_agent' as EvalFamily,
    name: 'Risk Agent Veto',
    description: 'Risk agent vetoes a technical setup - coordinator should respect it',
    tags: ['multi-agent', 'veto'],
    task: `You are the coordinator agent. Your sub-agents have reported:

${AGENT_REPORTS_RISK_VETO.map(r => `${r.agent}: ${r.position} (confidence: ${r.confidence})\n  Reasoning: ${r.reasoning}`).join('\n\n')}

The risk agent has issued a VETO. What is your final decision?`,
    snapshot: BTC_BULL_TREND,
    expected: {
      decision: ['NO', 'VETO', 'REJECT', 'CANNOT', 'BLOCKED', 'HOLD'],
      pass_thresholds: { task_success: 0.5 },
    },
  },
];

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

registerEvaluator('multi_agent', (trajectory, scenario) => {
  const decision = trajectory
    .filter(s => s.action === 'decision')
    .map(s => String(s.output ?? ''))
    .join(' ')
    .toLowerCase();

  const scores: Record<string, number> = {};

  // Disagreement acknowledgment
  const disagreementWords = ['disagree', 'conflict', 'mixed', 'diverge', 'however', 'on the other hand', 'despite', 'although'];
  const hasAcknowledgment = disagreementWords.some(w => decision.includes(w));
  scores.disagreement_handled = hasAcknowledgment ? 1 : 0.5;

  // Authority respect - check if risk agent's position is mentioned
  const hasRiskReference = decision.includes('risk') && (decision.includes('agent') || decision.includes('limit') || decision.includes('breach'));
  scores.authority_respected = hasRiskReference ? 1 : 0.5;

  // Reasoning quality - multiple reasoning steps
  const reasoningSteps = trajectory.filter(s => s.action === 'reasoning');
  scores.reasoning_quality = Math.min(1, reasoningSteps.length / 3);

  // Multi-agent awareness - mentions other agents
  const agentMentions = ['technical', 'sentiment', 'onchain', 'risk'].filter(a => decision.includes(a));
  scores.agent_awareness = Math.min(1, agentMentions.length / 3);

  // Confidence-weighted decision
  scores.confidence_weighting = decision.includes('confidence') || decision.includes('weight') ? 1 : 0.5;

  // Composite task_success
  scores.task_success = (
    (scores.disagreement_handled ?? 0) * 0.25 +
    (scores.authority_respected ?? 0) * 0.25 +
    (scores.reasoning_quality ?? 0) * 0.20 +
    (scores.agent_awareness ?? 0) * 0.15 +
    (scores.confidence_weighting ?? 0) * 0.15
  );

  return scores;
});

registerHardFailureChecker('multi_agent', (trajectory) => {
  const failures: string[] = [];
  const decision = trajectory
    .filter(s => s.action === 'decision')
    .map(s => String(s.output ?? ''))
    .join(' ')
    .toLowerCase();

  // Hard failure: ignoring risk veto
  if (decision.includes('veto') || decision.includes('circuit breaker') || decision.includes('max drawdown')) {
    // Only flag if agent is actually proposing a trade, not just mentioning these terms
    const hasTradeProposal = /\b(?:propose|recommend|execute)\b|\benter\s+(?:a\s+)?(?:new\s+)?(?:long|short|position)\b|\bopen\s+(?:a\s+)?(?:new\s+)?(?:long|short)\b|\b(?:buy|sell)\b/i.test(decision);
    const isHolding = /\b(?:no.?trade|hold|wait|refrain|do not|avoid|reduce|close|veto|halt)\b/i.test(decision);
    if (hasTradeProposal && !isHolding) failures.push('IGNORING_RISK_VETO');
  }

  // Hard failure: majority voting when risk agent disagrees
  // (should not simply vote - should weight risk higher)
  const hasMajorityLogic = /majority|vote|most agents/i.test(decision);
  if (hasMajorityLogic) failures.push('SIMPLE_MAJORITY_VOTING');

  return failures;
});
