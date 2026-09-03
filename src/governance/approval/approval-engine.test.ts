/**
 * Tests for the Approval Engine
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import { ApprovalEngineImpl } from "./approval-engine";
import type { ApprovalRequest } from "@dyna/contracts";

const TEST_WORKSPACE = path.join(
  process.cwd(),
  "workspace",
  "test-approval-engine",
);

describe("ApprovalEngineImpl", () => {
  let engine: ApprovalEngineImpl;

  beforeEach(() => {
    engine = new ApprovalEngineImpl({
      workspacePath: TEST_WORKSPACE,
      secretKey: "test-secret-key",
      defaultTTL: 24 * 60 * 60 * 1000, // 24 hours
    });
  });

  afterEach(async () => {
    // Clean up test workspace
    try {
      await fs.rm(TEST_WORKSPACE, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  function createSampleRequest(
    overrides: Partial<Omit<ApprovalRequest, "id" | "createdAt" | "status">> = {},
  ): Omit<ApprovalRequest, "id" | "createdAt" | "status"> {
    return {
      action: "deploy-strategy",
      artifactType: "strategy",
      artifactId: "strat-ma-crossover-001",
      riskLevel: "medium",
      requestedBy: "trader-001",
      requiredApprovals: ["risk-manager", "head-trader"],
      expiresAt: new Date(Date.now() + 3600000), // 1 hour from now
      summary: "Deploy MA Crossover strategy to paper trading",
      context: { strategyId: "strat-ma-crossover-001" },
      ...overrides,
    };
  }

  // ---------------------------------------------------------------------------
  // 1. Should create approval requests
  // ---------------------------------------------------------------------------
  it("should create approval requests", async () => {
    const requestData = createSampleRequest();
    const requestId = await engine.createRequest(requestData);

    expect(requestId).toBeDefined();
    expect(typeof requestId).toBe("string");
    expect(requestId.length).toBeGreaterThan(0);

    // Verify it exists in the system
    const fetched = await engine.getRequest(requestId);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(requestId);
    expect(fetched!.action).toBe("deploy-strategy");
    expect(fetched!.artifactId).toBe("strat-ma-crossover-001");
    expect(fetched!.status).toBe("pending");
    expect(fetched!.riskLevel).toBe("medium");
    expect(fetched!.requestedBy).toBe("trader-001");
  });

  // ---------------------------------------------------------------------------
  // 2. Should approve requests and generate tokens
  // ---------------------------------------------------------------------------
  it("should approve requests and generate tokens", async () => {
    const requestData = createSampleRequest();
    const requestId = await engine.createRequest(requestData);

    const token = await engine.approve(
      requestId,
      "risk-manager",
      "slack",
    );

    // Verify token properties
    expect(token).toBeDefined();
    expect(token.id).toBeDefined();
    expect(token.approvalRequestId).toBe(requestId);
    expect(token.approvedBy).toBe("risk-manager");
    expect(token.channel).toBe("slack");
    expect(token.action).toBe("deploy-strategy");
    expect(token.artifactType).toBe("strategy");
    expect(token.artifactHash).toBe("strat-ma-crossover-001");
    expect(token.singleUse).toBe(true);
    expect(token.used).toBe(false);
    expect(token.signature).toBeDefined();
    expect(token.signature.length).toBeGreaterThan(0);

    // Verify the token is a hex string (SHA256 output)
    expect(token.signature).toMatch(/^[0-9a-f]{64}$/);

    // Verify request was marked as approved
    const fetched = await engine.getRequest(requestId);
    expect(fetched).not.toBeNull();
    expect(fetched!.status).toBe("approved");
  });

  // ---------------------------------------------------------------------------
  // 3. Should reject requests
  // ---------------------------------------------------------------------------
  it("should reject requests", async () => {
    const requestData = createSampleRequest();
    const requestId = await engine.createRequest(requestData);

    await engine.reject(requestId, "risk-manager", "Strategy does not meet risk criteria");

    // Verify request status
    const fetched = await engine.getRequest(requestId);
    expect(fetched).not.toBeNull();
    expect(fetched!.status).toBe("rejected");
  });

  // ---------------------------------------------------------------------------
  // 4. Should verify valid tokens
  // ---------------------------------------------------------------------------
  it("should verify valid tokens", async () => {
    const requestData = createSampleRequest();
    const requestId = await engine.createRequest(requestData);

    const token = await engine.approve(requestId, "risk-manager", "slack");

    // Verify the token with matching action and no extra artifactHash
    const isValid = await engine.verifyToken(token, "deploy-strategy");
    expect(isValid).toBe(true);

    // Verify with explicit artifactHash matching
    const isValidWithHash = await engine.verifyToken(
      token,
      "deploy-strategy",
      "strat-ma-crossover-001",
    );
    expect(isValidWithHash).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 5. Should reject expired tokens
  // ---------------------------------------------------------------------------
  it("should reject expired tokens", async () => {
    // Create engine with 0ms TTL so tokens expire immediately
    const instantExpiryEngine = new ApprovalEngineImpl({
      workspacePath: path.join(TEST_WORKSPACE, "instant-expiry"),
      secretKey: "test-secret-key",
      defaultTTL: 0, // tokens expire immediately
    });

    const requestData = createSampleRequest();
    const requestId = await instantExpiryEngine.createRequest(requestData);

    const token = await instantExpiryEngine.approve(
      requestId,
      "risk-manager",
      "slack",
    );

    // Token should already be expired
    const isValid = await instantExpiryEngine.verifyToken(token, "deploy-strategy");
    expect(isValid).toBe(false);

    // Cleanup
    try {
      await fs.rm(instantExpiryEngine["workspacePath"], { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // ---------------------------------------------------------------------------
  // 6. Should reject used tokens (single use)
  // ---------------------------------------------------------------------------
  it("should reject used tokens", async () => {
    const requestData = createSampleRequest();
    const requestId = await engine.createRequest(requestData);

    const token = await engine.approve(requestId, "risk-manager", "slack");

    // Verify token is valid first
    const isValidBefore = await engine.verifyToken(token, "deploy-strategy");
    expect(isValidBefore).toBe(true);

    // Use the token
    await engine.useToken(token.id);

    // Token should now be invalid (used)
    const isValidAfter = await engine.verifyToken(token, "deploy-strategy");
    expect(isValidAfter).toBe(false);

    // Using again should throw
    await expect(engine.useToken(token.id)).rejects.toThrow(/already been used/);
  });

  // ---------------------------------------------------------------------------
  // 7. Should reject tokens with wrong artifact hash
  // ---------------------------------------------------------------------------
  it("should reject tokens with wrong artifact hash", async () => {
    const requestData = createSampleRequest();
    const requestId = await engine.createRequest(requestData);

    const token = await engine.approve(requestId, "risk-manager", "slack");

    // Verify with wrong artifactHash - should fail signature check
    const isValid = await engine.verifyToken(
      token,
      "deploy-strategy",
      "wrong-artifact-hash",
    );
    expect(isValid).toBe(false);

    // Verify with wrong action
    const isValidWrongAction = await engine.verifyToken(token, "wrong-action");
    expect(isValidWrongAction).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 8. Should get pending requests
  // ---------------------------------------------------------------------------
  it("should get pending requests", async () => {
    // Create multiple requests
    const req1 = await engine.createRequest(
      createSampleRequest({ artifactId: "strat-001", summary: "First strategy" }),
    );
    const req2 = await engine.createRequest(
      createSampleRequest({
        artifactId: "strat-002",
        summary: "Second strategy",
        riskLevel: "high",
      }),
    );
    const req3 = await engine.createRequest(
      createSampleRequest({
        artifactId: "strat-003",
        summary: "Third strategy",
        riskLevel: "critical",
      }),
    );

    // All three should be pending
    let pending = await engine.getPendingRequests();
    expect(pending.length).toBe(3);

    // Approve one
    await engine.approve(req2, "risk-manager", "email");

    // Now only two should be pending
    pending = await engine.getPendingRequests();
    expect(pending.length).toBe(2);

    const pendingIds = pending.map((r) => r.id);
    expect(pendingIds).toContain(req1);
    expect(pendingIds).toContain(req3);
    expect(pendingIds).not.toContain(req2);
  });

  // ---------------------------------------------------------------------------
  // 9. Should handle request expiration
  // ---------------------------------------------------------------------------
  it("should handle request expiration", async () => {
    const requestData = createSampleRequest({
      expiresAt: new Date(Date.now() - 1000), // expired 1 second ago
    });
    const requestId = await engine.createRequest(requestData);

    // Trying to approve an expired request should throw
    // The request gets auto-expired on getRequest(), so the error
    // will say "not pending" rather than "has expired"
    await expect(
      engine.approve(requestId, "risk-manager", "slack"),
    ).rejects.toThrow(/not pending|has expired/);

    // The request should be auto-expired
    const fetched = await engine.getRequest(requestId);
    expect(fetched).not.toBeNull();
    expect(fetched!.status).toBe("expired");

    // Expired requests should not appear in pending
    const pending = await engine.getPendingRequests();
    const expiredInPending = pending.filter((r) => r.id === requestId);
    expect(expiredInPending.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 10. Should integrate with audit trail
  // ---------------------------------------------------------------------------
  it("should integrate with audit trail", async () => {
    // Create a request
    const requestId = await engine.createRequest(createSampleRequest());

    // Approve it
    const token = await engine.approve(requestId, "risk-manager", "slack");

    // Use the token
    await engine.useToken(token.id);

    // Check audit trail file exists
    const auditFilePath = path.join(TEST_WORKSPACE, "audit.jsonl");
    const content = await fs.readFile(auditFilePath, "utf-8");
    const lines = content.trim().split("\n").filter((l) => l);

    // Should have at least 3 audit events: create, approve, useToken
    expect(lines.length).toBeGreaterThanOrEqual(3);

    // Parse events and verify the types
    const events = lines.map((l) => JSON.parse(l));

    const createEvents = events.filter(
      (e: any) => e.action === "create_approval_request",
    );
    const approveEvents = events.filter(
      (e: any) => e.action === "approve_request",
    );
    const useTokenEvents = events.filter(
      (e: any) => e.action === "use_approval_token",
    );

    expect(createEvents.length).toBe(1);
    expect(approveEvents.length).toBe(1);
    expect(useTokenEvents.length).toBe(1);

    // Verify event properties
    expect(createEvents[0].actor).toBe("trader-001");
    expect(createEvents[0].result).toBe("pending");

    expect(approveEvents[0].actor).toBe("risk-manager");
    expect(approveEvents[0].result).toBe("approved");

    expect(useTokenEvents[0].actor).toBe("system");
    expect(useTokenEvents[0].result).toBe("success");
    expect(useTokenEvents[0].details.tokenId).toBe(token.id);
  });

  // ---------------------------------------------------------------------------
  // Error handling: approve non-existent request
  // ---------------------------------------------------------------------------
  it("should throw when approving a non-existent request", async () => {
    await expect(
      engine.approve("non-existent-id", "risk-manager", "slack"),
    ).rejects.toThrow(/not found/);
  });

  // ---------------------------------------------------------------------------
  // Error handling: reject non-existent request
  // ---------------------------------------------------------------------------
  it("should throw when rejecting a non-existent request", async () => {
    await expect(
      engine.reject("non-existent-id", "risk-manager", "No reason"),
    ).rejects.toThrow(/not found/);
  });

  // ---------------------------------------------------------------------------
  // Error handling: approve already rejected request
  // ---------------------------------------------------------------------------
  it("should throw when approving an already rejected request", async () => {
    const requestId = await engine.createRequest(createSampleRequest());
    await engine.reject(requestId, "risk-manager", "Not suitable");

    await expect(
      engine.approve(requestId, "head-trader", "slack"),
    ).rejects.toThrow(/not pending/);
  });

  // ---------------------------------------------------------------------------
  // Error handling: token not found for use
  // ---------------------------------------------------------------------------
  it("should throw when using a non-existent token", async () => {
    await expect(
      engine.useToken("non-existent-token-id"),
    ).rejects.toThrow(/not found/);
  });

  // ---------------------------------------------------------------------------
  // Persistence: requests survive across engine instances
  // ---------------------------------------------------------------------------
  it("should persist requests across engine instances", async () => {
    // Create a request with first engine instance
    const requestId = await engine.createRequest(createSampleRequest());

    // Create a new engine instance pointing to the same workspace
    const engine2 = new ApprovalEngineImpl({
      workspacePath: TEST_WORKSPACE,
      secretKey: "test-secret-key",
    });

    // The request should be loadable from the second engine
    const fetched = await engine2.getRequest(requestId);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(requestId);
    expect(fetched!.status).toBe("pending");
    expect(fetched!.action).toBe("deploy-strategy");
    expect(fetched!.artifactType).toBe("strategy");

    // Pending requests should also be discoverable
    const pending = await engine2.getPendingRequests();
    const found = pending.find((r) => r.id === requestId);
    expect(found).toBeDefined();
  });
});
