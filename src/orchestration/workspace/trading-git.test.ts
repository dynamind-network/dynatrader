import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir } from "node:fs/promises";
import type { OrderIntent } from "@dyna/contracts";
import { TradingGit } from "./trading-git";

// ---------------------------------------------------------------------------
// Mock classes
// ---------------------------------------------------------------------------

class MockExecutionRouter {
  async execute(
    _intent: OrderIntent,
    _mode: string,
    _token?: string,
  ): Promise<Record<string, unknown>> {
    return {
      success: true,
      orderId: "mock-order",
      fillPrice: 100,
      fillQuantity: _intent.quantity,
    };
  }
}

class MockApprovalEngine {
  async createApprovalToken(intent: OrderIntent): Promise<string> {
    return "mock-token-" + intent.symbol;
  }

  async verifyApprovalToken(_token: string): Promise<OrderIntent | null> {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function sampleIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    venue: "test-venue",
    symbol: "BTC/USD",
    side: "buy",
    type: "market",
    quantity: 1.0,
    price: 50000,
    strategyId: "strat-001",
    mode: "paper",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TradingGit", () => {
  let testDir: string;
  let git: TradingGit;
  let router: MockExecutionRouter;
  let approval: MockApprovalEngine;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "trading-git-test-"));
    router = new MockExecutionRouter();
    approval = new MockApprovalEngine();
    git = new TradingGit(testDir, router, approval);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // 1. Stage an order
  // -----------------------------------------------------------------------

  it("should stage an order with id, status, and timestamps", async () => {
    const intent = sampleIntent();
    const staged = await git.stage(intent);

    expect(staged.id).toBeDefined();
    expect(typeof staged.id).toBe("string");
    expect(staged.id.length).toBeGreaterThan(0);
    expect(staged.intent).toEqual(intent);
    expect(staged.status).toBe("staged");
    expect(staged.stagedAt).toBeGreaterThan(0);
    expect(staged.stagedAt).toBeLessThanOrEqual(Date.now());
    expect(staged.commitHash).toBeUndefined();
    expect(staged.committedAt).toBeUndefined();

    // Verify it was persisted to disk
    const loaded = await git.getStagedOrder(staged.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(staged.id);
    expect(loaded!.status).toBe("staged");
  });

  // -----------------------------------------------------------------------
  // 2. Unstage an order
  // -----------------------------------------------------------------------

  it("should remove a staged order on unstage", async () => {
    const intent = sampleIntent();
    const staged = await git.stage(intent);

    // Verify it exists before unstage
    let loaded = await git.getStagedOrder(staged.id);
    expect(loaded).not.toBeNull();

    await git.unstage(staged.id);

    // Verify it no longer exists
    loaded = await git.getStagedOrder(staged.id);
    expect(loaded).toBeNull();
  });

  // -----------------------------------------------------------------------
  // 3. List staged orders
  // -----------------------------------------------------------------------

  it("should list all staged orders", async () => {
    const intent1 = sampleIntent({ symbol: "BTC/USD" });
    const intent2 = sampleIntent({ symbol: "ETH/USD" });
    const intent3 = sampleIntent({ symbol: "SOL/USD" });

    await git.stage(intent1);
    await git.stage(intent2);
    await git.stage(intent3);

    const staged = await git.listStaged();
    expect(staged).toHaveLength(3);
    expect(staged.map((o) => o.intent.symbol).sort()).toEqual([
      "BTC/USD",
      "ETH/USD",
      "SOL/USD",
    ]);
  });

  it("should return empty list when no orders are staged", async () => {
    const staged = await git.listStaged();
    expect(staged).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // 4. Commit staged orders
  // -----------------------------------------------------------------------

  it("should commit staged orders with hash, orderIds, and pending status", async () => {
    const intent1 = sampleIntent({ symbol: "BTC/USD" });
    const intent2 = sampleIntent({ symbol: "ETH/USD" });

    await git.stage(intent1);
    await git.stage(intent2);

    const commit = await git.commit("Initial batch", "trader-1");

    expect(commit.hash).toBeDefined();
    expect(typeof commit.hash).toBe("string");
    expect(commit.hash.length).toBe(64); // SHA-256 hex is 64 chars
    expect(commit.orderIds).toHaveLength(2);
    expect(commit.message).toBe("Initial batch");
    expect(commit.author).toBe("trader-1");
    expect(commit.committedAt).toBeGreaterThan(0);
    expect(commit.status).toBe("pending");
    expect(commit.rejectionReason).toBeUndefined();

    // Verify each staged order was updated
    for (const orderId of commit.orderIds) {
      const order = await git.getStagedOrder(orderId);
      expect(order).not.toBeNull();
      expect(order!.status).toBe("committed");
      expect(order!.commitHash).toBe(commit.hash);
      expect(order!.committedAt).toBe(commit.committedAt);
    }
  });

  // -----------------------------------------------------------------------
  // 5. Commit with no staged orders
  // -----------------------------------------------------------------------

  it("should throw when no staged orders to commit", async () => {
    await expect(git.commit("empty", "trader-1")).rejects.toThrow(
      "No staged orders to commit",
    );
  });

  // -----------------------------------------------------------------------
  // 6. Push a commit
  // -----------------------------------------------------------------------

  it("should push a commit and return success with results", async () => {
    const intent = sampleIntent();
    await git.stage(intent);
    const commit = await git.commit("Push test", "trader-1");

    const result = await git.push(commit.hash);

    expect(result.success).toBe(true);
    expect(result.commitHash).toBe(commit.hash);
    expect(result.results).toHaveLength(1);

    const r = result.results[0];
    expect(r.status).toBe("approved");
    expect(r.orderId).toBeDefined();
    expect(r.executionResult).toBeDefined();
    expect(r.executionResult!.success).toBe(true);
    expect(r.error).toBeUndefined();

    // Verify the commit status was updated
    const updatedCommit = (await git.getHistory())[0];
    expect(updatedCommit.status).toBe("pushed");

    // Verify the order status was updated
    const order = await git.getStagedOrder(commit.orderIds[0]);
    expect(order).not.toBeNull();
    expect(order!.status).toBe("pushed");
    expect(order!.pushedAt).toBeGreaterThan(0);
    expect(order!.approvalToken).toBe("mock-token-BTC/USD");
  });

  it("should fail push when commit is not pending", async () => {
    const intent = sampleIntent();
    await git.stage(intent);
    const commit = await git.commit("Already pushed", "trader-1");

    // First push succeeds
    await git.push(commit.hash);

    // Second push should fail because status is now "pushed"
    await expect(git.push(commit.hash)).rejects.toThrow(
      /not pending/,
    );
  });

  // -----------------------------------------------------------------------
  // 7. Reject a commit
  // -----------------------------------------------------------------------

  it("should mark a commit as rejected with reason", async () => {
    const intent = sampleIntent();
    await git.stage(intent);
    const commit = await git.commit("Reject test", "trader-1");

    const rejected = await git.reject(commit.hash, "Manual override");

    expect(rejected.status).toBe("rejected");
    expect(rejected.rejectionReason).toBe("Manual override");

    // Verify persisted
    const history = await git.getHistory();
    expect(history[0].status).toBe("rejected");
    expect(history[0].rejectionReason).toBe("Manual override");

    // Verify orders are marked as rejected
    for (const orderId of commit.orderIds) {
      const order = await git.getStagedOrder(orderId);
      expect(order).not.toBeNull();
      expect(order!.status).toBe("rejected");
      expect(order!.rejectionReason).toBe("Manual override");
    }
  });

  it("should throw when rejecting a non-existent commit", async () => {
    await expect(
      git.reject("nonexistent-hash", "No such commit"),
    ).rejects.toThrow("Commit not found");
  });

  // -----------------------------------------------------------------------
  // 8. Get commit history
  // -----------------------------------------------------------------------

  it("should return all commits in reverse chronological order", async () => {
    // Create two commits with distinct intents
    const intent1 = sampleIntent({ symbol: "BTC/USD" });
    const intent2 = sampleIntent({ symbol: "ETH/USD" });

    await git.stage(intent1);
    const commit1 = await git.commit("First", "trader-1");

    await git.stage(intent2);
    const commit2 = await git.commit("Second", "trader-2");

    const history = await git.getHistory();

    expect(history).toHaveLength(2);
    // Most recent first
    expect(history[0].hash).toBe(commit2.hash);
    expect(history[0].author).toBe("trader-2");
    expect(history[1].hash).toBe(commit1.hash);
    expect(history[1].author).toBe("trader-1");
  });

  it("should return empty history when no commits exist", async () => {
    const history = await git.getHistory();
    expect(history).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // 9. Get staged order by ID
  // -----------------------------------------------------------------------

  it("should return a staged order by ID", async () => {
    const intent = sampleIntent();
    const staged = await git.stage(intent);

    const loaded = await git.getStagedOrder(staged.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(staged.id);
    expect(loaded!.intent.symbol).toBe("BTC/USD");
    expect(loaded!.status).toBe("staged");
  });

  it("should return null for a non-existent order ID", async () => {
    const loaded = await git.getStagedOrder("non-existent-id");
    expect(loaded).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Push with execution failure
  // -----------------------------------------------------------------------

  it("should mark commit as rejected when execution fails", async () => {
    // Use a router that fails
    const failingRouter = {
      async execute(
        _intent: OrderIntent,
        _mode: string,
        _token?: string,
      ): Promise<Record<string, unknown>> {
        throw new Error("Insufficient liquidity");
      },
    };
    const failingGit = new TradingGit(testDir, failingRouter, approval);

    const intent = sampleIntent();
    await failingGit.stage(intent);
    const commit = await failingGit.commit("Fail test", "trader-1");

    const result = await failingGit.push(commit.hash);

    expect(result.success).toBe(false);
    expect(result.results[0].status).toBe("rejected");
    expect(result.results[0].error).toBe("Insufficient liquidity");

    const history = await failingGit.getHistory();
    expect(history[0].status).toBe("rejected");
  });
});
