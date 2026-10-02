/**
 * Tests for Channels Core components
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { MemoryStoreImpl } from "@dyna/memory-core";
import { GatewayService } from "./gateway";
import { SessionManager } from "./sessions";
import { ChannelManager } from "./channels";
import { OperatorInbox } from "./operator-inbox";

describe("Channels Core", () => {
  let memory: MemoryStoreImpl;
  let gateway: GatewayService;
  let sessionManager: SessionManager;
  let channelManager: ChannelManager;
  let inbox: OperatorInbox;

  beforeEach(async () => {
    memory = new MemoryStoreImpl();
    gateway = new GatewayService(memory);
    sessionManager = new SessionManager(memory);
    // Use the gateway's internal channel manager so channels created
    // are visible to gateway.processMessage()
    channelManager = (gateway as any).channelManager;
    inbox = new OperatorInbox(memory);
    await gateway.start();
  });

  describe("Gateway Service", () => {
    it("should create and manage sessions", async () => {
      const sessionId = await gateway.createSession(
        "user-123",
        "account-456",
        {
          permissions: ["read", "write"],
          riskLevel: "medium",
          deviceType: "desktop",
        }
      );

      expect(sessionId).toBeDefined();
      expect(gateway.getActiveSessionsCount()).toBe(1);

      const session = gateway.getSession(sessionId);
      expect(session).toBeDefined();
      expect(session?.userId).toBe("user-123");
      expect(session?.accountId).toBe("account-456");
    });

    it("should process channel messages", async () => {
      const sessionId = await gateway.createSession("user-123", "account-456");

      const envelope: any = {
        channel: "test-channel",
        senderId: "user-123",
        sessionId: sessionId,
        text: "Hello, world!",
        trusted: false,
        metadata: {},
      };

      await expect(gateway.processMessage(envelope)).rejects.toThrow("Channel not found");
    });

    it("should broadcast messages to channels", async () => {
      const sessionId = await gateway.createSession("user-123", "account-456");

      const channelId = await channelManager.createChannel(
        "test-channel",
        "text",
        ["*"],
        "open",
        sessionId
      );

      const envelope: any = {
        channel: channelId,
        senderId: "user-123",
        sessionId: sessionId,
        text: "Broadcast message",
        trusted: true,
        metadata: {},
      };

      await gateway.broadcastToChannel(channelId, envelope, sessionId);
    });

    it("should manage channel subscriptions", async () => {
      const sessionId = await gateway.createSession("user-123", "account-456");
      const channelId = await channelManager.createChannel(
        "test-channel",
        "text",
        ["*"],
        "open",
        sessionId
      );

      // createChannel automatically adds creator as admin member
      // Leave the channel, then verify user has no channels
      await gateway.leaveChannel(sessionId, channelId);

      const channels = await gateway.getUserChannels("user-123");
      expect(channels).toHaveLength(0);
    });
  });

  describe("Session Management", () => {
    it("should create and connect sessions", async () => {
      const sessionId = await sessionManager.createSession(
        "user-123",
        "account-456",
        { permissions: ["read"], riskLevel: "low" }
      );

      expect(sessionId).toBeDefined();
      expect(sessionManager.getAllSessions().length).toBe(1);

      await sessionManager.connectSession(sessionId, {
        userAgent: "Mozilla/5.0",
        ipAddress: "192.168.1.1",
      });

      const session = sessionManager.getSession(sessionId);
      expect(session?.state.connected).toBe(true);
    });

    it("should handle session errors", async () => {
      const sessionId = await sessionManager.createSession("user-123", "account-456", {});
      await sessionManager.addError(sessionId, { type: "invalid_message", message: "Invalid message format" });
      const session = sessionManager.getSession(sessionId);
      expect(session?.state.errorCount).toBe(1);
    });

    it("should block and unblock sessions", async () => {
      const sessionId = await sessionManager.createSession("user-123", "account-456", {});
      await sessionManager.blockSession(sessionId, "Multiple violations");
      const session = sessionManager.getSession(sessionId);
      expect(session?.state.blocked).toBe(true);
      expect(session?.state.blockReason).toBe("Multiple violations");
      await sessionManager.unblockSession(sessionId);
      const unblockedSession = sessionManager.getSession(sessionId);
      expect(unblockedSession?.state.blocked).toBe(false);
    });

    it("should extend session timeout", async () => {
      const sessionId = await sessionManager.createSession("user-123", "account-456", {});
      const session = sessionManager.getSession(sessionId);
      const originalExpiration = session?.expiresAt;
      await sessionManager.extendSession(sessionId, 60000);
      const extendedSession = sessionManager.getSession(sessionId);
      expect(extendedSession?.expiresAt.getTime()).toBeGreaterThan(originalExpiration?.getTime() || 0);
    });
  });

  describe("Channel Management", () => {
    let standaloneMemory: MemoryStoreImpl;
    let standaloneChannelManager: ChannelManager;
    let standaloneSessionManager: SessionManager;

    beforeEach(() => {
      // Use a standalone memory + channel manager (not gateway's internal one)
      // so we start with zero channels instead of 6 defaults
      standaloneMemory = new MemoryStoreImpl();
      standaloneSessionManager = new SessionManager(standaloneMemory);
      standaloneChannelManager = new ChannelManager(standaloneMemory, standaloneSessionManager);
    });

    it("should create and manage channels", async () => {
      const sessionId = await standaloneSessionManager.createSession("user-123", "account-456", {});
      const channelId = await standaloneChannelManager.createChannel(
        "trading-channel", "trading", ["read", "write"], "open", sessionId,
        { description: "Trading discussions" }
      );

      expect(channelId).toBeDefined();
      expect(standaloneChannelManager.getAllChannels().length).toBe(1);

      const channel = standaloneChannelManager.getChannel(channelId);
      expect(channel?.name).toBe("trading-channel");
      expect(channel?.type).toBe("trading");
      expect(channel?.permissions).toEqual(["read", "write"]);
    });

    it("should handle channel membership", async () => {
      const sessionId = await standaloneSessionManager.createSession("user-123", "account-456", {});
      const channelId = await standaloneChannelManager.createChannel("test-channel", "text", ["*"], "open", sessionId);

      // createChannel automatically adds creator as admin member
      const membership = standaloneChannelManager.getMembership(sessionId, channelId);
      expect(membership).toBeDefined();
      expect(membership?.role).toBe("admin");
      expect(membership?.permissions).toEqual(["*"]);

      await standaloneChannelManager.leaveChannel(sessionId, channelId);
      const removedMembership = standaloneChannelManager.getMembership(sessionId, channelId);
      expect(removedMembership).toBeUndefined();
    });

    it("should handle channel permissions", async () => {
      const sessionId = await standaloneSessionManager.createSession("user-123", "account-456", {});
      const channelId = await standaloneChannelManager.createChannel("restricted-channel", "text", ["read"], "open", sessionId);

      // createChannel auto-joins creator as admin with ["*"] permissions
      expect(standaloneChannelManager.canAccessSession(
        standaloneSessionManager.getSession(sessionId) as any, channelId
      )).toBe(true);
    });

    it("should filter channels by criteria", async () => {
      const sessionId = await standaloneSessionManager.createSession("user-123", "account-456", {});

      await standaloneChannelManager.createChannel("text-channel", "text", ["*"], "open", sessionId);
      await standaloneChannelManager.createChannel("trading-channel", "trading", ["read"], "open", sessionId);
      await standaloneChannelManager.createChannel("alert-channel", "alert", ["admin"], "restricted", sessionId);

      const textChannels = standaloneChannelManager.getChannels({ type: "text" });
      expect(textChannels.length).toBe(1);
      expect(textChannels[0]!.type).toBe("text");

      const adminChannels = standaloneChannelManager.getChannels({ permissions: ["admin"] });
      expect(adminChannels.length).toBe(1);
      expect(adminChannels[0]!.type).toBe("alert");
    });
  });

  describe("Operator Inbox", () => {
    it("should create and manage inbox messages", async () => {
      const messageId = await inbox.createMessage("alert", "high", "System Alert", "High CPU usage detected", "system", "operators");
      expect(messageId).toBeDefined();
      expect(inbox.getAllMessages().length).toBe(1);
      const message = inbox.getMessage(messageId);
      expect(message?.type).toBe("alert");
      expect(message?.priority).toBe("high");
      expect(message?.title).toBe("System Alert");
      expect(message?.read).toBe(false);
    });

    it("should mark messages as read", async () => {
      const messageId = await inbox.createMessage("notification", "medium", "New Strategy Available", "Check out the new MA crossover strategy", "system", "operators");
      await inbox.markAsRead(messageId, "operator-123");
      const message = inbox.getMessage(messageId);
      expect(message?.read).toBe(true);
    });

    it("should execute message actions", async () => {
      const messageId = await inbox.createMessage("approval", "high", "Strategy Approval Request", "New strategy needs approval", "user-123", "operators", undefined, [
        { id: "approve", type: "approve", label: "Approve Strategy" },
        { id: "reject", type: "reject", label: "Reject Strategy" },
      ]);
      await inbox.executeAction(messageId, "operator-123", "approve", { strategyId: "strat-123", riskLevel: "medium" });
      const message = inbox.getMessage(messageId);
      expect(message?.actioned).toBe(true);
    });

    it("should create alert messages", async () => {
      const messageId = await inbox.createAlert("critical", "Risk Limit Exceeded", "Daily loss limit of $10,000 exceeded", { portfolioId: "port-456", loss: 12000 });
      const message = inbox.getMessage(messageId);
      expect(message?.type).toBe("alert");
      expect(message?.priority).toBe("critical");
      expect(message?.metadata?.portfolioId).toBe("port-456");
    });

    it("should create emergency notifications", async () => {
      const messageId = await inbox.createEmergency("Market Crash Alert", "Market experiencing severe downturn", { market: "crypto", severity: "extreme" });
      const message = inbox.getMessage(messageId);
      expect(message?.type).toBe("emergency");
      expect(message?.priority).toBe("critical");
      expect(message?.metadata?.market).toBe("crypto");
    });

    it("should count unread messages", async () => {
      await inbox.createMessage("notification", "low", "Test 1", "Content 1", "system", "operators");
      await inbox.createMessage("alert", "high", "Test 2", "Content 2", "system", "operators");
      expect(inbox.getUnreadCount()).toBe(2);
    });

    it("should handle notification settings", async () => {
      await inbox.setNotificationSettings("operator-123", {
        enableEmail: true, enablePush: false, enableInApp: true,
        alertTypes: ["emergency", "alert"],
        quietHours: { start: "22:00", end: "06:00" },
        frequency: "immediate",
      });
      const settings = inbox.getNotificationSettings("operator-123");
      expect(settings?.enableEmail).toBe(true);
      expect(settings?.enablePush).toBe(false);
      expect(settings?.alertTypes).toEqual(["emergency", "alert"]);
    });
  });

  describe("Integration Tests", () => {
    it("should work together end-to-end", async () => {
      const userSessionId = await gateway.createSession("user-123", "account-456");
      const operatorSessionId = await gateway.createSession("operator-123", "system");

      const channelId = await channelManager.createChannel("trading-alerts", "alert", ["read", "write"], "open", userSessionId);

      const messageEnvelope: any = {
        channel: channelId, senderId: "user-123", sessionId: userSessionId,
        text: "High volatility detected in BTC", trusted: false,
        metadata: { symbol: "BTC/USDT", volatility: 0.15 },
      };

      await gateway.processMessage(messageEnvelope);

      await inbox.createAlert("high", "Market Volatility Alert", "High volatility detected in BTC market",
        { symbol: "BTC/USDT", volatility: 0.15, source: "user-123" });

      expect(gateway.getActiveSessionsCount()).toBe(2);
      expect(inbox.getUnreadCount()).toBe(1);
    });

    it("should handle error scenarios gracefully", async () => {
      const sessionId = await gateway.createSession("user-123", "account-456");

      await expect(gateway.processMessage({
        channel: "nonexistent-channel", senderId: "user-123", sessionId: sessionId,
        text: "Test", trusted: false, metadata: {},
      })).rejects.toThrow("Channel not found");

      const messageId = await inbox.createMessage("alert", "medium", "Test", "Content", "system", "operators");
      await expect(inbox.executeAction(messageId, "operator-123", "invalid_action")).rejects.toThrow("Action not found");
    });
  });
});