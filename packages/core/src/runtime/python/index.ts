/**
 * Python runtime — bridges the Dyna-Trader kernel to strategy plugins running
 * in the Python DynaTrader SDK over JSON-RPC stdio.
 */

export { PythonStrategyBridge, PythonBridgeError } from "./strategy-bridge";
export type {
  StrategySignal,
  BacktestMetrics,
  RiskGate,
  PluginInfo,
  HealthStatus,
  Notification,
  ChildStream,
  ChildStdin,
  ChildProcessLike,
  SpawnOptionsLike,
  SpawnFn,
  PythonBridgeOptions,
} from "./strategy-bridge";

export { createPythonStrategyPlugin } from "./strategy-plugin";
export type {
  PythonStrategyService,
  PythonStrategyPluginOptions,
} from "./strategy-plugin";

export { PythonStrategyGovernance, DefaultHardGate } from "./strategy-governance";
export type {
  StrategyApprovalSystem,
  StrategyApprovalType,
  ApprovalPriority,
  HardGate,
  PythonStrategyGovernanceConfig,
  StrategyEvaluation,
  StrategyEvaluationDecision,
} from "./strategy-governance";