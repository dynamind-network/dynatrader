/**
 * Session Management
 *
 * Handles user sessions, authentication, and session state
 */

import { randomUUID } from 'node:crypto';
import { MemoryStoreImpl } from "@dyna/memory-core";
import { eventBus } from "@dyna/event-bus";
import type { ChannelEnvelope } from "@dyna/contracts";

export interface Session {
  id: string;
  userId: string;
  accountId: string;
  metadata: SessionMetadata;
  state: SessionState;
  createdAt: Date;
  lastActivity: Date;
  expiresAt: Date;
  pairing?: SessionPairing;
  sandbox?: boolean;
  blockReason?: string;
}

export interface SessionMetadata {
  userAgent?: string;
  ipAddress?: string;
  deviceType?: "desktop" | "mobile" | "api";
  location?: string;
  permissions: string[];
  riskLevel: "low" | "medium" | "high";
}

export interface SessionState {
  connected: boolean;
  lastMessage?: Date;
  messageCount: number;
  errorCount: number;
  blocked: boolean;
  blockReason?: string;
}

export interface SessionPairing {
  channelId: string;
  pairedAt: Date;
  expiresAt: Date;
  permissions: string[];
}

export interface SessionEvent {
  type: "connected" | "disconnected" | "message" | "error" | "blocked" | "expired";
  sessionId: string;
  timestamp: Date;
  data?: unknown;
}

export class SessionManager {
  private memory: MemoryStoreImpl;
  private sessions: Map<string, Session> = new Map();
  private pairingTimeout: number = 24 * 60 * 60 * 1000; // 24 hours
  private sessionTimeout: number = 30 * 60 * 1000; // 30 minutes of inactivity

  constructor(memory: MemoryStoreImpl) {
    this.memory = memory;
    this.loadSessions();
  }

  /**
   * Create a new session
   */
  async createSession(
    userId: string,
    accountId: string,
    metadata: Partial<SessionMetadata>
  ): Promise<string> {
    const id = `session-${Date.now()}-${randomUUID()}`;
    const now = new Date();

    const session: Session = {
      id,
      userId,
      accountId,
      metadata: {
        userAgent: metadata.userAgent,
        ipAddress: metadata.ipAddress,
        deviceType: metadata.deviceType || "api",
        location: metadata.location,
        permissions: metadata.permissions || ["*"],
        riskLevel: metadata.riskLevel || "medium",
      },
      state: {
        connected: false,
        messageCount: 0,
        errorCount: 0,
        blocked: false,
      },
      createdAt: now,
      lastActivity: now,
      expiresAt: new Date(now.getTime() + this.sessionTimeout),
    };

    this.sessions.set(id, session);

    // Store in memory
    await this.memory.put({
      scope: "sessions",
      kind: "session_created",
      payload: session,
      ts: now,
    });

    await eventBus.emit("session_created", { session });

    return id;
  }

  /**
   * Connect a session
   */
  async connectSession(sessionId: string, metadata: { userAgent?: string; ipAddress?: string } = {}): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (session.state.blocked) {
      throw new Error(`Session is blocked: ${session.blockReason}`);
    }

    session.state.connected = true;
    session.lastActivity = new Date();
    session.metadata.userAgent = metadata.userAgent || session.metadata.userAgent;
    session.metadata.ipAddress = metadata.ipAddress || session.metadata.ipAddress;

    this.sessions.set(sessionId, session);

    await eventBus.emit("session_connected", { session });

    // Store update
    await this.memory.put({
      scope: "sessions",
      kind: "session_connected",
      payload: session,
      ts: new Date(),
    });
  }

  /**
   * Disconnect a session
   */
  async disconnectSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.state.connected = false;
    this.sessions.set(sessionId, session);

    await eventBus.emit("session_disconnected", { session });

    // Store update
    await this.memory.put({
      scope: "sessions",
      kind: "session_disconnected",
      payload: session,
      ts: new Date(),
    });
  }

  /**
   * Process a message from a session
   */
  async processMessage(sessionId: string, envelope: ChannelEnvelope): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (session.state.blocked) {
      throw new Error(`Session is blocked: ${session.blockReason}`);
    }

    // Update session state
    session.lastActivity = new Date();
    session.state.messageCount++;
    session.state.lastMessage = session.lastActivity;

    // Check session permissions
    if (!this.hasPermission(session, envelope.channel)) {
      throw new Error(`Permission denied for channel: ${envelope.channel}`);
    }

    // Store message
    await this.memory.put({
      scope: "sessions",
      kind: "session_message",
      payload: { sessionId, envelope, timestamp: session.lastActivity },
      ts: session.lastActivity,
    });

    await eventBus.emit("session_message_received", { session, envelope });
  }

  /**
   * Add error to session
   */
  async addError(sessionId: string, error: { type: string; message: string; timestamp?: Date }): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.state.errorCount++;
    session.lastActivity = new Date();

    this.sessions.set(sessionId, session);

    await eventBus.emit("session_error", { session, error });

    // Store error
    await this.memory.put({
      scope: "sessions",
      kind: "session_error",
      payload: { sessionId, error, timestamp: new Date() },
      ts: new Date(),
    });
  }

  /**
   * Block a session
   */
  async blockSession(sessionId: string, reason: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.state.blocked = true;
    session.state.blockReason = reason;
    session.state.connected = false;

    this.sessions.set(sessionId, session);

    await eventBus.emit("session_blocked", { session, reason });

    // Store update
    await this.memory.put({
      scope: "sessions",
      kind: "session_blocked",
      payload: { session, reason, timestamp: new Date() },
      ts: new Date(),
    });
  }

  /**
   * Unblock a session
   */
  async unblockSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.state.blocked = false;
    session.state.blockReason = undefined;

    this.sessions.set(sessionId, session);

    await eventBus.emit("session_unblocked", { session });

    // Store update
    await this.memory.put({
      scope: "sessions",
      kind: "session_unblocked",
      payload: session,
      ts: new Date(),
    });
  }

  /**
   * Pair session with channel
   */
  async pairSession(sessionId: string, channelId: string, permissions: string[]): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.pairing = {
      channelId,
      pairedAt: new Date(),
      expiresAt: new Date(Date.now() + this.pairingTimeout),
      permissions,
    };

    this.sessions.set(sessionId, session);

    await eventBus.emit("session_paired", { session, channelId });

    // Store update
    await this.memory.put({
      scope: "sessions",
      kind: "session_paired",
      payload: { session, channelId },
      ts: new Date(),
    });
  }

  /**
   * Unpair session from channel
   */
  async unpairSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.pairing = undefined;
    this.sessions.set(sessionId, session);

    await eventBus.emit("session_unpaired", { session });

    // Store update
    await this.memory.put({
      scope: "sessions",
      kind: "session_unpaired",
      payload: session,
      ts: new Date(),
    });
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get all sessions
   */
  getAllSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get active sessions
   */
  getActiveSessions(): Session[] {
    return this.getAllSessions().filter((session) => session.state?.connected && !session.state?.blocked);
  }

  /**
   * Get sessions by user
   */
  getSessionsByUser(userId: string): Session[] {
    return this.getAllSessions().filter(session => session.userId === userId);
  }

  /**
   * Check session permissions
   */
  hasPermission(session: Session, channel: string): boolean {
    // Check session-level permissions
    if (!session.metadata.permissions.includes("*")) {
      if (!session.metadata.permissions.includes(channel)) {
        return false;
      }
    }

    // Check pairing permissions
    if (session.pairing) {
      if (!session.pairing.permissions.includes("*")) {
        if (!session.pairing.permissions.includes(channel)) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Clean up expired sessions
   */
  async cleanupExpiredSessions(): Promise<string[]> {
    const now = new Date();
    const expired: string[] = [];

    for (const [sessionId, session] of this.sessions) {
      if (session.expiresAt < now || (session.pairing && session.pairing.expiresAt < now)) {
        expired.push(sessionId);
        await this.disconnectSession(sessionId);
      }
    }

    return expired;
  }

  /**
   * Extend session timeout
   */
  async extendSession(sessionId: string, extensionMs: number = this.sessionTimeout): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.expiresAt = new Date(session.expiresAt.getTime() + extensionMs);
    this.sessions.set(sessionId, session);

    await eventBus.emit("session_extended", { session });
  }

  /**
   * Migrate stale session permissions to full access.
   * Sessions created with old defaults had permissions: ['read', 'write'] which
   * denies channel access like 'telegram'. Upgrades them to ['*'].
   */
  private migrateSessionPermissions(session: Session): void {
    const perms = session.metadata?.permissions;
    if (!Array.isArray(perms) || perms.length === 0) {
      session.metadata = { ...session.metadata, permissions: ["*"] };
    } else if (!perms.includes("*")) {
      // Old format: had 'read' and/or 'write' but no wildcard — upgrade to full access
      session.metadata.permissions = ["*"];
    }
    // Also migrate pairing permissions if present
    if (session.pairing) {
      const pairingPerms = session.pairing.permissions;
      if (Array.isArray(pairingPerms) && !pairingPerms.includes("*")) {
        session.pairing.permissions = ["*"];
      }
    }
  }

  /**
   * Load sessions from memory
   */
  private async loadSessions(): Promise<void> {
    try {
      const results = await this.memory.search({
        scope: "sessions",
        text: "session",
        topK: 100,
      });

      for (const result of results) {
        if (result.payload && typeof result.payload === "object") {
          const session = result.payload as Session;
          const currentMetadata = session.metadata ?? { permissions: ["*"], riskLevel: "medium" };
          const currentState = session.state ?? {
            connected: false,
            messageCount: 0,
            errorCount: 0,
            blocked: false,
          };
          session.metadata = {
            ...currentMetadata,
            permissions: Array.isArray(currentMetadata.permissions) && currentMetadata.permissions.length > 0
              ? currentMetadata.permissions
              : ["*"],
            riskLevel: currentMetadata.riskLevel ?? "medium",
          };
          session.state = {
            connected: currentState.connected ?? false,
            messageCount: currentState.messageCount ?? 0,
            errorCount: currentState.errorCount ?? 0,
            blocked: currentState.blocked ?? false,
            blockReason: currentState.blockReason,
            lastMessage: currentState.lastMessage,
          };
          session.createdAt = session.createdAt ? new Date(session.createdAt) : new Date();
          session.lastActivity = session.lastActivity ? new Date(session.lastActivity) : new Date();
          session.expiresAt = session.expiresAt ? new Date(session.expiresAt) : new Date(Date.now() + this.sessionTimeout);
          this.migrateSessionPermissions(session);
          this.sessions.set(session.id, session);
        }
      }
    } catch (error) {
      console.error("Failed to load sessions:", error);
    }
  }

  /**
   * Create default session configuration
   */
  createDefaultSession(userId: string, accountId: string): Session {
    return {
      id: `session-${Date.now()}-${randomUUID()}`,
      userId,
      accountId,
      metadata: {
        permissions: ["*"],
        riskLevel: "medium",
      },
      state: {
        connected: false,
        messageCount: 0,
        errorCount: 0,
        blocked: false,
      },
      createdAt: new Date(),
      lastActivity: new Date(),
      expiresAt: new Date(Date.now() + this.sessionTimeout),
    };
  }

  /**
   * Validate session
   */
  validateSession(session: Session): boolean {
    const now = new Date();

    // Check expiration
    if (session.expiresAt < now) {
      return false;
    }

    // Check pairing expiration
    if (session.pairing && session.pairing.expiresAt < now) {
      return false;
    }

    // Check if blocked
    if (session.state.blocked) {
      return false;
    }

    return true;
  }
}
