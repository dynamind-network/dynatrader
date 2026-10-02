/**
 * Approval Engine Implementation
 *
 * Manages approval workflows with token-based verification, workspace
 * persistence, and full audit trail integration.
 */

import { v4 as uuidv4 } from "uuid";
import SHA256 from "crypto-js/sha256";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import {
  type ApprovalRequest,
  type ApprovalToken,
  type ApprovalEngine,
} from "@dyna/contracts";
import { AuditTrail } from "@dyna/audit";
import { MemoryStoreImpl } from "@dyna/memory-core";

export interface ApprovalEngineConfig {
  /** Base workspace path for persistence (default: process.cwd()/workspace) */
  workspacePath?: string;
  /** Secret key used to sign ApprovalTokens. If omitted, a per-install random secret is generated and persisted under {workspacePath}/secrets/. */
  secretKey?: string;
  /** Default TTL for tokens in milliseconds (default: 24 hours) */
  defaultTTL?: number;
  /**
   * Optional callback for emitting events. If provided, the engine will call
   * this for lifecycle events instead of importing the global event bus.
   */
  onEvent?: (eventType: string, data: Record<string, unknown>) => void;
}

export class ApprovalEngineImpl implements ApprovalEngine {
  private audit: AuditTrail;
  private memory: MemoryStoreImpl;
  private secretKey: string;
  private workspacePath: string;
  private defaultTTL: number;
  private onEvent?: (eventType: string, data: Record<string, unknown>) => void;

  private requests: Map<string, ApprovalRequest> = new Map();
  private tokens: Map<string, ApprovalToken> = new Map();

  constructor(config: ApprovalEngineConfig = {}) {
    this.workspacePath = config.workspacePath ?? path.join(process.cwd(), "workspace");
    this.secretKey = config.secretKey ?? ApprovalEngineImpl.loadOrCreateSecret(this.workspacePath);
    this.defaultTTL = config.defaultTTL ?? 24 * 60 * 60 * 1000; // 24 hours
    this.onEvent = config.onEvent;

    // Ensure workspace directory exists
    try {
      mkdirSync(this.workspacePath, { recursive: true });
    } catch {
      // Workspace might be temporarily unavailable (race between parallel test files)
    }
    this.memory = new MemoryStoreImpl();
    this.audit = new AuditTrail(this.workspacePath);
  }

  /**
   * Load the per-install signing secret from {workspacePath}/secrets/approval-secret.key,
   * generating and persisting a random one on first use. Never falls back to a
   * hardcoded value — tokens signed with a public constant would be forgeable.
   */
  private static loadOrCreateSecret(workspacePath: string): string {
    const envSecret = process.env["DYNA_APPROVAL_SECRET"]?.trim();
    if (envSecret) return envSecret;

    const secretsDir = path.join(workspacePath, "secrets");
    const secretFile = path.join(secretsDir, "approval-secret.key");
    try {
      if (existsSync(secretFile)) {
        const existing = readFileSync(secretFile, "utf-8").trim();
        if (existing) return existing;
      }
      mkdirSync(secretsDir, { recursive: true });
      const secret = crypto.randomBytes(32).toString("hex");
      writeFileSync(secretFile, secret, { encoding: "utf-8", mode: 0o600 });
      return secret;
    } catch {
      // If persistence fails entirely, still refuse to run with a known constant:
      // fall back to an ephemeral random secret for this process lifetime.
      return crypto.randomBytes(32).toString("hex");
    }
  }

  /**
   * Create a new approval request.
   * Persists to workspace and records audit entry.
   */
  async createRequest(
    request: Omit<ApprovalRequest, "id" | "createdAt" | "status">,
  ): Promise<string> {
    const id = uuidv4();

    const approvalRequest: ApprovalRequest = {
      id,
      ...request,
      createdAt: new Date(),
      status: "pending",
    };

    this.requests.set(id, approvalRequest);
    await this.saveRequestToWorkspace(approvalRequest);

    // Record in memory store
    await this.memory.put({
      scope: "approvals",
      kind: "approval_request",
      payload: approvalRequest,
      ts: new Date(),
    });

    // Audit trail
    await this.audit.record({
      type: "action",
      actor: request.requestedBy,
      actorType: "user",
      action: "create_approval_request",
      resource: `approvals/pending/${id}`,
      result: "pending",
      details: {
        requestId: id,
        action: request.action,
        artifactType: request.artifactType,
        artifactId: request.artifactId,
        riskLevel: request.riskLevel,
      },
    });

    this.emit("approval_request_created", {
      requestId: id,
      request: approvalRequest,
    });

    return id;
  }

  /**
   * Retrieve a single approval request by ID.
   * Checks in-memory cache first, then falls back to workspace files.
   * Auto-expires requests past their expiration date.
   */
  async getRequest(id: string): Promise<ApprovalRequest | null> {
    // Check in-memory cache first
    const cached = this.requests.get(id);
    if (cached) {
      if (cached.status === "pending" && cached.expiresAt && new Date() > cached.expiresAt) {
        cached.status = "expired";
        await this.saveRequestToWorkspace(cached);
      }
      return cached;
    }

    // Try loading from workspace files
    for (const subDir of ["pending", "resolved"]) {
      const filePath = path.join(this.workspacePath, "approvals", subDir, `${id}.json`);
      try {
        const content = await fs.readFile(filePath, "utf-8");
        const loaded = JSON.parse(content) as ApprovalRequest;
        // Restore Date objects from ISO strings
        loaded.createdAt = new Date(loaded.createdAt);
        if (loaded.expiresAt) {
          loaded.expiresAt = new Date(loaded.expiresAt);
        }
        // Auto-expire
        if (loaded.status === "pending" && loaded.expiresAt && new Date() > loaded.expiresAt) {
          loaded.status = "expired";
          await this.saveRequestToWorkspace(loaded);
        }
        this.requests.set(id, loaded);
        return loaded;
      } catch {
        // File not found in this subDir, try next
      }
    }

    return null;
  }

  /**
   * Approve a pending request and generate a signed ApprovalToken.
   * Validates the request is pending and not expired before proceeding.
   */
  async approve(
    id: string,
    approver: string,
    channel: string,
    context?: Record<string, unknown>,
  ): Promise<ApprovalToken> {
    const request = await this.getRequest(id);
    if (!request) {
      throw new Error(`Approval request not found: ${id}`);
    }
    if (request.status !== "pending") {
      throw new Error(
        `Approval request ${id} is not pending (status: ${request.status})`,
      );
    }
    if (request.expiresAt && new Date() > request.expiresAt) {
      request.status = "expired";
      await this.saveRequestToWorkspace(request);
      throw new Error(`Approval request ${id} has expired`);
    }

    // Generate a signed approval token
    const token = await this.generateToken(id, approver, channel, request);

    // Update request status
    request.status = "approved";
    await this.saveRequestToWorkspace(request);

    // Move from pending to resolved workspace directory
    await this.moveToResolved(request);

    // Record in memory store
    await this.memory.put({
      scope: "approvals",
      kind: "approval_approved",
      payload: { request, token },
      ts: new Date(),
    });

    // Audit trail
    await this.audit.record({
      type: "decision",
      actor: approver,
      actorType: "user",
      action: "approve_request",
      resource: `approvals/${id}`,
      result: "approved",
      details: {
        requestId: id,
        channel,
        tokenId: token.id,
        approver,
        context,
      },
    });

    this.emit("approval_request_approved", {
      requestId: id,
      token,
      approver,
    });

    return token;
  }

  /**
   * Reject a pending request with a reason.
   */
  async reject(id: string, approver: string, reason: string): Promise<void> {
    const request = await this.getRequest(id);
    if (!request) {
      throw new Error(`Approval request not found: ${id}`);
    }
    if (request.status !== "pending") {
      throw new Error(
        `Approval request ${id} is not pending (status: ${request.status})`,
      );
    }

    // Update request status
    request.status = "rejected";
    await this.saveRequestToWorkspace(request);
    await this.moveToResolved(request);

    // Record in memory store
    await this.memory.put({
      scope: "approvals",
      kind: "approval_rejected",
      payload: { request, reason },
      ts: new Date(),
    });

    // Audit trail
    await this.audit.record({
      type: "decision",
      actor: approver,
      actorType: "user",
      action: "reject_request",
      resource: `approvals/${id}`,
      result: "rejected",
      details: {
        requestId: id,
        reason,
        approver,
      },
    });

    this.emit("approval_request_rejected", {
      requestId: id,
      reason,
      approver,
    });
  }

  /**
   * Verify that an ApprovalToken is valid for a given action and artifact.
   * Checks: expiration, single-use status, and cryptographic signature.
   */
  async verifyToken(
    token: ApprovalToken,
    action: string,
    artifactHash?: string,
  ): Promise<boolean> {
    // Check expiration
    if (new Date() > token.expiresAt) {
      return false;
    }

    // Check single-use
    if (token.singleUse && token.used) {
      return false;
    }

    // Check action matches
    if (token.action !== action) {
      return false;
    }

    // Recompute and verify signature binding the token to action + artifactHash
    const hashInput = artifactHash ?? token.artifactHash;
    const raw = [
      token.id,
      token.approvalRequestId,
      token.action,
      token.channel,
      hashInput,
      token.createdAt.toISOString(),
      this.secretKey,
    ].join(":");
    const expectedSignature = SHA256(raw).toString();

    if (token.signature !== expectedSignature) {
      return false;
    }

    return true;
  }

  /**
   * Mark a single-use token as consumed. Throws if already used.
   */
  async useToken(tokenId: string): Promise<void> {
    const token = this.tokens.get(tokenId);
    if (!token) {
      throw new Error(`Approval token not found: ${tokenId}`);
    }
    if (token.used) {
      throw new Error(`Approval token ${tokenId} has already been used`);
    }

    token.used = true;

    // Audit trail
    await this.audit.record({
      type: "action",
      actor: "system",
      actorType: "system",
      action: "use_approval_token",
      resource: `tokens/${tokenId}`,
      result: "success",
      details: {
        tokenId,
        approvalRequestId: token.approvalRequestId,
        action: token.action,
      },
    });

    this.emit("approval_token_used", {
      tokenId,
      approvalRequestId: token.approvalRequestId,
    });
  }

  /**
   * Return all pending (non-expired) approval requests.
   * Loads from both in-memory cache and workspace persistence.
   */
  async getPendingRequests(): Promise<ApprovalRequest[]> {
    return Array.from(this.requests.values()).filter((r) => {
      if (r.status !== "pending") return false;
      if (r.expiresAt && new Date() > r.expiresAt) {
        // Auto-expire stale requests
        r.status = "expired";
        this.saveRequestToWorkspace(r).catch(() => {});
        return false;
      }
      return true;
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Emit a lifecycle event if a handler is configured.
   */
  private emit(eventType: string, data: Record<string, unknown>): void {
    if (this.onEvent) {
      try {
        this.onEvent(eventType, data);
      } catch {
        // Swallow errors from event handlers
      }
    }
  }

  /**
   * Generate a cryptographically signed ApprovalToken.
   * The SHA256 signature binds the token to its action, channel, artifact, and
   * the configured secret key.
   */
  private async generateToken(
    approvalRequestId: string,
    approvedBy: string,
    channel: string,
    request: ApprovalRequest,
  ): Promise<ApprovalToken> {
    const id = uuidv4();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + this.defaultTTL);
    const artifactHash = request.artifactId;

    const token: ApprovalToken = {
      id,
      approvalRequestId,
      approvedBy,
      channel,
      action: request.action,
      artifactType: request.artifactType,
      artifactHash,
      createdAt,
      expiresAt,
      singleUse: true,
      used: false,
      signature: "", // computed below
    };

    // Compute the signature: SHA256 of colon-joined token fields + secret
    const raw = [
      token.id,
      token.approvalRequestId,
      token.action,
      channel,
      artifactHash,
      token.createdAt.toISOString(),
      this.secretKey,
    ].join(":");
    token.signature = SHA256(raw).toString();

    this.tokens.set(id, token);
    return token;
  }

  /**
   * Save an approval request as a JSON file in the workspace.
   */
  private async saveRequestToWorkspace(request: ApprovalRequest): Promise<void> {
    const subDir = request.status === "pending" ? "pending" : "resolved";
    const dir = path.join(this.workspacePath, "approvals", subDir);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${request.id}.json`),
      JSON.stringify(request, null, 2),
    );
  }

  /**
   * Move a request from pending to resolved directory after final decision.
   */
  private async moveToResolved(request: ApprovalRequest): Promise<void> {
    const sourcePath = path.join(
      this.workspacePath,
      "approvals",
      "pending",
      `${request.id}.json`,
    );
    const destDir = path.join(this.workspacePath, "approvals", "resolved");
    const destPath = path.join(destDir, `${request.id}.json`);

    await fs.mkdir(destDir, { recursive: true });
    try {
      await fs.rename(sourcePath, destPath);
    } catch {
      // Source file may not exist; write directly to resolved
      await fs.writeFile(destPath, JSON.stringify(request, null, 2));
    }
  }
}
