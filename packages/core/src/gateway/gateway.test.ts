/**
 * Tests for DiscordGateway and GatewayService
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted state & discord.js mock
// ---------------------------------------------------------------------------

const eventHandlers = new Map<string, (...args: any[]) => void>();
type MockMessage = { author: { bot: boolean }; content: string; id: string };

const mockSend = vi.fn().mockResolvedValue({ id: "mock-msg-id" });
const mockChannel = {
  isTextBased: () => true,
  send: mockSend,
};
const mockFetch = vi.fn().mockResolvedValue(mockChannel);

const mockClientInstance = {
  login: vi.fn().mockResolvedValue("logged-in"),
  destroy: vi.fn(),
  on: vi.fn((event: string, handler: (...args: any[]) => void) => {
    eventHandlers.set(event, handler);
  }),
  guilds: { cache: new Map() },
  channels: { cache: new Map(), fetch: mockFetch },
};

vi.mock("discord.js", () => ({
  Client: vi.fn(() => mockClientInstance),
  GatewayIntentBits: {
    Guilds: 1,
    GuildMessages: 2,
    MessageContent: 4,
  },
  Events: {
    ClientReady: "ready",
    MessageCreate: "messageCreate",
    ShardDisconnect: "shardDisconnect",
    ShardReconnecting: "shardReconnecting",
    ShardResume: "shardResume",
  },
  EmbedBuilder: class MockEmbedBuilder {
    data: Record<string, unknown>;
    constructor(data?: Record<string, unknown>) {
      this.data = data ?? {};
    }
  },
}));

// ---------------------------------------------------------------------------
// Imports (must come after mocks)
// ---------------------------------------------------------------------------

import {
  DiscordGateway,
  type DiscordConfig,
  type GatewayStatus,
} from "./discord-gateway";
import {
  GatewayService,
  DiscordPlugin,
  type GatewayEvent,
  type GatewayPlugin,
} from "./gateway-service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultDiscordConfig: DiscordConfig = {
  token: "test-token",
  clientId: "test-client-id",
  guildId: "test-guild-id",
};

function fireClientReady(): void {
  const handler = eventHandlers.get("ready");
  if (handler) handler();
}

function fireMessageCreate(msg: MockMessage): void {
  const handler = eventHandlers.get("messageCreate");
  if (handler) handler(msg);
}

// ---------------------------------------------------------------------------
// DiscordGateway
// ---------------------------------------------------------------------------

describe("DiscordGateway", () => {
  let gateway: DiscordGateway;

  beforeEach(() => {
    vi.clearAllMocks();
    eventHandlers.clear();
    mockFetch.mockResolvedValue(mockChannel);
    gateway = new DiscordGateway();
  });

  afterEach(async () => {
    await gateway.stop();
  });

  /* ------------------------------------------------------------------ */
  /*  Initialization                                                     */
  /* ------------------------------------------------------------------ */

  describe("initialize", () => {
    it("should set up client with default intents", async () => {
      await gateway.initialize(defaultDiscordConfig);

      const { Client } = await import("discord.js");
      expect(Client).toHaveBeenCalledWith({
        intents: [1, 2, 4], // Guilds, GuildMessages, MessageContent
      });
    });

    it("should set up client with custom intents", async () => {
      await gateway.initialize({
        ...defaultDiscordConfig,
        intents: [1], // Guilds only
      });

      const { Client } = await import("discord.js");
      expect(Client).toHaveBeenCalledWith({ intents: [1] });
    });

    it("should register ready and message event handlers", async () => {
      await gateway.initialize(defaultDiscordConfig);

      expect(mockClientInstance.on).toHaveBeenCalledWith("ready", expect.any(Function));
      expect(mockClientInstance.on).toHaveBeenCalledWith("messageCreate", expect.any(Function));
      expect(mockClientInstance.on).toHaveBeenCalledWith("shardDisconnect", expect.any(Function));
      expect(mockClientInstance.on).toHaveBeenCalledWith("shardReconnecting", expect.any(Function));
      expect(mockClientInstance.on).toHaveBeenCalledWith("shardResume", expect.any(Function));
    });
  });

  /* ------------------------------------------------------------------ */
  /*  Lifecycle (start / stop)                                           */
  /* ------------------------------------------------------------------ */

  describe("start / stop", () => {
    it("should throw if start is called before initialize", async () => {
      const uninitialized = new DiscordGateway();
      await expect(uninitialized.start()).rejects.toThrow(/not initialized/i);
    });

    it("should call client.login on start", async () => {
      await gateway.initialize(defaultDiscordConfig);
      await gateway.start();

      expect(mockClientInstance.login).toHaveBeenCalledWith("test-token");
    });

    it("should update status after ready event fires", async () => {
      await gateway.initialize(defaultDiscordConfig);
      await gateway.start();

      // Before ready
      let status = gateway.getStatus();
      expect(status.connected).toBe(false);

      // Fire ready
      fireClientReady();

      status = gateway.getStatus();
      expect(status.connected).toBe(true);
      expect(status.startedAt).toBeInstanceOf(Date);
    });

    it("should call client.destroy on stop", async () => {
      await gateway.initialize(defaultDiscordConfig);
      await gateway.start();
      fireClientReady();

      await gateway.stop();

      expect(mockClientInstance.destroy).toHaveBeenCalled();
    });

    it("should reset status on stop", async () => {
      await gateway.initialize(defaultDiscordConfig);
      await gateway.start();
      fireClientReady();
      await gateway.stop();

      const status = gateway.getStatus();
      expect(status.connected).toBe(false);
      expect(status.guildCount).toBe(0);
      expect(status.channelCount).toBe(0);
    });

    it("should not throw when stopping twice", async () => {
      await gateway.initialize(defaultDiscordConfig);
      await gateway.stop(); // first stop calls destroy once
      await gateway.stop(); // second stop should be safe (no-op)
      // destroy was called once by the first stop
      expect(mockClientInstance.destroy).toHaveBeenCalledTimes(1);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  Messaging                                                          */
  /* ------------------------------------------------------------------ */

  describe("sendMessage", () => {
    it("should throw if not started", async () => {
      await gateway.initialize(defaultDiscordConfig);
      // Not started yet
      await expect(gateway.sendMessage("ch-1", "hello")).rejects.toThrow(/not started/i);
    });

    it("should fetch the channel and send a message", async () => {
      await gateway.initialize(defaultDiscordConfig);
      await gateway.start();
      fireClientReady();

      const result = await gateway.sendMessage("ch-1", "Hello from DynaTrader");

      expect(mockFetch).toHaveBeenCalledWith("ch-1");
      expect(mockSend).toHaveBeenCalledWith("Hello from DynaTrader");
      expect(result).toEqual({ id: "mock-msg-id" });
    });

    it("should throw if channel is not text-based", async () => {
      const voiceChannel = { isTextBased: () => false, send: vi.fn() };
      mockFetch.mockResolvedValue(voiceChannel);

      await gateway.initialize(defaultDiscordConfig);
      await gateway.start();
      fireClientReady();

      await expect(gateway.sendMessage("ch-voice", "hello")).rejects.toThrow(/not text-based/i);
    });

    it("should handle fetch errors gracefully", async () => {
      mockFetch.mockRejectedValue(new Error("Discord API error"));

      await gateway.initialize(defaultDiscordConfig);
      await gateway.start();
      fireClientReady();

      await expect(gateway.sendMessage("ch-bad", "hello")).rejects.toThrow();
    });
  });

  /* ------------------------------------------------------------------ */
  /*  sendEmbed                                                          */
  /* ------------------------------------------------------------------ */

  describe("sendEmbed", () => {
    it("should send an embed to the channel", async () => {
      await gateway.initialize(defaultDiscordConfig);
      await gateway.start();
      fireClientReady();

      const { EmbedBuilder } = await import("discord.js");
      const embed = new EmbedBuilder({ title: "Test Embed" });
      const result = await gateway.sendEmbed("ch-1", embed);

      expect(mockFetch).toHaveBeenCalledWith("ch-1");
      expect(mockSend).toHaveBeenCalledWith({ embeds: [embed] });
      expect(result).toEqual({ id: "mock-msg-id" });
    });
  });

  /* ------------------------------------------------------------------ */
  /*  Message callbacks                                                  */
  /* ------------------------------------------------------------------ */

  describe("onMessage", () => {
    it("should call registered callback on incoming message", async () => {
      await gateway.initialize(defaultDiscordConfig);
      await gateway.start();
      fireClientReady();

      const callback = vi.fn();
      gateway.onMessage(callback);

      fireMessageCreate({
        author: { bot: false },
        content: "Hello bot!",
        id: "msg-1",
      });

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ content: "Hello bot!" }),
      );
    });

    it("should filter out bot messages", async () => {
      await gateway.initialize(defaultDiscordConfig);
      await gateway.start();
      fireClientReady();

      const callback = vi.fn();
      gateway.onMessage(callback);

      fireMessageCreate({
        author: { bot: true },
        content: "Bot message",
        id: "msg-2",
      });

      expect(callback).not.toHaveBeenCalled();
    });

    it("should support multiple callbacks", async () => {
      await gateway.initialize(defaultDiscordConfig);
      await gateway.start();
      fireClientReady();

      const cb1 = vi.fn();
      const cb2 = vi.fn();
      gateway.onMessage(cb1);
      gateway.onMessage(cb2);

      fireMessageCreate({
        author: { bot: false },
        content: "Hi",
        id: "msg-3",
      });

      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb2).toHaveBeenCalledTimes(1);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  getStatus                                                          */
  /* ------------------------------------------------------------------ */

  describe("getStatus", () => {
    it("should report not connected before initialization", () => {
      const fresh = new DiscordGateway();
      const status = fresh.getStatus();
      expect(status.connected).toBe(false);
      expect(status.guildCount).toBe(0);
      expect(status.channelCount).toBe(0);
    });

    it("should reflect guild and channel counts", async () => {
      // Set up some cache data
      mockClientInstance.guilds.cache = new Map([
        ["guild-1", { id: "guild-1" }],
        ["guild-2", { id: "guild-2" }],
      ]);
      mockClientInstance.channels.cache = new Map([
        ["ch-1", { id: "ch-1" }],
        ["ch-2", { id: "ch-2" }],
        ["ch-3", { id: "ch-3" }],
      ]);

      await gateway.initialize(defaultDiscordConfig);
      await gateway.start();
      fireClientReady();

      const status = gateway.getStatus();
      expect(status.connected).toBe(true);
      expect(status.guildCount).toBe(2);
      expect(status.channelCount).toBe(3);
    });
  });
});

// ---------------------------------------------------------------------------
// GatewayService
// ---------------------------------------------------------------------------

describe("GatewayService", () => {
  let service: GatewayService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new GatewayService();
  });

  /* ------------------------------------------------------------------ */
  /*  register / unregister / get                                        */
  /* ------------------------------------------------------------------ */

  describe("register / unregister / get", () => {
    it("should register a plugin", () => {
      const plugin = createMockPlugin("discord");
      service.register("discord", plugin);

      expect(service.get("discord")).toBe(plugin);
    });

    it("should throw on duplicate registration", () => {
      const plugin = createMockPlugin("discord");
      service.register("discord", plugin);

      expect(() => service.register("discord", createMockPlugin("discord"))).toThrow(/already registered/i);
    });

    it("should unregister a plugin", () => {
      const plugin = createMockPlugin("discord");
      service.register("discord", plugin);
      service.unregister("discord");

      expect(service.get("discord")).toBeUndefined();
    });

    it("should not throw when unregistering unknown name", () => {
      expect(() => service.unregister("nonexistent")).not.toThrow();
    });

    it("should return undefined for unknown plugin", () => {
      expect(service.get("unknown")).toBeUndefined();
    });
  });

  /* ------------------------------------------------------------------ */
  /*  broadcast                                                          */
  /* ------------------------------------------------------------------ */

  describe("broadcast", () => {
    it("should send event content to all registered plugins", async () => {
      const p1 = createMockPlugin("discord");
      const p2 = createMockPlugin("telegram");
      service.register("discord", p1);
      service.register("telegram", p2);

      const event: GatewayEvent = {
        type: "trade_alert",
        content: "BTC moved 5%",
        timestamp: new Date(),
      };

      await service.broadcast(event);

      expect(p1.send).toHaveBeenCalledWith("discord", "BTC moved 5%");
      expect(p2.send).toHaveBeenCalledWith("telegram", "BTC moved 5%");
    });

    it("should use the channel field when provided", async () => {
      const plugin = createMockPlugin("discord");
      service.register("discord", plugin);

      const event: GatewayEvent = {
        type: "alert",
        channel: "trading-alerts",
        content: "Alert!",
        timestamp: new Date(),
      };

      await service.broadcast(event);

      expect(plugin.send).toHaveBeenCalledWith("trading-alerts", "Alert!");
    });

    it("should not throw when no gateways are registered", async () => {
      const event: GatewayEvent = {
        type: "test",
        content: "test",
        timestamp: new Date(),
      };

      await service.broadcast(event); // Should not throw
    });

    it("should continue if one plugin fails", async () => {
      const p1 = createMockPlugin("p1");
      const p2 = createMockPlugin("p2");
      p2.send = vi.fn().mockRejectedValue(new Error("Send failed")) as any;

      service.register("p1", p1);
      service.register("p2", p2);

      const event: GatewayEvent = {
        type: "test",
        content: "message",
        timestamp: new Date(),
      };

      // Should not throw; error is logged internally
      await service.broadcast(event);

      expect(p1.send).toHaveBeenCalled();
      expect(p2.send).toHaveBeenCalled();
    });
  });

  /* ------------------------------------------------------------------ */
  /*  getStatus                                                          */
  /* ------------------------------------------------------------------ */

  describe("getStatus", () => {
    it("should return status for all registered plugins", () => {
      const p1 = createMockPlugin("discord");
      const p2 = createMockPlugin("telegram");
      service.register("discord", p1);
      service.register("telegram", p2);

      const statuses = service.getStatus();

      expect(Object.keys(statuses)).toEqual(["discord", "telegram"]);
      expect(statuses.discord).toEqual(p1.getStatus());
      expect(statuses.telegram).toEqual(p2.getStatus());
    });

    it("should return empty object when no plugins registered", () => {
      expect(service.getStatus()).toEqual({});
    });
  });
});

// ---------------------------------------------------------------------------
// DiscordPlugin
// ---------------------------------------------------------------------------

describe("DiscordPlugin", () => {
  let discordGateway: DiscordGateway;
  let plugin: DiscordPlugin;

  beforeEach(async () => {
    vi.clearAllMocks();
    eventHandlers.clear();
    discordGateway = new DiscordGateway();
    plugin = new DiscordPlugin(discordGateway);
    await discordGateway.initialize(defaultDiscordConfig);
    await discordGateway.start();
    fireClientReady();
  });

  afterEach(async () => {
    await plugin.stop();
  });

  it("should have name 'discord'", () => {
    expect(plugin.name).toBe("discord");
  });

  it("should send messages via the wrapped gateway", async () => {
    await plugin.send("ch-1", "Hello from plugin");
    expect(mockSend).toHaveBeenCalledWith("Hello from plugin");
  });

  it("should expose the underlying gateway", () => {
    expect(plugin.getDiscordGateway()).toBe(discordGateway);
  });

  it("should forward onMessage calls", async () => {
    const callback = vi.fn();
    plugin.onMessage(callback);

    fireMessageCreate({
      author: { bot: false },
      content: "Plugin test",
      id: "msg-p1",
    });

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Plugin test" }),
    );
  });

  it("should return status from the underlying gateway", () => {
    const status = plugin.getStatus();
    expect(status).toHaveProperty("connected");
    expect(status).toHaveProperty("guildCount");
    expect(status).toHaveProperty("channelCount");
  });
});

// ---------------------------------------------------------------------------
// Factory helper
// ---------------------------------------------------------------------------

function createMockPlugin(name: string): GatewayPlugin {
  return {
    name,
    initialize: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue({
      connected: true,
      guildCount: 0,
      channelCount: 0,
    }),
  };
}
