/**
 * Eval Family 1: Market Understanding
 *
 * Tests whether the agent correctly interprets market state from a frozen snapshot.
 */

import type { EvalScenario, EvalFamily, MarketSnapshot } from '../harness/types';
import { registerEvaluator, registerHardFailureChecker, checkConflictDetection, checkConfidenceCalibration } from '../harness/evaluators';
import { BTC_BULL_TREND, BTC_BEAR_TREND, BTC_HIGH_VOLATILITY, BTC_RANGE, BTC_CONFLICTING } from '../scenarios/shared/fixtures';

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

function makeScenario(
  id: string,
  name: string,
  snapshot: MarketSnapshot,
  expectedRegime: string[],
  description: string,
): EvalScenario {
  return {
    id,
    family: 'market_understanding' as EvalFamily,
    name,
    description,
    tags: ['regime', 'market-state'],
    task: `Analyze the following market snapshot and determine the current market regime.

Symbol: ${snapshot.symbol}
Price: $${snapshot.price}
Timestamp: ${snapshot.timestamp}

Recent OHLCV (last ${snapshot.ohlcv.length} bars):
${snapshot.ohlcv.map(b => `  O:${b.open} H:${b.high} L:${b.low} C:${b.close} V:${b.volume}`).join('\n')}

Funding Rate: ${snapshot.funding_rate}
Open Interest: ${snapshot.open_interest ? (snapshot.open_interest / 1e9).toFixed(2) + 'B' : 'N/A'}

Indicators:
${Object.entries(snapshot.indicators ?? {}).map(([k, v]) => `  ${k}: ${v}`).join('\n')}

Recent News:
${(snapshot.news ?? []).map(n => `  [${n.source}] ${n.headline}`).join('\n')}

Provide your analysis as:
1. Market regime (one of: bull_trend, bear_trend, range, high_volatility, low_volatility, breakout, breakdown, uncertain)
2. Confidence level (0-100%)
3. Supporting evidence (cite specific data points)
4. Any contradictions you notice
5. Risks to your assessment`,
    snapshot,
    expected: {
      regime: expectedRegime,
      pass_thresholds: { regime_accuracy: 0.5, task_success: 0.5 },
    },
  };
}

export const marketUnderstandingScenarios: EvalScenario[] = [
  makeScenario(
    'market-bull-001',
    'BTC Bull Trend Identification',
    BTC_BULL_TREND,
    ['bull_trend', 'breakout'],
    'Clear uptrend with rising volume, positive funding, price above EMAs',
  ),
  makeScenario(
    'market-bear-001',
    'BTC Bear Trend Identification',
    BTC_BEAR_TREND,
    ['bear_trend', 'breakdown'],
    'Clear downtrend with rising volume, negative funding, price below EMAs',
  ),
  makeScenario(
    'market-vol-001',
    'BTC High Volatility Identification',
    BTC_HIGH_VOLATILITY,
    ['high_volatility', 'uncertain'],
    'Wild swings, very high ATR, extreme funding, mixed signals',
  ),
  makeScenario(
    'market-range-001',
    'BTC Range-Bound Identification',
    BTC_RANGE,
    ['range', 'low_volatility'],
    'Tight range, low ATR, low ADX, neutral funding',
  ),
  makeScenario(
    'market-conflict-001',
    'BTC Conflicting Signals Detection',
    BTC_CONFLICTING,
    ['uncertain', 'high_volatility'],
    'Bullish technicals but extreme funding, rising OI, negative news catalyst',
  ),
];

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

registerEvaluator('market_understanding', (trajectory, scenario) => {
  const decision = trajectory
    .filter(s => s.action === 'decision')
    .map(s => String(s.output ?? ''))
    .join(' ')
    .toLowerCase();

  const expected = scenario.expected;
  const scores: Record<string, number> = {};

  // Regime classification
  if (expected.regime) {
    const validRegimes = Array.isArray(expected.regime) ? expected.regime : [expected.regime];
    scores.regime_accuracy = validRegimes.some(r => decision.includes(r)) ? 1 : 0;
  }

  // Evidence usage - check if trajectory contains reasoning steps with data
  const reasoningSteps = trajectory.filter(s => s.action === 'reasoning');
  scores.evidence_quality = reasoningSteps.length >= 2 ? 1 : reasoningSteps.length > 0 ? 0.5 : 0;

  // Conflict detection (for conflicting snapshot)
  if (scenario.snapshot?.funding_rate && Math.abs(scenario.snapshot.funding_rate) > 0.03) {
    const conflictResult = checkConflictDetection(
      decision,
      [{ type: 'funding', description: 'extreme funding rate indicates crowded positioning' }],
    );
    scores.conflict_detection = conflictResult.conflict_detection;
  } else {
    scores.conflict_detection = 1; // N/A for non-conflicting scenarios
  }

  // Hallucination check - ensure agent doesn't invent data points
  const allData = JSON.stringify(scenario.snapshot ?? {});
  const agentNumbers = decision.match(/\$?[\d,]+\.?\d*/g) ?? [];
  let hallucinated = 0;
  for (const num of agentNumbers) {
    const clean = num.replace(/[$,]/g, '');
    if (clean.length >= 5 && !allData.includes(clean)) {
      hallucinated++;
    }
  }
  scores.hallucination_rate = hallucinated === 0 ? 1 : Math.max(0, 1 - hallucinated * 0.2);

  // Confidence calibration
  const accuracy = scores.regime_accuracy ?? 0;
  const calResult = checkConfidenceCalibration(decision, accuracy);
  scores.confidence_calibration = calResult.calibration;

  // Composite task_success
  scores.task_success = (
    (scores.regime_accuracy ?? 0) * 0.35 +
    (scores.evidence_quality ?? 0) * 0.25 +
    (scores.hallucination_rate ?? 0) * 0.20 +
    (scores.confidence_calibration ?? 0) * 0.20
  );

  return scores;
});

registerHardFailureChecker('market_understanding', (_trajectory, scenario) => {
  const failures: string[] = [];
  // If agent claims a completely opposite regime, that's a hard failure
  // (checked via task_success < 0.2 threshold in runner)
  return failures;
});
