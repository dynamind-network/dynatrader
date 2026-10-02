/**
 * Dyna-Trader Risk Boundary Package
 *
 * The legacy boundary system (KillSwitchSystem, PolicyStore, RiskApprovalSystem)
 * has been removed. Production risk management uses:
 * - HaltState (runtime/halt/halt-state.ts) for trading halts
 * - PolicyEngine (subagents) for subagent policy evaluation
 * - PermissionRuntime for permission checks
 * - Risk gate in AgentCore for LLM output guardrails
 */
