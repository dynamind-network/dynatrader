/**
 * Gateway Service
 *
 * Manages WebSocket/HTTP connections, session mapping, message routing,
 * rate limiting, authentication, broadcasting, auditing, and health checks.
 */

import { v4 as uuidv4 } from "uuid";
import { AuthRuntime } from "@dyna/auth-runtime";
import { AuditTrail } from "@dyna/audit";
import type { ChannelEnvelope } from "@dyna/contracts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConnectionType = "websocket" | "http";

export interface ConnectionInfo {
  id: string;
  type: ConnectionType;
  sessionId: string;
  userId: string;
  connected: boolean;
  metadata: Record<string, unknown>;
  connectedAt: Date;
}

export interface RateLimitConfig {
  windowMs: number;
  maxMessages: number;
}

interface RateLimitBucket {
  count: number;
  windowStart: number;
}

/**
 * Minimal event emitter interface for optional instrumentation.
 */
export interface GatewayEventEmitter {
  emit(event: string, data?: unknown): void | Promise<void>;
}

export interface GatewayOptions {
  auth: AuthRuntime;
  audit: AuditTrail;
  rateLimit?: RateLimitConfig;
  /** Optional event emitter for instrumentation events */
  eventBus?: GatewayEventEmitter;
}

export interface HealthStatus {
  status: "ok" | "degraded" | "down";
  uptime: number;
  activeConnections: number;
  activeSessions: number;
  handlersByChannel?: Record<string, number>;
}

export interface AccessResult {
  allowed: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Handler types
// ---------------------------------------------------------------------------

export type MessageHandler = (envelope: ChannelEnvelope) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

export class Gateway {
  // DI
  private readonly auth: AuthRuntime;
  private readonly audit: AuditTrail;
  private readonly rateLimitCfg: RateLimitConfig;
  private readonly eventBus?: GatewayEventEmitter;

  // State
  private readonly connections = new Map<string, ConnectionInfo>();
  private readonly sessionToConnections = new Map<string, Set<string>>();
  private readonly messageHandlers = new Map<string, Set<MessageHandler>>();
  private readonly rateLimitBuckets = new Map<string, RateLimitBucket>();
  private readonly startedAt: number = Date.now();
  private running = true;

  constructor(options: GatewayOptions) {
    this.auth = options.auth;
    this.audit = options.audit;
    this.eventBus = options.eventBus;
    this.rateLimitCfg = options.rateLimit ?? {
      windowMs: 60_000,
      maxMessages: 60,
    };
  }

  // -----------------------------------------------------------------------
  // Connection management
  // -----------------------------------------------------------------------

  /**
   * Register a new connection and return its unique id.
   */
  registerConnection(info: {
    type: ConnectionType;
    sessionId: string;
    userId: string;
    metadata?: Record<string, unknown>;
  }): string {
    const id = `conn-${uuidv4()}`;
    const connection: ConnectionInfo = {
      id,
      type: info.type,
      sessionId: info.sessionId,
      userId: info.userId,
      connected: true,
      metadata: info.metadata ?? {},
      connectedAt: new Date(),
    };

    this.connections.set(id, connection);

    // Map session -> connection ids
    let connSet = this.sessionToConnections.get(info.sessionId);
    if (!connSet) {
      connSet = new Set();
      this.sessionToConnections.set(info.sessionId, connSet);
    }
    connSet.add(id);

    this.eventBus?.emit("gateway_connection_registered", { connectionId: id, sessionId: info.sessionId, userId: info.userId });
    return id;
  }

  /**
   * Unregister (disconnect) a connection.
   */
  unregisterConnection(connectionId: string): void {
    const conn = this.connections.get(connectionId);
    if (!conn) return;

    conn.connected = false;
    this.connections.set(connectionId, conn);

    // Remove from session mapping
    const connSet = this.sessionToConnections.get(conn.sessionId);
    if (connSet) {
      connSet.delete(connectionId);
      if (connSet.size === 0) {
        this.sessionToConnections.delete(conn.sessionId);
      }
    }

    this.eventBus?.emit("gateway_connection_unregistered", { connectionId, sessionId: conn.sessionId });
  }

  /**
   * Get connection info by id.
   */
  getConnection(connectionId: string): ConnectionInfo | undefined {
    return this.connections.get(connectionId);
  }

  /**
   * Get all connections for a given session.
   */
  getConnectionsForSession(sessionId: string): ConnectionInfo[] {
    const connIds = this.sessionToConnections.get(sessionId);
    if (!connIds) return [];
    const result: ConnectionInfo[] = [];
    for (const id of connIds) {
      const conn = this.connections.get(id);
      if (conn) result.push(conn);
    }
    return result;
  }

  // -----------------------------------------------------------------------
  // Authentication / Access control
  // -----------------------------------------------------------------------

  /**
   * Check if a user is allowed to send messages on a channel.
   */
  async checkAccess(userId: string, channel: string): Promise<AccessResult> {
    const allowed = this.auth.canAccessChannel(userId, channel);
    if (!allowed) {
      return { allowed: false, reason: `User ${userId} does not have access to channel "${channel}"` };
    }
    return { allowed: true };
  }

  /**
   * Check if a user has a specific permission.
   */
  hasPermission(userId: string, permission: string): boolean {
    return this.auth.hasPermission(userId, permission);
  }

  // -----------------------------------------------------------------------
  // Message handling
  // -----------------------------------------------------------------------

  /**
   * Register a message handler for a specific channel.
   * Returns an unsubscribe function.
   */
  onMessage(channel: string, handler: MessageHandler): () => void {
    let handlers = this.messageHandlers.get(channel);
    if (!handlers) {
      handlers = new Set();
      this.messageHandlers.set(channel, handlers);
    }
    handlers.add(handler);

    return () => {
      handlers!.delete(handler);
      if (handlers!.size === 0) {
        this.messageHandlers.delete(channel);
      }
    };
  }

  /**
   * Handle an inbound message envelope:
   * 1. Validate payload
   * 2. Check auth (channel access)
   * 3. Check blocked operations
   * 4. Apply rate limiting
   * 5. Audit
   * 6. Dispatch to registered handlers
   *
   * Returns the number of handlers that processed the message.
   */
  async handleInbound(envelope: ChannelEnvelope): Promise<number> {
    if (!this.running) {
      throw new Error("Gateway is shut down");
    }

    // 1. Validate
    if (!envelope.text && !envelope.attachments) {
      throw new Error("Message must have text or attachments");
    }

    // 2. Check auth - access to channel
    const access = await this.checkAccess(envelope.senderId, envelope.channel);
    if (!access.allowed) {
      await this.audit.record({
        type: "permission",
        actor: envelope.senderId,
        actorType: "user",
        action: "inbound_message",
        resource: `channel:${envelope.channel}`,
        result: "denied",
        details: { reason: access.reason, envelope },
      });
      throw new Error(`Access denied: ${access.reason}`);
    }

    // 3. Check blocked operations
    const operation = envelope.metadata?.operation as string | undefined;
    if (operation && this.auth.isBlocked(operation)) {
      await this.audit.record({
        type: "permission",
        actor: envelope.senderId,
        actorType: "user",
        action: "inbound_message",
        resource: `operation:${operation}`,
        result: "denied",
        details: { reason: `Operation "${operation}" is blocked`, envelope },
      });
      throw new Error(`Operation "${operation}" is blocked`);
    }

    // 4. Rate limiting
    this.applyRateLimit(envelope.sessionId);

    // 5. Audit inbound
    await this.audit.record({
      type: "action",
      actor: envelope.senderId,
      actorType: "user",
      action: "inbound_message",
      resource: `channel:${envelope.channel}`,
      result: "success",
      details: { envelope },
    });

    // 6. Dispatch to handlers
    return this.dispatch(envelope.channel, envelope);
  }

  /**
   * Broadcast a message to all handlers on the given channel.
   * Unlike handleInbound, this does NOT re-check auth or rate-limit
   * (it is assumed the message was already validated).
   */
  async broadcast(channel: string, envelope: ChannelEnvelope): Promise<void> {
    await this.audit.record({
      type: "action",
      actor: "gateway",
      actorType: "system",
      action: "outbound_broadcast",
      resource: `channel:${channel}`,
      result: "success",
      details: { envelope },
    });

    await this.dispatch(channel, envelope);
  }

  // -----------------------------------------------------------------------
  // Health checks
  // -----------------------------------------------------------------------

  /**
   * Return current health status.
   */
  health(): HealthStatus {
    const activeConnections = this.countActiveConnections();
    const activeSessions = this.countActiveSessions();

    const handlersByChannel: Record<string, number> = {};
    for (const [channel, handlers] of this.messageHandlers) {
      handlersByChannel[channel] = handlers.size;
    }

    const status: HealthStatus["status"] = this.running ? "ok" : "down";

    return {
      status,
      uptime: Date.now() - this.startedAt,
      activeConnections,
      activeSessions,
      handlersByChannel: Object.keys(handlersByChannel).length > 0 ? handlersByChannel : undefined,
    };
  }

  /**
   * Gracefully shut down the gateway.
   */
  async shutdown(): Promise<void> {
    this.running = false;
    this.connections.clear();
    this.sessionToConnections.clear();
    this.messageHandlers.clear();
    this.rateLimitBuckets.clear();
    await this.eventBus?.emit("gateway_shutdown", {});
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Dispatch an envelope to all handlers registered for a channel.
   * Returns the number of handlers called.
   */
  private async dispatch(channel: string, envelope: ChannelEnvelope): Promise<number> {
    const handlers = this.messageHandlers.get(channel);
    if (!handlers || handlers.size === 0) return 0;

    let count = 0;
    for (const handler of handlers) {
      try {
        await handler(envelope);
        count++;
      } catch {
        // Swallow handler errors so one bad handler doesn't break the rest
      }
    }
    return count;
  }

  /**
   * Apply rate limiting for the given session.
   * Throws if the session has exceeded the limit.
   */
  private applyRateLimit(sessionId: string): void {
    const now = Date.now();
    let bucket = this.rateLimitBuckets.get(sessionId);

    if (!bucket || now - bucket.windowStart >= this.rateLimitCfg.windowMs) {
      bucket = { count: 0, windowStart: now };
      this.rateLimitBuckets.set(sessionId, bucket);
    }

    bucket.count++;

    if (bucket.count > this.rateLimitCfg.maxMessages) {
      throw new Error(
        `Rate limit exceeded for session "${sessionId}": ` +
        `${this.rateLimitCfg.maxMessages} messages per ${this.rateLimitCfg.windowMs}ms`
      );
    }
  }

  /**
   * Count connections that are currently marked as connected.
   */
  private countActiveConnections(): number {
    let count = 0;
    for (const conn of this.connections.values()) {
      if (conn.connected) count++;
    }
    return count;
  }

  /**
   * Count unique sessions that have at least one active connection.
   */
  private countActiveSessions(): number {
    const sessions = new Set<string>();
    for (const conn of this.connections.values()) {
      if (conn.connected) {
        sessions.add(conn.sessionId);
      }
    }
    return sessions.size;
  }
}
