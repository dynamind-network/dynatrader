/**
 * Tests for Gateway package
 *
 * Tests connection management, session mapping, message routing,
 * rate limiting, auth integration, broadcasting, auditing, and health checks.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// Mock event-bus to avoid emittery ESM interop issues
vi.mock("@dyna/event-bus", () => ({
  eventBus: {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  },
  default: {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  },
}));

import { Gateway } from "./gateway";
import { AuthRuntime } from "@dyna/auth-runtime";
import { AuditTrail } from "@dyna/audit";
import type { ChannelEnvelope } from "@dyna/contracts";

// --- Helper: minimal auth config ---
const defaultAuthConfig = {
  version: "1.0",
  owner: { id: "owner-1", role: "owner" as const },
  channels: {
    "trade-alerts": { enabled: true, allowed_users: ["user-1", "user-2"] },
    admin: { enabled: true, allowed_users: ["user-1"] },
    restricted: { enabled: false, allowed_users: ["user-1"] },
  },
  roles: {
    owner: { permissions: ["*"] },
    operator: { permissions: ["trade:read", "trade:write"] },
  },
  approval_required_for: ["large-trade"],
  blocked_operations: ["self-destruct"],
};

// --- Helper: create envelope ---
function makeEnvelope(overrides: Partial<ChannelEnvelope> = {}): ChannelEnvelope {
  return {
    channel: "trade-alerts",
    senderId: "user-1",
    sessionId: "session-1",
    text: "Hello",
    trusted: false,
    metadata: {},
    ...overrides,
  };
}

describe("Gateway", () => {
  let auth: AuthRuntime;
  let audit: AuditTrail;
  let gateway: Gateway;

  beforeEach(() => {
    auth = new AuthRuntime(defaultAuthConfig);
    audit = new AuditTrail(".");
    gateway = new Gateway({ auth, audit });
  });

  afterEach(async () => {
    await gateway.shutdown();
  });

  /* ------------------------------------------------------------------ */
  /*  Connection management                                              */
  /* ------------------------------------------------------------------ */

  describe("connection management", () => {
    it("should register a new connection and return a connection id", () => {
      const connId = gateway.registerConnection({
        type: "websocket",
        sessionId: "session-1",
        userId: "user-1",
        metadata: { userAgent: "test-browser", ipAddress: "127.0.0.1" },
      });

      expect(connId).toBeDefined();
      expect(connId).toMatch(/^conn-/);

      const info = gateway.getConnection(connId);
      expect(info).toBeDefined();
      expect(info!.sessionId).toBe("session-1");
      expect(info!.userId).toBe("user-1");
      expect(info!.type).toBe("websocket");
      expect(info!.connected).toBe(true);
    });

    it("should register an HTTP connection", () => {
      const connId = gateway.registerConnection({
        type: "http",
        sessionId: "session-2",
        userId: "user-2",
        metadata: { ipAddress: "10.0.0.1" },
      });

      expect(connId).toBeDefined();
      const info = gateway.getConnection(connId);
      expect(info!.type).toBe("http");
      expect(info!.connected).toBe(true);
    });

    it("should unregister a connection and mark it disconnected", () => {
      const connId = gateway.registerConnection({
        type: "websocket",
        sessionId: "session-1",
        userId: "user-1",
      });

      gateway.unregisterConnection(connId);

      const info = gateway.getConnection(connId);
      expect(info).toBeDefined();
      expect(info!.connected).toBe(false);
    });

    it("should list all connections for a session", () => {
      const c1 = gateway.registerConnection({ type: "websocket", sessionId: "session-1", userId: "user-1" });
      const c2 = gateway.registerConnection({ type: "http", sessionId: "session-1", userId: "user-1" });
      gateway.registerConnection({ type: "websocket", sessionId: "session-2", userId: "user-2" });

      const sessionConns = gateway.getConnectionsForSession("session-1");
      expect(sessionConns).toHaveLength(2);
      expect(sessionConns.map((c) => c.id)).toContain(c1);
      expect(sessionConns.map((c) => c.id)).toContain(c2);
    });

    it("should return empty array for unknown session", () => {
      const conns = gateway.getConnectionsForSession("session-ghost");
      expect(conns).toEqual([]);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  Session mapping                                                    */
  /* ------------------------------------------------------------------ */

  describe("session mapping", () => {
    it("should map a session id to its active connection ids", () => {
      const c1 = gateway.registerConnection({ type: "websocket", sessionId: "session-1", userId: "user-1" });
      const c2 = gateway.registerConnection({ type: "http", sessionId: "session-1", userId: "user-1" });

      const connIds = gateway.getConnectionsForSession("session-1").map((c) => c.id);
      expect(connIds).toContain(c1);
      expect(connIds).toContain(c2);
    });

    it("should return empty array for unmapped session", () => {
      const conns = gateway.getConnectionsForSession("session-ghost");
      expect(conns).toEqual([]);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  Authentication (AuthRuntime integration)                           */
  /* ------------------------------------------------------------------ */

  describe("authentication", () => {
    it("should allow a user with access to a channel", async () => {
      const result = await gateway.checkAccess("user-1", "trade-alerts");
      expect(result.allowed).toBe(true);
    });

    it("should deny a user without access to a channel", async () => {
      const result = await gateway.checkAccess("user-2", "admin");
      expect(result.allowed).toBe(false);
    });

    it("should deny access to a disabled channel", async () => {
      const result = await gateway.checkAccess("user-1", "restricted");
      expect(result.allowed).toBe(false);
    });

    it("should check a user has a specific permission", () => {
      expect(gateway.hasPermission("user-1", "trade:read")).toBe(true);
      expect(gateway.hasPermission("user-2", "self-destruct")).toBe(false);
    });

    it("should reject a message when sender is not allowed on the channel", async () => {
      const envelope = makeEnvelope({ senderId: "user-2", channel: "admin" });

      await expect(gateway.handleInbound(envelope)).rejects.toThrow(/access denied/i);
    });

    it("should reject a message for a blocked operation", async () => {
      const envelope = makeEnvelope({
        senderId: "user-1",
        channel: "trade-alerts",
        metadata: { operation: "self-destruct" },
      });

      await expect(gateway.handleInbound(envelope)).rejects.toThrow(/blocked/i);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  Rate limiting                                                      */
  /* ------------------------------------------------------------------ */

  describe("rate limiting", () => {
    it("should allow messages within the rate limit", async () => {
      const envelope = makeEnvelope({ sessionId: "session-rate-1" });

      // Should not throw for the first message
      await expect(gateway.handleInbound(envelope)).resolves.not.toThrow();
    });

    it("should reject messages that exceed the rate limit", async () => {
      // Configure aggressive rate limit for this test
      const strictGateway = new Gateway({
        auth,
        audit,
        rateLimit: {
          windowMs: 1000,
          maxMessages: 2,
        },
      });

      const envelope = makeEnvelope({ sessionId: "session-rate-2" });

      // First two should pass
      await strictGateway.handleInbound(envelope);
      await strictGateway.handleInbound({ ...envelope, text: "second" });

      // Third should fail
      await expect(
        strictGateway.handleInbound({ ...envelope, text: "third" })
      ).rejects.toThrow(/rate limit/i);

      await strictGateway.shutdown();
    });

    it("should track per-session rate limit counters separately", async () => {
      const strictGateway = new Gateway({
        auth,
        audit,
        rateLimit: { windowMs: 1000, maxMessages: 1 },
      });

      await strictGateway.handleInbound(makeEnvelope({ sessionId: "session-a" }));

      // Session b should be unaffected by session a's limit
      await expect(
        strictGateway.handleInbound(makeEnvelope({ sessionId: "session-b" }))
      ).resolves.not.toThrow();

      // Session a should now be over limit
      await expect(
        strictGateway.handleInbound(makeEnvelope({ sessionId: "session-a", text: "again" }))
      ).rejects.toThrow(/rate limit/i);

      await strictGateway.shutdown();
    });
  });

  /* ------------------------------------------------------------------ */
  /*  Message routing & dispatch                                         */
  /* ------------------------------------------------------------------ */

  describe("message routing", () => {
    it("should dispatch a message to a registered handler by channel", async () => {
      const handler = vi.fn();
      gateway.onMessage("trade-alerts", handler);

      const envelope = makeEnvelope({ sessionId: "session-msg-1" });
      await gateway.handleInbound(envelope);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Hello", channel: "trade-alerts" })
      );
    });

    it("should dispatch to multiple handlers for the same channel", async () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      gateway.onMessage("trade-alerts", h1);
      gateway.onMessage("trade-alerts", h2);

      await gateway.handleInbound(makeEnvelope({ sessionId: "session-msg-2" }));

      expect(h1).toHaveBeenCalledTimes(1);
      expect(h2).toHaveBeenCalledTimes(1);
    });

    it("should not dispatch to handlers on other channels", async () => {
      const handler = vi.fn();
      gateway.onMessage("admin", handler);

      await gateway.handleInbound(makeEnvelope({ sessionId: "session-msg-3" }));

      expect(handler).not.toHaveBeenCalled();
    });

    it("should return the number of handlers that processed the message", async () => {
      gateway.onMessage("trade-alerts", vi.fn());
      gateway.onMessage("trade-alerts", vi.fn());

      const count = await gateway.handleInbound(
        makeEnvelope({ sessionId: "session-msg-4" })
      );
      expect(count).toBe(2);
    });

    it("should throw if message has no text and no attachments", async () => {
      const envelope = makeEnvelope({
        sessionId: "session-msg-5",
        text: undefined,
      });

      await expect(gateway.handleInbound(envelope)).rejects.toThrow(/text or attachment/i);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  Broadcasting                                                       */
  /* ------------------------------------------------------------------ */

  describe("broadcasting", () => {
    it("should broadcast a message to a handler registered on a channel", async () => {
      const handler = vi.fn();
      gateway.onMessage("broadcast-channel", handler);

      const envelope = makeEnvelope({
        channel: "broadcast-channel",
        sessionId: "session-bc-1",
      });

      await gateway.broadcast("broadcast-channel", envelope);

      expect(handler).toHaveBeenCalledWith(envelope);
    });

    it("should broadcast to all handlers on a channel", async () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      gateway.onMessage("broadcast-channel", h1);
      gateway.onMessage("broadcast-channel", h2);

      const envelope = makeEnvelope({
        channel: "broadcast-channel",
        sessionId: "session-bc-2",
      });

      await gateway.broadcast("broadcast-channel", envelope);

      expect(h1).toHaveBeenCalledWith(envelope);
      expect(h2).toHaveBeenCalledWith(envelope);
    });

    it("should remove a handler when the unsubscribe function is called", async () => {
      const handler = vi.fn();
      const unsubscribe = gateway.onMessage("broadcast-channel", handler);

      unsubscribe();

      const envelope = makeEnvelope({
        channel: "broadcast-channel",
        sessionId: "session-bc-3",
      });

      await gateway.broadcast("broadcast-channel", envelope);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  /* ------------------------------------------------------------------ */
  /*  Auditing                                                           */
  /* ------------------------------------------------------------------ */

  describe("auditing", () => {
    it("should audit an inbound message event", async () => {
      const recordSpy = vi.spyOn(audit, "record");

      await gateway.handleInbound(
        makeEnvelope({ sessionId: "session-audit-1" })
      );

      expect(recordSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "action",
          actor: "user-1",
          action: "inbound_message",
          result: "success",
        })
      );
    });

    it("should audit an outbound broadcast event", async () => {
      const recordSpy = vi.spyOn(audit, "record");
      gateway.onMessage("audit-channel", vi.fn());

      await gateway.broadcast(
        "audit-channel",
        makeEnvelope({ channel: "audit-channel", sessionId: "session-audit-2" })
      );

      expect(recordSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "action",
          actor: "gateway",
          action: "outbound_broadcast",
          result: "success",
        })
      );
    });

    it("should audit a denied access attempt", async () => {
      const recordSpy = vi.spyOn(audit, "record");

      const envelope = makeEnvelope({
        senderId: "user-2",
        channel: "admin",
        sessionId: "session-audit-3",
      });

      await expect(gateway.handleInbound(envelope)).rejects.toThrow();

      expect(recordSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "permission",
          actor: "user-2",
          action: "inbound_message",
          result: "denied",
        })
      );
    });
  });

  /* ------------------------------------------------------------------ */
  /*  Health checks                                                      */
  /* ------------------------------------------------------------------ */

  describe("health checks", () => {
    it("should report healthy status when gateway is running", () => {
      const status = gateway.health();
      expect(status.status).toBe("ok");
      expect(status.uptime).toBeGreaterThanOrEqual(0);
      expect(typeof status.activeConnections).toBe("number");
      expect(typeof status.activeSessions).toBe("number");
    });

    it("should report the number of active connections", () => {
      gateway.registerConnection({ type: "websocket", sessionId: "s1", userId: "u1" });
      gateway.registerConnection({ type: "http", sessionId: "s2", userId: "u2" });

      const status = gateway.health();
      expect(status.activeConnections).toBe(2);
    });

    it("should report the number of unique active sessions", () => {
      gateway.registerConnection({ type: "websocket", sessionId: "s1", userId: "u1" });
      gateway.registerConnection({ type: "http", sessionId: "s1", userId: "u1" });
      gateway.registerConnection({ type: "websocket", sessionId: "s2", userId: "u2" });

      const status = gateway.health();
      expect(status.activeSessions).toBe(2);
    });

    it("should report the number of registered handlers per channel", () => {
      gateway.onMessage("ch1", vi.fn());
      gateway.onMessage("ch1", vi.fn());
      gateway.onMessage("ch2", vi.fn());

      const status = gateway.health();
      expect(status.handlersByChannel?.ch1).toBe(2);
      expect(status.handlersByChannel?.ch2).toBe(1);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  Integration: end-to-end message flow                               */
  /* ------------------------------------------------------------------ */

  describe("integration", () => {
    it("should process a full message lifecycle end-to-end", async () => {
      // 1. Register connection
      const connId = gateway.registerConnection({
        type: "websocket",
        sessionId: "session-e2e",
        userId: "user-1",
      });
      expect(connId).toBeDefined();

      // 2. Register handler
      const handler = vi.fn();
      gateway.onMessage("trade-alerts", handler);

      // 3. Send message through the gateway
      const envelope = makeEnvelope({ sessionId: "session-e2e", text: "BTC price moved" });
      const handlerCount = await gateway.handleInbound(envelope);

      // 4. Verify dispatch
      expect(handlerCount).toBe(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ text: "BTC price moved" })
      );

      // 5. Broadcast to channel
      const broadcastHandler = vi.fn();
      gateway.onMessage("trade-alerts", broadcastHandler);
      await gateway.broadcast("trade-alerts", envelope);
      expect(broadcastHandler).toHaveBeenCalledWith(envelope);

      // 6. Health check reflects activity
      const health = gateway.health();
      expect(health.activeConnections).toBe(1);
      expect(health.activeSessions).toBe(1);
      expect(health.status).toBe("ok");

      // 7. Unregister connection
      gateway.unregisterConnection(connId);
      expect(gateway.getConnection(connId)?.connected).toBe(false);
    });
  });
});
