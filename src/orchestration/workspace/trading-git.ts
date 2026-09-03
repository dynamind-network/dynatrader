/**
 * TradingGit — Git-like workflow for trading orders
 *
 * Implements a stage/commit/push workflow for trading orders with
 * approval-based execution. Mirrors OpenAlice's "Trading as Git" concept.
 *
 * Staged orders are persisted to disk under {workspacePath}/trading-git/staged/
 * Commits are persisted under {workspacePath}/trading-git/commits/
 */

import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { OrderIntent } from "@dyna/contracts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type StagingStatus =
  | "staged"
  | "committed"
  | "pushed"
  | "rejected"
  | "synced";

export interface StagedOrder {
  id: string;
  intent: OrderIntent;
  stagedAt: number;
  status: StagingStatus;
  commitHash?: string;
  committedAt?: number;
  pushedAt?: number;
  rejectionReason?: string;
  approvalToken?: string;
}

export interface Commit {
  hash: string;
  orderIds: string[];
  message: string;
  author: string;
  committedAt: number;
  status: "pending" | "pushed" | "rejected";
  rejectionReason?: string;
}

export interface PushResult {
  success: boolean;
  commitHash: string;
  results: Array<{
    orderId: string;
    status: "approved" | "rejected";
    executionResult?: Record<string, unknown>;
    error?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Dependency interfaces
//
// TradingGit expects its collaborators to conform to these minimal interfaces
// so it remains decoupled from concrete implementations.
// ---------------------------------------------------------------------------

export interface IExecutionRouter {
  execute(
    intent: OrderIntent,
    mode: string,
    token?: string,
  ): Promise<Record<string, unknown>>;
}

export interface IApprovalEngine {
  createApprovalToken(intent: OrderIntent): Promise<string>;
  verifyApprovalToken(token: string): Promise<OrderIntent | null>;
}

// ---------------------------------------------------------------------------
// TradingGit
// ---------------------------------------------------------------------------

export class TradingGit {
  private stagedDir: string;
  private commitsDir: string;
  private executionRouter: IExecutionRouter;
  private approvalEngine: IApprovalEngine;

  constructor(
    workspacePath: string,
    executionRouter: IExecutionRouter,
    approvalEngine: IApprovalEngine,
  ) {
    this.stagedDir = join(workspacePath, "trading-git", "staged");
    this.commitsDir = join(workspacePath, "trading-git", "commits");
    this.executionRouter = executionRouter;
    this.approvalEngine = approvalEngine;
  }

  // -----------------------------------------------------------------------
  // Stage
  // -----------------------------------------------------------------------

  async stage(intent: OrderIntent): Promise<StagedOrder> {
    await mkdir(this.stagedDir, { recursive: true });

    const order: StagedOrder = {
      id: randomUUID(),
      intent,
      stagedAt: Date.now(),
      status: "staged",
    };

    await writeFile(
      join(this.stagedDir, `${order.id}.json`),
      JSON.stringify(order, null, 2),
      "utf-8",
    );

    return order;
  }

  // -----------------------------------------------------------------------
  // Unstage
  // -----------------------------------------------------------------------

  async unstage(orderId: string): Promise<void> {
    await unlink(join(this.stagedDir, `${orderId}.json`));
  }

  // -----------------------------------------------------------------------
  // List staged
  // -----------------------------------------------------------------------

  async listStaged(): Promise<StagedOrder[]> {
    try {
      const files = await readdir(this.stagedDir);
      const orders: StagedOrder[] = [];

      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const content = await readFile(
          join(this.stagedDir, file),
          "utf-8",
        );
        orders.push(JSON.parse(content) as StagedOrder);
      }

      return orders;
    } catch {
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // Commit
  // -----------------------------------------------------------------------

  async commit(message: string, author: string): Promise<Commit> {
    const staged = await this.listStaged();
    const stagedOrders = staged.filter((o) => o.status === "staged");

    if (stagedOrders.length === 0) {
      throw new Error("No staged orders to commit");
    }

    const orderIds = stagedOrders.map((o) => o.id).sort();
    const committedAt = Date.now();

    // SHA-256 hash over the full content of the commit
    const content = orderIds.join(",") + message + author + String(committedAt);
    const hash = createHash("sha256").update(content).digest("hex");

    const commit: Commit = {
      hash,
      orderIds,
      message,
      author,
      committedAt,
      status: "pending",
    };

    // Persist directories before writing
    await mkdir(this.commitsDir, { recursive: true });

    // Update each staged order with commit metadata
    for (const order of stagedOrders) {
      order.status = "committed";
      order.commitHash = hash;
      order.committedAt = committedAt;
      await writeFile(
        join(this.stagedDir, `${order.id}.json`),
        JSON.stringify(order, null, 2),
        "utf-8",
      );
    }

    // Persist commit
    await writeFile(
      join(this.commitsDir, `${hash}.json`),
      JSON.stringify(commit, null, 2),
      "utf-8",
    );

    return commit;
  }

  // -----------------------------------------------------------------------
  // Push
  // -----------------------------------------------------------------------

  async push(commitHash: string): Promise<PushResult> {
    const commit = await this.getCommit(commitHash);

    if (!commit) {
      throw new Error(`Commit not found: ${commitHash}`);
    }
    if (commit.status !== "pending") {
      throw new Error(
        `Commit ${commitHash} is not pending (status: ${commit.status})`,
      );
    }

    const results: PushResult["results"] = [];
    let allSucceeded = true;
    let failureReason = "";

    for (const orderId of commit.orderIds) {
      const staged = await this.getStagedOrder(orderId);

      if (!staged) {
        results.push({
          orderId,
          status: "rejected",
          error: "Staged order not found",
        });
        allSucceeded = false;
        continue;
      }

      try {
        // Create single-use approval token for this order
        const token =
          await this.approvalEngine.createApprovalToken(staged.intent);

        // Execute through the router with the approval token
        const executionResult = await this.executionRouter.execute(
          staged.intent,
          staged.intent.mode,
          token,
        );

        staged.approvalToken = token;

        // Persist approval token immediately so follow-up reads see it
        await writeFile(
          join(this.stagedDir, `${orderId}.json`),
          JSON.stringify(staged, null, 2),
          "utf-8",
        );

        results.push({
          orderId,
          status: "approved",
          executionResult,
        });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        if (!failureReason) failureReason = msg;
        allSucceeded = false;
        results.push({
          orderId,
          status: "rejected",
          error: msg,
        });
      }
    }

    // Update commit and order statuses based on overall result
    if (allSucceeded) {
      commit.status = "pushed";
      const pushedAt = Date.now();

      for (const orderId of commit.orderIds) {
        const staged = await this.getStagedOrder(orderId);
        if (staged) {
          staged.status = "pushed";
          staged.pushedAt = pushedAt;
          await writeFile(
            join(this.stagedDir, `${orderId}.json`),
            JSON.stringify(staged, null, 2),
            "utf-8",
          );
        }
      }
    } else {
      commit.status = "rejected";
      commit.rejectionReason = failureReason || "Some orders failed";

      for (const orderId of commit.orderIds) {
        const staged = await this.getStagedOrder(orderId);
        if (staged) {
          staged.status = "rejected";
          staged.rejectionReason = failureReason;
          await writeFile(
            join(this.stagedDir, `${orderId}.json`),
            JSON.stringify(staged, null, 2),
            "utf-8",
          );
        }
      }
    }

    // Persist updated commit
    await writeFile(
      join(this.commitsDir, `${commitHash}.json`),
      JSON.stringify(commit, null, 2),
      "utf-8",
    );

    return {
      success: allSucceeded,
      commitHash,
      results,
    };
  }

  // -----------------------------------------------------------------------
  // Reject
  // -----------------------------------------------------------------------

  async reject(commitHash: string, reason: string): Promise<Commit> {
    const commit = await this.getCommit(commitHash);

    if (!commit) {
      throw new Error(`Commit not found: ${commitHash}`);
    }

    commit.status = "rejected";
    commit.rejectionReason = reason;

    // Update all orders in the commit to rejected
    for (const orderId of commit.orderIds) {
      const staged = await this.getStagedOrder(orderId);
      if (staged) {
        staged.status = "rejected";
        staged.rejectionReason = reason;
        await writeFile(
          join(this.stagedDir, `${orderId}.json`),
          JSON.stringify(staged, null, 2),
          "utf-8",
        );
      }
    }

    // Persist updated commit
    await writeFile(
      join(this.commitsDir, `${commitHash}.json`),
      JSON.stringify(commit, null, 2),
      "utf-8",
    );

    return commit;
  }

  // -----------------------------------------------------------------------
  // History
  // -----------------------------------------------------------------------

  async getHistory(): Promise<Commit[]> {
    try {
      const files = await readdir(this.commitsDir);
      const commits: Commit[] = [];

      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const content = await readFile(
          join(this.commitsDir, file),
          "utf-8",
        );
        commits.push(JSON.parse(content) as Commit);
      }

      // Most recent first
      commits.sort((a, b) => b.committedAt - a.committedAt);
      return commits;
    } catch {
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // Get staged order by ID
  // -----------------------------------------------------------------------

  async getStagedOrder(orderId: string): Promise<StagedOrder | null> {
    try {
      const content = await readFile(
        join(this.stagedDir, `${orderId}.json`),
        "utf-8",
      );
      return JSON.parse(content) as StagedOrder;
    } catch {
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async getCommit(hash: string): Promise<Commit | null> {
    try {
      const content = await readFile(
        join(this.commitsDir, `${hash}.json`),
        "utf-8",
      );
      return JSON.parse(content) as Commit;
    } catch {
      return null;
    }
  }
}
