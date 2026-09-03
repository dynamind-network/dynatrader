/**
 * Dyna-Trader Execution Package
 *
 * Routes order execution by mode:
 *   backtest / paper  -> PaperEngine
 *   shadow            -> Evaluate only, no real execution
 *   micro_live / live -> CCXTAdapter with risk checks & approval tokens
 */

export { ExecutionRouterImpl } from "./execution-router";
export type { ExecutionRouterConfig, ExecutionEvent, PaperExecutionEvent } from "./execution-router";
