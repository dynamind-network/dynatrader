/**
 * Dyna-Trader Risk Core Package
 *
 * Standalone risk functions: circuit breakers, hard risk gate.
 * The agent-facing risk engine (DynaTraderRiskEngine) was removed.
 * Risk assessment is now agent-driven via tools + Python quant libraries.
 */

export * from "./circuit-breakers";
export * from "./hard-gate";

// Re-export key types for convenience
export type {
  CircuitBreakerState,
  CircuitBreakerConfig,
} from "./circuit-breakers";
export type {
  RiskGateRequest,
  RiskGateResult,
} from "./hard-gate";
