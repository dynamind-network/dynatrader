/**
 * DynaMind Eval Suite — Canonical Types
 *
 * Every eval produces one EvalTrace. All families share this format.
 */

import type { ToolProfile } from './tool-profiles';

// ---------------------------------------------------------------------------
// Eval Family
// ---------------------------------------------------------------------------

export type EvalFamily =
  | 'market_understanding'
  | 'tool_selection'
  | 'trading_decision'
  | 'multi_agent'
  | 'memory'
  | 'tool_pipeline'
  | 'memory_recall'
  | 'multi_agent_coordination'
  | 'profile_resolution';

// ---------------------------------------------------------------------------
// Trajectory
// ---------------------------------------------------------------------------

export interface TrajectoryStep {
  step: number;
  action: 'tool_call' | 'reasoning' | 'decision' | 'error' | 'observation';
  tool?: string;
  input?: unknown;
  output?: unknown;
  latency_ms: number;
  timestamp: string;
  token_usage?: { prompt: number; completion: number };
}

// ---------------------------------------------------------------------------
// Execution Record
// ---------------------------------------------------------------------------

export interface ExecutionRecord {
  venue: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit' | 'stop' | 'stop-limit';
  quantity: number;
  price?: number;
  stop_price?: number;
  limit_price?: number;
  status: 'submitted' | 'filled' | 'rejected' | 'cancelled' | 'partial';
  fill_price?: number;
  fill_quantity?: number;
  fees?: number;
  slippage?: number;
  rejection_reason?: string;
}

// ---------------------------------------------------------------------------
// Eval Scores
// ---------------------------------------------------------------------------

export interface EvalScores {
  /** Universal: did the agent complete the task? 0-1 */
  task_success: number;
  /** Family-specific scores (varies by eval type) */
  family_specific: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Eval Trace (canonical output)
// ---------------------------------------------------------------------------

export interface EvalTrace {
  task_id: string;
  family: EvalFamily;
  agent: string;
  model: string;
  timestamp: string;

  trajectory: TrajectoryStep[];
  decision: string;
  execution?: ExecutionRecord;

  scores: EvalScores;
  cost_usd: number;
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  tool_calls: number;

  passed: boolean;
  hard_failures: string[];
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Scenario (input to an eval)
// ---------------------------------------------------------------------------

export interface EvalScenario {
  id: string;
  family: EvalFamily;
  name: string;
  description: string;
  tags?: string[];

  /** Tool profiles for this scenario (derived from family if not set) */
  tool_profiles?: ToolProfile[];

  /** The prompt/task given to the agent */
  task: string;

  /** Market snapshot (frozen data for the agent to use) */
  snapshot?: MarketSnapshot;

  /** Portfolio state at eval start */
  portfolio?: PortfolioState;

  /** Risk configuration */
  risk_config?: RiskConfig;

  /** Expected outputs (for deterministic scoring) */
  expected: ExpectedOutput;

  /** Hard failure conditions (zero-tolerance) */
  hard_failures?: string[];
}

// ---------------------------------------------------------------------------
// Market Snapshot
// ---------------------------------------------------------------------------

export interface MarketSnapshot {
  symbol: string;
  timestamp: string;
  price: number;
  ohlcv: OHLCVBar[];
  funding_rate?: number;
  open_interest?: number;
  orderbook?: { bids: [number, number][]; asks: [number, number][] };
  news?: NewsItem[];
  indicators?: Record<string, number>;
  meta?: Record<string, unknown>;
}

export interface OHLCVBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface NewsItem {
  timestamp: string;
  headline: string;
  source: string;
  sentiment?: 'positive' | 'negative' | 'neutral';
}

// ---------------------------------------------------------------------------
// Portfolio State
// ---------------------------------------------------------------------------

export interface PortfolioState {
  balance: number;
  equity: number;
  positions: Position[];
  daily_pnl: number;
  weekly_pnl: number;
  max_drawdown: number;
  total_pnl: number;
}

export interface Position {
  symbol: string;
  side: 'long' | 'short';
  quantity: number;
  average_price: number;
  unrealized_pnl: number;
  leverage: number;
}

// ---------------------------------------------------------------------------
// Risk Config
// ---------------------------------------------------------------------------

export interface RiskConfig {
  max_position_pct: number;
  max_leverage: number;
  max_daily_loss_pct: number;
  max_weekly_loss_pct: number;
  max_drawdown_pct: number;
  max_portfolio_concentration_pct: number;
  circuit_breakers?: {
    daily_loss_threshold: number;
    weekly_loss_threshold: number;
    market_move_threshold: number;
    llm_failure_threshold: number;
  };
}

// ---------------------------------------------------------------------------
// Expected Output (for deterministic scoring)
// ---------------------------------------------------------------------------

export interface ExpectedOutput {
  /** Expected decision label (e.g., 'LONG', 'SHORT', 'HOLD', 'bull_trend') */
  decision?: string | string[];

  /** Expected regime classification */
  regime?: string | string[];

  /** Expected tools that should be called */
  tools_required?: string[];

  /** Expected tools that should NOT be called */
  tools_forbidden?: string[];

  /** Expected risk violations to check */
  risk_violations?: string[];

  /** Hard failure labels */
  hard_failures?: string[];

  /** Custom scoring function (for complex evals) */
  custom_scorer?: (trace: EvalTrace, scenario: EvalScenario) => Record<string, number>;

  /** Minimum scores to pass (per dimension) */
  pass_thresholds?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Eval Report
// ---------------------------------------------------------------------------

export interface EvalReport {
  suite_name: string;
  timestamp: string;
  model: string;
  agent: string;

  traces: EvalTrace[];

  summary: {
    total: number;
    passed: number;
    failed: number;
    hard_failures: number;
    pass_rate: number;
  };

  family_scores: Record<EvalFamily, {
    count: number;
    avg_task_success: number;
    avg_family_specific: Record<string, number>;
  }>;

  cross_cutting: {
    avg_cost_usd: number;
    avg_latency_ms: number;
    avg_tokens: number;
    avg_tool_calls: number;
    total_cost_usd: number;
    total_latency_ms: number;
  };

  overall_score: number;
}

// ---------------------------------------------------------------------------
// Evaluator Function Types
// ---------------------------------------------------------------------------

export type DeterministicEvaluator = (
  trajectory: TrajectoryStep[],
  scenario: EvalScenario,
  trace?: EvalTrace,
) => Record<string, number>;

export type HardFailureChecker = (
  trajectory: TrajectoryStep[],
  scenario: EvalScenario,
) => string[];
