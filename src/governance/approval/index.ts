/**
 * Dyna-Trader Approval Engine Package
 *
 * Provides approval workflow management with token-based verification,
 * workspace persistence, and full audit trail integration.
 *
 * Example usage:
 * ```typescript
 * const engine = new ApprovalEngineImpl({
 *   workspacePath: "./workspace",
 *   secretKey: "my-secret",
 * });
 * const id = await engine.createRequest({
 *   action: "deploy-strategy",
 *   artifactType: "strategy",
 *   artifactId: "strat-001",
 *   riskLevel: "high",
 *   requestedBy: "trader-001",
 *   requiredApprovals: ["risk-manager"],
 *   expiresAt: new Date(Date.now() + 3600000),
 *   summary: "Deploy MA Crossover strategy",
 * });
 * const token = await engine.approve(id, "risk-manager", "slack");
 * const valid = await engine.verifyToken(token, "deploy-strategy");
 * ```
 */

export { ApprovalEngineImpl } from "./approval-engine";
export type { ApprovalEngineConfig } from "./approval-engine";
