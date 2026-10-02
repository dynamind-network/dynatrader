/**
 * Dyna-Trader Backtest Package
 *
 * Provides backtesting and paper trading capabilities.
 */

export * from "./paper-engine";

// Re-export key types for convenience
export type { BacktestConfig, BacktestResult, BacktestSummary } from "./paper-engine";