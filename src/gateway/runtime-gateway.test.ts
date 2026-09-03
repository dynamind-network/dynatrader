import { beforeEach, describe, expect, it, vi } from "vitest";

const telegramInstances: Array<Record<string, unknown>> = [];
const discordInstances: Array<Record<string, unknown>> = [];

vi.mock("./telegram/telegram-gateway", () => {
  class TelegramGateway {
    initialize = vi.fn().mockResolvedValue(undefined);
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    send = vi.fn().mockResolvedValue({ chatId: 123, messageId: 456 });

    constructor() {
      telegramInstances.push(this as unknown as Record<string, unknown>);
    }
  }

  return { TelegramGateway };
});

vi.mock("./discord-gateway", () => {
  class DiscordGateway {
    initialize = vi.fn().mockResolvedValue(undefined);
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    sendMessage = vi.fn().mockResolvedValue({ id: "message-1" });

    constructor() {
      discordInstances.push(this as unknown as Record<string, unknown>);
    }
  }

  return { DiscordGateway };
});

import {
  buildGatewayRuntimeStatus,
  resolveGatewayTarget,
  sendGatewayMessage,
  validateGatewayLaunchRequirements,
} from "./runtime-gateway";

describe("gateway runtime helpers", () => {
  beforeEach(() => {
    telegramInstances.length = 0;
    discordInstances.length = 0;
  });

  it("builds readiness from config and environment", () => {
    const status = buildGatewayRuntimeStatus(
      {
        gateway: {
          telegram: { enabled: true, token: "cfg-token", allowedChatIds: [123] },
          discord: { enabled: false },
          agentChat: { url: "http://localhost:3000/api/chat" },
        },
      },
      {},
    );

    expect(status.telegram.configured).toBe(true);
    expect(status.telegram.detail).toContain("allowed chats");
    expect(status.discord.configured).toBe(false);
    expect(status.agentChat.configured).toBe(true);
  });

  it("parses explicit gateway send targets", () => {
    expect(resolveGatewayTarget("telegram:123456")).toEqual({
      provider: "telegram",
      destination: "123456",
    });
    expect(resolveGatewayTarget("discord/general")).toEqual({
      provider: "discord",
      destination: "general",
    });
    expect(resolveGatewayTarget("invalid")).toBeNull();
  });

  it("fails closed for live launches without approvals and exchange credentials", () => {
    const errors = validateGatewayLaunchRequirements(
      {
        exchange: { id: "", apiKey: "", secret: "" },
        auth: { owner: { id: "" }, approval_required_for: [] },
      },
      {},
      { mode: "live", liveTradingEnabled: true },
    );

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("exchange.id"),
        expect.stringContaining("approval_required_for"),
      ]),
    );
  });

  it("sends telegram messages through the real gateway path", async () => {
    const deliveredTo = await sendGatewayMessage(
      { target: "telegram:123456", message: "hello" },
      {
        gateway: {
          telegram: {
            enabled: true,
            token: "token-from-config",
          },
        },
      },
      {},
    );

    expect(deliveredTo).toBe("telegram:123456");
    expect(telegramInstances).toHaveLength(1);
    const telegram = telegramInstances[0] as unknown as {
      initialize: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
    };
    expect(telegram.initialize).toHaveBeenCalledWith({
      token: "token-from-config",
      allowedChatIds: undefined,
    });
    expect(telegram.send).toHaveBeenCalledWith("123456", "hello");
    expect(telegram.stop).toHaveBeenCalled();
  });

  it("sends discord messages through the real gateway path", async () => {
    const deliveredTo = await sendGatewayMessage(
      { target: "discord:channel-1", message: "trade alert" },
      {
        gateway: {
          discord: {
            enabled: true,
            token: "discord-token",
            clientId: "discord-client",
          },
        },
      },
      {},
    );

    expect(deliveredTo).toBe("discord:channel-1");
    expect(discordInstances).toHaveLength(1);
    const discord = discordInstances[0] as unknown as {
      initialize: ReturnType<typeof vi.fn>;
      start: ReturnType<typeof vi.fn>;
      sendMessage: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
    };
    expect(discord.initialize).toHaveBeenCalledWith({
      token: "discord-token",
      clientId: "discord-client",
    });
    expect(discord.start).toHaveBeenCalled();
    expect(discord.sendMessage).toHaveBeenCalledWith("channel-1", "trade alert");
    expect(discord.stop).toHaveBeenCalled();
  });
});
