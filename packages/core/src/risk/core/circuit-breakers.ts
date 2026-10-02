/**
 * Circuit Breakers
 *
 * Hard stops based on:
 * - Daily loss >5%
 * - Weekly loss >10%
 * - Market move >10%
 * - LLM failure cascade
 * - Daily gas spend limit
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Circuit breaker state */
export interface CircuitBreakerState {
  dailyLoss: boolean;
  weeklyLoss: boolean;
  marketCircuit: boolean;
  llmFailure: boolean;
  /** Optional for callers using pre-gas-limit breaker state snapshots. */
  gasSpendDaily?: boolean;
  lastTriggered?: string;
  triggerReason?: string;
}

/** Circuit breaker configuration */
export interface CircuitBreakerConfig {
  /** Daily loss % that triggers halt (0.05 = 5%) */
  dailyLossThreshold: number;
  /** Weekly loss % that triggers halt (0.10 = 10%) */
  weeklyLossThreshold: number;
  /** Market move % that triggers circuit (0.10 = 10%) */
  marketMoveThreshold: number;
  /** Number of consecutive LLM failures to trigger */
  llmFailureThreshold: number;
  /** Auto-reset after X minutes */
  autoResetMinutes: number;
  /** Max daily gas spend in native currency (e.g., 0.5 ETH) */
  maxDailyGasSpend: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default circuit breaker configuration */
export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  dailyLossThreshold: 0.05,
  weeklyLossThreshold: 0.10,
  marketMoveThreshold: 0.10,
  llmFailureThreshold: 3,
  autoResetMinutes: 60,
  maxDailyGasSpend: 0.5,
};

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Check if trading is allowed based on circuit breaker state.
 * @param state Current circuit breaker state
 * @returns Object with allowed status and reason
 */
export function isTradingAllowed(
  state: CircuitBreakerState,
): { allowed: boolean; reason?: string } {
  if (state.dailyLoss) {
    return { allowed: false, reason: "Daily loss circuit breaker triggered" };
  }
  if (state.weeklyLoss) {
    return { allowed: false, reason: "Weekly loss circuit breaker triggered" };
  }
  if (state.marketCircuit) {
    return { allowed: false, reason: "Market circuit breaker triggered" };
  }
  if (state.llmFailure) {
    return { allowed: false, reason: "LLM failure circuit breaker triggered" };
  }
  if (state.gasSpendDaily) {
    return { allowed: false, reason: "Daily gas spend limit reached" };
  }
  return { allowed: true };
}

/**
 * Update circuit breaker state based on portfolio performance.
 * @param state Current state
 * @param dailyPnl Daily PnL
 * @param weeklyPnl Weekly PnL
 * @param portfolioValue Current portfolio value
 * @param config Circuit breaker config
 * @param dailyGasSpend Optional: today's cumulative gas spend in native currency
 * @returns Updated state
 */
export function updateCircuitBreakers(
  state: CircuitBreakerState,
  dailyPnl: number,
  weeklyPnl: number,
  portfolioValue: number,
  config: CircuitBreakerConfig = DEFAULT_CIRCUIT_BREAKER_CONFIG,
  dailyGasSpend?: number,
): CircuitBreakerState {
  const dailyLossPct = Math.abs(Math.min(0, dailyPnl)) / portfolioValue;
  const weeklyLossPct = Math.abs(Math.min(0, weeklyPnl)) / portfolioValue;

  const gasTriggered = dailyGasSpend !== undefined && dailyGasSpend > config.maxDailyGasSpend;

  return {
    ...state,
    dailyLoss: dailyLossPct > config.dailyLossThreshold,
    weeklyLoss: weeklyLossPct > config.weeklyLossThreshold,
    gasSpendDaily: gasTriggered,
    lastTriggered:
      state.dailyLoss || state.weeklyLoss || gasTriggered
        ? new Date().toISOString()
        : state.lastTriggered,
    triggerReason: state.dailyLoss
      ? "daily_loss"
      : state.weeklyLoss
        ? "weekly_loss"
        : gasTriggered
          ? "gas_spend_limit"
          : state.triggerReason,
  };
}
