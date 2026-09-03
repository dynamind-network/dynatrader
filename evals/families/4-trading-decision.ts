/**
 * Eval Family 4: Trading Decision
 *
 * Historical replay scenarios with risk-adjusted metric evaluation.
 */

import type { EvalScenario, EvalFamily } from '../harness/types';
import { registerEvaluator, registerHardFailureChecker } from '../harness/evaluators';
import {
  BTC_BULL_TREND, BTC_BEAR_TREND, BTC_HIGH_VOLATILITY, BTC_CONFLICTING,
  DEFAULT_PORTFOLIO, STRESSED_PORTFOLIO, DEFAULT_RISK_CONFIG,
} from '../scenarios/shared/fixtures';

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

export const tradingDecisionScenarios: EvalScenario[] = [
  {
    id: 'trade-bull-entry-001',
    family: 'trading_decision' as EvalFamily,
    name: 'Bull Trend Entry Decision',
    description: 'Clear uptrend - should the agent enter long?',
    tags: ['trading', 'entry'],
    task: `Given the current market conditions, should we enter a BTC long position?

Market: Bull trend, price $112,430, rising volume
Portfolio: $105K equity, 0.45 BTC long ($47K exposure, 45% of equity)
Risk limits: Max 10% position, 3x leverage, 3% daily loss

Provide your decision (BUY/SELL/HOLD) with reasoning.`,
    snapshot: BTC_BULL_TREND,
    portfolio: DEFAULT_PORTFOLIO,
    risk_config: DEFAULT_RISK_CONFIG,
    expected: {
      decision: ['BUY', 'LONG', 'ENTER', 'INCREASE'],
      pass_thresholds: { task_success: 0.5 },
    },
  },
  {
    id: 'trade-bear-entry-001',
    family: 'trading_decision' as EvalFamily,
    name: 'Bear Trend Decision',
    description: 'Clear downtrend - should the agent exit or short?',
    tags: ['trading', 'entry', 'bearish'],
    task: `BTC is in a clear downtrend. What should we do?

Market: Bear trend, price $98,200, rising volume on sells
Portfolio: $92K equity, 0.45 BTC long ($44K exposure)
Risk limits: Max 10% position, 3x leverage, 3% daily loss

Provide your decision (BUY/SELL/HOLD/REDUCE) with reasoning.`,
    snapshot: BTC_BEAR_TREND,
    portfolio: STRESSED_PORTFOLIO,
    risk_config: DEFAULT_RISK_CONFIG,
    expected: {
      decision: ['SELL', 'SHORT', 'REDUCE', 'EXIT', 'HOLD'],
      pass_thresholds: { task_success: 0.5 },
    },
  },
  {
    id: 'trade-vol-001',
    family: 'trading_decision' as EvalFamily,
    name: 'High Volatility Decision',
    description: 'Extreme volatility - should the agent reduce exposure?',
    tags: ['trading', 'volatility'],
    task: `BTC is experiencing extreme volatility with $9K swings in 4 hours. What should we do?

Market: High volatility, $105,800, ATR 5200
Portfolio: $92K equity, 0.72 BTC long at 5x leverage ($66K exposure)
Funding: 0.025 (very high)

Provide your decision with reasoning.`,
    snapshot: BTC_HIGH_VOLATILITY,
    portfolio: STRESSED_PORTFOLIO,
    risk_config: DEFAULT_RISK_CONFIG,
    expected: {
      decision: ['REDUCE', 'SELL', 'EXIT', 'HEDGE', 'HOLD'],
      pass_thresholds: { task_success: 0.3 },
    },
  },
  {
    id: 'trade-conflict-001',
    family: 'trading_decision' as EvalFamily,
    name: 'Conflicting Signals Decision',
    description: 'Mixed signals - agent should be cautious',
    tags: ['trading', 'conflict'],
    task: `We have conflicting signals on BTC. What's your call?

Technical: Bullish (RSI 72.5, MACD positive, above EMAs)
Funding: 0.045 (extremely crowded long)
OI: $5.2B rapidly rising (leverage buildup)
News: SEC hearing, whale movements
Portfolio: $105K equity, 0.45 BTC long

Provide your decision with careful reasoning.`,
    snapshot: BTC_CONFLICTING,
    portfolio: DEFAULT_PORTFOLIO,
    risk_config: DEFAULT_RISK_CONFIG,
    expected: {
      decision: ['HOLD', 'WAIT', 'REDUCE', 'CAUTIOUS', 'NO'],
      pass_thresholds: { task_success: 0.3 },
    },
  },
];

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

registerEvaluator('trading_decision', (trajectory, scenario) => {
  const decision = trajectory
    .filter(s => s.action === 'decision')
    .map(s => String(s.output ?? ''))
    .join(' ')
    .toUpperCase();

  const scores: Record<string, number> = {};

  // Decision quality - check if decision matches expected
  const expected = scenario.expected.decision;
  if (expected) {
    const validDecisions = Array.isArray(expected) ? expected : [expected];
    scores.decision_quality = validDecisions.some(d => decision.includes(d.toUpperCase())) ? 1 : 0.3;
  } else {
    scores.decision_quality = 0.5;
  }

  // Risk discipline - check if agent mentions risk considerations
  const riskWords = ['risk', 'stop', 'loss', 'exposure', 'leverage', 'drawdown', 'position size', 'sizing', 'limit'];
  const riskMentions = riskWords.filter(w => decision.toLowerCase().includes(w)).length;
  scores.risk_discipline = Math.min(1, riskMentions / 3);

  // Position sizing check - if agent proposes a position, is it within limits?
  const sizeMatch = decision.match(/(\d+(?:\.\d+)?)\s*(?:%|percent)/);
  if (sizeMatch) {
    const proposedPct = parseFloat(sizeMatch[1]);
    const maxPct = scenario.risk_config?.max_position_pct ?? 10;
    scores.sizing_compliance = proposedPct <= maxPct ? 1 : 0;
  } else {
    scores.sizing_compliance = 1; // No specific sizing proposed
  }

  // Leverage check
  const leverageMatch = decision.match(/(\d+)x?\s*(?:leverage|lev)/i);
  if (leverageMatch) {
    const proposedLev = parseInt(leverageMatch[1]);
    const maxLev = scenario.risk_config?.max_leverage ?? 3;
    scores.leverage_compliance = proposedLev <= maxLev ? 1 : 0;
  } else {
    scores.leverage_compliance = 1;
  }

  // Reasoning depth
  const reasoningSteps = trajectory.filter(s => s.action === 'reasoning');
  scores.reasoning_depth = Math.min(1, reasoningSteps.length / 3);

  // Composite task_success
  scores.task_success = (
    (scores.decision_quality ?? 0) * 0.30 +
    (scores.risk_discipline ?? 0) * 0.20 +
    (scores.sizing_compliance ?? 0) * 0.15 +
    (scores.leverage_compliance ?? 0) * 0.15 +
    (scores.reasoning_depth ?? 0) * 0.20
  );

  return scores;
});

registerHardFailureChecker('trading_decision', (trajectory, scenario) => {
  const failures: string[] = [];
  const fullDecision = trajectory
    .filter(s => s.action === 'decision')
    .map(s => String(s.output ?? ''))
    .join(' ')
    .toUpperCase();

  // Extract just the decision line (first line or after "Decision:")
  const lines = fullDecision.split('\n');
  let decisionLine = lines[0] ?? '';
  for (const line of lines) {
    if (line.includes('DECISION')) {
      decisionLine = line;
      break;
    }
  }

  // Only check for PROPOSED actions (model says it WILL DO something)
  // Not DESCRIBED states (model says something IS the case)
  const proposesTrade = /\b(LONG|SHORT|BUY|SELL|OPEN|ENTER|INCREASE|ADD)\b/.test(decisionLine);
  const refusesTrade = /\b(HOLD|WAIT|NO|REFUSE|CANNOT|REDUCE|EXIT|CLOSE|CAUTIOUS|PASS)\b/.test(decisionLine);

  // Hard failure: leverage breach — only if model proposes a leveraged trade
  if (proposesTrade && !refusesTrade) {
    const leverageMatch = decisionLine.match(/(\d+)x?\s*(?:LEVERAGE|LEV)/);
    if (leverageMatch) {
      const proposedLev = parseInt(leverageMatch[1]);
      const maxLev = scenario.risk_config?.max_leverage ?? 3;
      if (proposedLev > maxLev) failures.push('MAX_LEVERAGE_BREACH');
    }
  }

  // Hard failure: position size breach — only if model proposes a trade
  if (proposesTrade && !refusesTrade) {
    const sizeMatch = decisionLine.match(/(\d+(?:\.\d+)?)\s*(?:%|PERCENT)/);
    if (sizeMatch) {
      const proposedPct = parseFloat(sizeMatch[1]);
      const maxPct = scenario.risk_config?.max_position_pct ?? 10;
      if (proposedPct > maxPct * 2) failures.push('MAX_POSITION_BREACH');
    }
  }

  return failures;
});
