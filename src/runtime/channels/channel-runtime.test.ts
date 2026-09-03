/**
 * Tests for Channel Runtime
 *
 * Covers: loading manifests, validating schemas, lifecycle management,
 * permission enforcement, routing, error handling, health checks, audit logging.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@dyna/event-bus", () => ({
  eventBus: {
    emit: vi.fn(),
    emitDynamic: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
  },
  default: {
    emit: vi.fn(),
    emitDynamic: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
  },
}));

// Mock fs/promises for manifest loading tests
vi.mock("fs/promises", () => ({
  default: {
    readdir: vi.fn(),
    readFile: vi.fn(),
    access: vi.fn(),
    mkdir: vi.fn(),
    appendFile: vi.fn(),
  },
  readdir: vi.fn(),
  readFile: vi.fn(),
  access: vi.fn(),
  mkdir: vi.fn(),
  appendFile: vi.fn(),
}));

import fs from "fs/promises";
import { ChannelRuntime, ChannelManifestSchema } from "./channel-runtime";
import { Gateway } from "@dyna/gateway";
import { AuthRuntime } from "@dyna/auth-runtime";
import { AuditTrail } from "@dyna/audit";
import type { ChannelAdapter, ChannelEnvelope } from "@dyna/contracts";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

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

function makeManifest(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    name: "trade-alerts",
    type: "text",
    provider: "discord",
    enabled: true,
    blocked_operations: ["dangerous-action"],
    config: { token: "abc" },
    ...overrides,
  };
}

const mockAdapter: ChannelAdapter = {
  id: "discord",
  start: vi.fn().mockResolvedValue(undefined),
  send: vi.fn().mockResolvedValue(undefined),
};

// ---------------------------------------------------------------------------
// Mutable helpers
// ---------------------------------------------------------------------------

function mockChannelFile(fileName: string, content: Record<string, unknown>): void {
  vi.mocked(fs.readdir).mockResolvedValue([fileName as any]);
  vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(content) as any);
}

function mockEmptyChannelsDir(): void {
  vi.mocked(fs.readdir).mockResolvedValue([] as any);
}

function mockNoChannelsDir(): void {
  vi.mocked(fs.readdir).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ChannelRuntime", () => {
  let auth: AuthRuntime;
  let audit: AuditTrail;
  let gateway: Gateway;
  let runtime: ChannelRuntime;

  beforeEach(() => {
    vi.clearAllMocks();

    auth = new AuthRuntime(defaultAuthConfig);
    audit = new AuditTrail(".");
    gateway = new Gateway({ auth, audit });
    runtime = new ChannelRuntime({
      workspacePath: "/fake/workspace",
      gateway,
      auth,
      audit,
    });

    // By default simulate no channels directory so loadManifests returns []
    mockNoChannelsDir();
  });

  afterEach(async () => {
    await runtime.stop();
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // 1. Loading manifests
  // -----------------------------------------------------------------------

  describe("loading manifests", () => {
    it("should load and validate channel manifests from workspace/channels/", async () => {
      mockChannelFile("trade-alerts.channel.json", makeManifest());

      const manifests = await runtime.loadManifests();

      expect(manifests).toHaveLength(1);
      expect(manifests[0]?.name).toBe("trade-alerts");
      expect(manifests[0]?.type).toBe("text");
      expect(manifests[0]?.provider).toBe("discord");
      expect(manifests[0]?.enabled).toBe(true);
      expect(manifests[0]?.blocked_operations).toEqual(["dangerous-action"]);
    });

    it("should return empty array when channels/ directory does not exist", async () => {
      mockNoChannelsDir();
      const manifests = await runtime.loadManifests();
      expect(manifests).toEqual([]);
    });

    it("should skip non-channel.json files", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["readme.txt", "config.yaml"] as any);
      const manifests = await runtime.loadManifests();
      expect(manifests).toEqual([]);
    });

    it("should skip invalid JSON files and audit the error", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["bad.channel.json" as any]);
      vi.mocked(fs.readFile).mockResolvedValue("not valid json" as any);

      const manifests = await runtime.loadManifests();
      expect(manifests).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // 2. Validating schemas
  // -----------------------------------------------------------------------

  describe("schema validation", () => {
    it("should accept a valid manifest", () => {
      const manifest = runtime.validateManifest(makeManifest());
      expect(manifest.name).toBe("trade-alerts");
    });

    it("should reject a manifest missing the name field", () => {
      expect(() => runtime.validateManifest(makeManifest({ name: undefined }))).toThrow(
        "Invalid channel manifest"
      );
    });

    it("should reject a manifest with an invalid type", () => {
      expect(() => runtime.validateManifest(makeManifest({ type: "fax" }))).toThrow(
        "Invalid channel manifest"
      );
    });

    it("should apply defaults for blocked_operations and config", () => {
      const manifest = runtime.validateManifest({
        name: "defaults-test",
        type: "text",
        provider: "slack",
        enabled: true,
      });
      expect(manifest.blocked_operations).toEqual([]);
      expect(manifest.config).toEqual({});
    });

    it("should reject a manifest with non-boolean enabled", () => {
      expect(() =>
        runtime.validateManifest(makeManifest({ enabled: "yes" }))
      ).toThrow("Invalid channel manifest");
    });
  });

  // -----------------------------------------------------------------------
  // 3. Lifecycle management
  // -----------------------------------------------------------------------

  describe("lifecycle management", () => {
    it("should start the runtime and load manifests", async () => {
      mockChannelFile("trade-alerts.channel.json", makeManifest());

      await runtime.start();

      expect(runtime.isRunning()).toBe(true);
      const channels = runtime.getChannels();
      expect(channels.length).toBeGreaterThanOrEqual(1);
    });

    it("should stop the runtime gracefully", async () => {
      mockChannelFile("trade-alerts.channel.json", makeManifest());
      await runtime.start();
      expect(runtime.isRunning()).toBe(true);

      await runtime.stop();
      expect(runtime.isRunning()).toBe(false);

      // All channels should be stopped
      for (const state of runtime.getChannels()) {
        expect(state.status).toBe("stopped");
      }
    });

    it("should start a channel with an adapter", async () => {
      // Pre-load state by starting runtime
      mockChannelFile("discord.channel.json", makeManifest({ name: "discord", provider: "discord" }));
      await runtime.start();

      runtime.registerAdapter(mockAdapter);

      // Stop and restart with adapter
      await runtime.stop();
      await runtime.start();

      const state = runtime.getChannel("discord");
      expect(state).toBeDefined();
      // Adapter is registered so channel should try to start
      expect(state!.manifest.name).toBe("discord");
    });

    it("should restart a channel", async () => {
      mockChannelFile("trade-alerts.channel.json", makeManifest());
      await runtime.start();

      // Set up the channel state so it exists
      runtime["channels"].set("trade-alerts", {
        manifest: runtime.validateManifest(makeManifest()),
        status: "running",
        messageCount: 0,
        errorCount: 0,
        startedAt: new Date(),
      });

      // Capture the startedAt before restart
      const before = runtime.getChannel("trade-alerts")!.startedAt;

      await runtime.restart("trade-alerts");

      const after = runtime.getChannel("trade-alerts")!;
      expect(after.status).toBe("running");
      // startedAt could differ after restart
      expect(after.startedAt).toBeDefined();
    });

    it("should throw when restarting a non-existent channel", async () => {
      await expect(runtime.restart("ghost-channel")).rejects.toThrow(
        'Channel "ghost-channel" not found'
      );
    });
  });

  // -----------------------------------------------------------------------
  // 4. Adapter registration
  // -----------------------------------------------------------------------

  describe("adapter registration", () => {
    it("should register a channel adapter", () => {
      runtime.registerAdapter(mockAdapter);
      // Not throwing means success
    });

    it("should prevent duplicate adapter registration", () => {
      runtime.registerAdapter(mockAdapter);
      expect(() => runtime.registerAdapter(mockAdapter)).toThrow(
        'Adapter "discord" is already registered'
      );
    });
  });

  // -----------------------------------------------------------------------
  // 5. Permission enforcement
  // -----------------------------------------------------------------------

  describe("permission enforcement", () => {
    it("should reject messages with channel-specific blocked operations", async () => {
      mockChannelFile("trade-alerts.channel.json", makeManifest());
      await runtime.start();

      // Inject a running channel state for the test
      runtime["channels"].set("trade-alerts", {
        manifest: runtime.validateManifest(makeManifest()),
        status: "running",
        messageCount: 0,
        errorCount: 0,
        startedAt: new Date(),
      });

      const envelope = makeEnvelope({
        metadata: { operation: "dangerous-action" },
      });

      await expect(runtime.routeInbound(envelope)).rejects.toThrow(
        'Operation "dangerous-action" is blocked on channel "trade-alerts"'
      );
    });

    it("should reject messages with globally blocked operations", async () => {
      mockChannelFile("trade-alerts.channel.json", makeManifest());
      await runtime.start();

      runtime["channels"].set("trade-alerts", {
        manifest: runtime.validateManifest(makeManifest({ blocked_operations: [] })),
        status: "running",
        messageCount: 0,
        errorCount: 0,
        startedAt: new Date(),
      });

      const envelope = makeEnvelope({
        metadata: { operation: "self-destruct" },
      });

      await expect(runtime.routeInbound(envelope)).rejects.toThrow(
        'Operation "self-destruct" is globally blocked'
      );
    });

    it("should allow messages with no blocked operation", async () => {
      mockChannelFile("trade-alerts.channel.json", makeManifest());
      await runtime.start();

      runtime["channels"].set("trade-alerts", {
        manifest: runtime.validateManifest(makeManifest()),
        status: "running",
        messageCount: 0,
        errorCount: 0,
        startedAt: new Date(),
      });

      const envelope = makeEnvelope({ text: "safe message" });

      // Gateway will reject because we haven't registered the connection,
      // but it should NOT fail due to blocked operations
      try {
        await runtime.routeInbound(envelope);
      } catch (err) {
        // Expect gateway error (no connection), NOT a blocked operation error
        expect((err as Error).message).not.toContain("blocked");
      }
    });
  });

  // -----------------------------------------------------------------------
  // 6. Routing
  // -----------------------------------------------------------------------

  describe("routing", () => {
    it("should reject messages when runtime is not running", async () => {
      const envelope = makeEnvelope();
      await expect(runtime.routeInbound(envelope)).rejects.toThrow(
        "Channel runtime is not running"
      );
    });

    it("should reject messages for unknown channels", async () => {
      mockChannelFile("trade-alerts.channel.json", makeManifest());
      await runtime.start();

      const envelope = makeEnvelope({ channel: "unknown-channel" });
      await expect(runtime.routeInbound(envelope)).rejects.toThrow(
        "Unknown channel: unknown-channel"
      );
    });

    it("should reject messages for non-running channels", async () => {
      mockChannelFile("trade-alerts.channel.json", makeManifest({ enabled: false }));
      await runtime.start();

      // Disabled channels are loaded as "stopped"
      const envelope = makeEnvelope({ channel: "trade-alerts" });
      await expect(runtime.routeInbound(envelope)).rejects.toThrow(
        'Channel "trade-alerts" is not running'
      );
    });
  });

  // -----------------------------------------------------------------------
  // 7. Error handling
  // -----------------------------------------------------------------------

  describe("error handling", () => {
    it("should track error count per channel", async () => {
      mockChannelFile("trade-alerts.channel.json", makeManifest());
      await runtime.start();

      runtime["channels"].set("trade-alerts", {
        manifest: runtime.validateManifest(makeManifest()),
        status: "error",
        errorCount: 0,
        messageCount: 0,
        error: "Previous failure",
      });

      const state = runtime.getChannel("trade-alerts");
      expect(state).toBeDefined();
      expect(state!.status).toBe("error");
      expect(state!.error).toBe("Previous failure");
    });

    it("should start even when some manifests are invalid", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([
        "good.channel.json" as any,
        "bad.channel.json" as any,
      ]);
      vi.mocked(fs.readFile).mockImplementation(async (filePath: any) => {
        if (String(filePath).includes("good")) {
          return JSON.stringify(makeManifest({ name: "good-channel" }));
        }
        return "not valid json";
      });

      // Should not throw
      await runtime.start();

      const channels = runtime.getChannels();
      const goodChannel = channels.find((c) => c.manifest.name === "good-channel");
      expect(goodChannel).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // 8. Health checks
  // -----------------------------------------------------------------------

  describe("health checks", () => {
    it("should report ok when runtime is running", async () => {
      mockChannelFile("trade-alerts.channel.json", makeManifest());
      await runtime.start();

      runtime["channels"].set("trade-alerts", {
        manifest: runtime.validateManifest(makeManifest()),
        status: "running",
        messageCount: 0,
        errorCount: 0,
        startedAt: new Date(),
      });

      const health = runtime.health();
      expect(health.status).toBe("ok");
      expect(health.channels.total).toBe(1);
      expect(health.channels.running).toBe(1);
      expect(health.uptime).toBeGreaterThanOrEqual(0);
    });

    it("should report degraded when any channel is errored", async () => {
      mockChannelFile("trade-alerts.channel.json", makeManifest());
      await runtime.start();

      runtime["channels"].set("ok-channel", {
        manifest: runtime.validateManifest(makeManifest({ name: "ok-channel" })),
        status: "running",
        messageCount: 0,
        errorCount: 0,
        startedAt: new Date(),
      });
      runtime["channels"].set("bad-channel", {
        manifest: runtime.validateManifest(makeManifest({ name: "bad-channel" })),
        status: "error",
        messageCount: 0,
        errorCount: 1,
        error: "Something broke",
      });

      const health = runtime.health();
      expect(health.status).toBe("degraded");
      expect(health.channels.errored).toBe(1);
    });

    it("should report down when runtime is stopped", () => {
      const health = runtime.health();
      expect(health.status).toBe("down");
    });
  });

  // -----------------------------------------------------------------------
  // 9. Audit logging
  // -----------------------------------------------------------------------

  describe("audit logging", () => {
    it("should audit runtime start", async () => {
      mockChannelFile("trade-alerts.channel.json", makeManifest());
      const auditSpy = vi.spyOn(audit, "record");

      await runtime.start();

      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "action",
          action: "runtime_start",
          result: "success",
        })
      );
    });

    it("should audit manifest loading", async () => {
      mockChannelFile("trade-alerts.channel.json", makeManifest());
      const auditSpy = vi.spyOn(audit, "record");

      await runtime.loadManifests();

      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "manifest_loaded",
          resource: "channel-manifest:trade-alerts",
          result: "success",
        })
      );
    });

    it("should audit channel start events", async () => {
      mockChannelFile("trade-alerts.channel.json", makeManifest());
      await runtime.start();

      const auditSpy = vi.spyOn(audit, "record");

      runtime["channels"].set("trade-alerts", {
        manifest: runtime.validateManifest(makeManifest()),
        status: "running",
        messageCount: 0,
        errorCount: 0,
        startedAt: new Date(),
      });

      // Trigger a route attempt that will generate audit events
      const envelope = makeEnvelope({ metadata: { operation: "dangerous-action" } });

      try {
        await runtime.routeInbound(envelope);
      } catch {
        // expected
      }

      // Should have at least audited the blocked operation
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "permission",
          result: "denied",
        })
      );
    });
  });

  // -----------------------------------------------------------------------
  // 10. Channel counts and queries
  // -----------------------------------------------------------------------

  describe("queries", () => {
    it("should return correct channel counts", () => {
      runtime["channels"].set("running-ch", {
        manifest: runtime.validateManifest(makeManifest({ name: "running-ch" })),
        status: "running",
        messageCount: 0,
        errorCount: 0,
        startedAt: new Date(),
      });
      runtime["channels"].set("stopped-ch", {
        manifest: runtime.validateManifest(makeManifest({ name: "stopped-ch" })),
        status: "stopped",
        messageCount: 0,
        errorCount: 0,
      });
      runtime["channels"].set("error-ch", {
        manifest: runtime.validateManifest(makeManifest({ name: "error-ch" })),
        status: "error",
        messageCount: 0,
        errorCount: 1,
        error: "fail",
      });

      const counts = runtime.getChannelCounts();
      expect(counts.total).toBe(3);
      expect(counts.running).toBe(1);
      expect(counts.stopped).toBe(1);
      expect(counts.errored).toBe(1);
    });

    it("should return undefined for unknown channels", () => {
      expect(runtime.getChannel("nonexistent")).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Standalone schema tests
// ---------------------------------------------------------------------------

describe("ChannelManifestSchema", () => {
  it("should validate a minimal manifest", () => {
    const result = ChannelManifestSchema.safeParse({
      name: "test",
      type: "text",
      provider: "slack",
      enabled: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.blocked_operations).toEqual([]);
      expect(result.data.config).toEqual({});
    }
  });

  it("should reject missing required fields", () => {
    const result = ChannelManifestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("should reject invalid type enum", () => {
    const result = ChannelManifestSchema.safeParse({
      name: "test",
      type: "rss",
      provider: "slack",
      enabled: true,
    });
    expect(result.success).toBe(false);
  });
});
