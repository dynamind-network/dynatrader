import { DiscordGateway } from "./discord-gateway";
import { TelegramGateway } from "./telegram/telegram-gateway";
import type { RuntimeConfig, WorkspaceManifest } from "../orchestration/workspace/types";

export interface GatewayChannelRuntimeStatus {
  enabled: boolean;
  configured: boolean;
  detail: string;
}

export interface GatewayRuntimeStatus {
  telegram: GatewayChannelRuntimeStatus;
  discord: GatewayChannelRuntimeStatus;
  agentChat: GatewayChannelRuntimeStatus;
}

export interface GatewaySendRequest {
  target: string;
  message: string;
}

export interface GatewayTarget {
  provider: "telegram" | "discord";
  destination?: string;
}

export interface GatewayLaunchRequirements {
  mode: RuntimeConfig["mode"];
  liveTradingEnabled?: boolean;
  enableMicroLiveMode?: boolean;
}

export interface ResolvedGatewayRuntimeConfig {
  telegram: {
    enabled: boolean;
    configured: boolean;
    token: string;
    allowedChatIds: number[];
    defaultChatId: string;
  };
  discord: {
    enabled: boolean;
    configured: boolean;
    token: string;
    clientId: string;
    defaultChannelId: string;
  };
  agentChat: {
    url: string;
  };
}

type GatewayConfigShape = {
  gateway?: {
    telegram?: {
      enabled?: boolean;
      token?: string;
      allowedChatIds?: Array<number | string>;
      defaultChatId?: string;
    };
    discord?: {
      enabled?: boolean;
      token?: string;
      clientId?: string;
      defaultChannelId?: string;
    };
    agentChat?: {
      url?: string;
    };
  };
  exchange?: {
    id?: string;
    apiKey?: string;
    secret?: string;
  };
  auth?: {
    owner?: {
      id?: string;
    };
    approval_required_for?: unknown[];
  };
};

export function buildGatewayRuntimeStatus(
  config: WorkspaceManifest["config"] | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): GatewayRuntimeStatus {
  const gateway = resolveGatewayRuntimeConfig(config, env);

  const telegram = {
    enabled: gateway.telegram.enabled,
    configured: gateway.telegram.enabled && Boolean(gateway.telegram.token),
    detail: gateway.telegram.enabled
      ? gateway.telegram.token
        ? gateway.telegram.allowedChatIds.length > 0
          ? `enabled, token present, ${gateway.telegram.allowedChatIds.length} allowed chats`
          : "enabled, token present"
        : "enabled in config, TELEGRAM_BOT_TOKEN missing"
      : gateway.telegram.token
        ? "disabled in config, token present"
        : "disabled",
  };

  const discord = {
    enabled: gateway.discord.enabled,
    configured: gateway.discord.enabled && Boolean(gateway.discord.token) && Boolean(gateway.discord.clientId),
    detail: gateway.discord.enabled
      ? gateway.discord.token && gateway.discord.clientId
        ? gateway.discord.defaultChannelId
          ? `enabled, token + client ID present, default channel ${gateway.discord.defaultChannelId}`
          : "enabled, token + client ID present"
        : "enabled in config, DISCORD_BOT_TOKEN or DISCORD_CLIENT_ID missing"
      : gateway.discord.token || gateway.discord.clientId
        ? "disabled in config, credentials present"
        : "disabled",
  };

  const agentChatUrl = gateway.agentChat.url ?? env["DYNATRADER_AGENT_CHAT_URL"]?.trim() ?? "";
  const agentChat = {
    enabled: Boolean(agentChatUrl),
    configured: Boolean(agentChatUrl),
    detail: agentChatUrl ? "agent chat proxy configured" : "DYNATRADER_AGENT_CHAT_URL missing",
  };

  return {
    telegram,
    discord,
    agentChat,
  };
}

export function resolveGatewayRuntimeConfig(
  config: WorkspaceManifest["config"] | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedGatewayRuntimeConfig {
  const gateway = readGatewayConfig(config, env);
  return {
    telegram: {
      enabled: gateway.telegram.enabled,
      configured: Boolean(gateway.telegram.token),
      token: gateway.telegram.token,
      allowedChatIds: gateway.telegram.allowedChatIds,
      defaultChatId: gateway.telegram.defaultChatId,
    },
    discord: {
      enabled: gateway.discord.enabled,
      configured: Boolean(gateway.discord.token) && Boolean(gateway.discord.clientId),
      token: gateway.discord.token,
      clientId: gateway.discord.clientId,
      defaultChannelId: gateway.discord.defaultChannelId,
    },
    agentChat: {
      url: gateway.agentChat.url,
    },
  };
}

export function resolveGatewayTarget(target: string): GatewayTarget | null {
  const value = target.trim();
  if (!value) return null;

  const match = value.match(/^(telegram|discord)(?:(?::|\/)(.+))?$/i);
  if (!match?.[1]) return null;

  const provider = match[1].toLowerCase() as "telegram" | "discord";
  const destination = match[2]?.trim();
  return {
    provider,
    destination: destination || undefined,
  };
}

export function validateGatewayLaunchRequirements(
  config: WorkspaceManifest["config"] | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  requirements: GatewayLaunchRequirements,
): string[] {
  const errors: string[] = [];
  const gateway = readGatewayConfig(config, env);
  const liveMode = requirements.mode === "live" || requirements.liveTradingEnabled === true || requirements.enableMicroLiveMode === true;

  if (liveMode) {
    const exchangeId = gateway.exchange.id?.trim() ?? "";
    const apiKey = gateway.exchange.apiKey?.trim() ?? "";
    const secret = gateway.exchange.secret?.trim() ?? "";
    if (!exchangeId || !apiKey || !secret) {
      errors.push("live trading requires exchange.id, exchange.apiKey, and exchange.secret");
    }

    const ownerId = gateway.auth.owner?.id?.trim() ?? "";
    const approvals = Array.isArray(gateway.auth.approval_required_for) ? gateway.auth.approval_required_for : [];
    if (!ownerId || approvals.length === 0) {
      errors.push("live trading requires auth.owner.id and at least one approval_required_for entry");
    }
  }

  if (gateway.telegram.enabled && !gateway.telegram.token) {
    const envToken = env["TELEGRAM_BOT_TOKEN"]?.trim() ?? "";
    if (!envToken) {
      errors.push("Telegram gateway is enabled but TELEGRAM_BOT_TOKEN is missing");
    }
  }

  if (gateway.discord.enabled) {
    const envToken = env["DISCORD_BOT_TOKEN"]?.trim() ?? "";
    const envClientId = env["DISCORD_CLIENT_ID"]?.trim() ?? "";
    if (!(gateway.discord.token || envToken) || !(gateway.discord.clientId || envClientId)) {
      errors.push("Discord gateway is enabled but DISCORD_BOT_TOKEN or DISCORD_CLIENT_ID is missing");
    }
  }

  return errors;
}

export async function sendGatewayMessage(
  request: GatewaySendRequest,
  config: WorkspaceManifest["config"] | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const target = resolveGatewayTarget(request.target);
  if (!target) {
    throw new Error('Gateway target must start with "telegram" or "discord"');
  }

  const gateway = readGatewayConfig(config, env);
  if (target.provider === "telegram") {
    const token = gateway.telegram.token || env["TELEGRAM_BOT_TOKEN"]?.trim() || "";
    if (!token) {
      throw new Error("Telegram gateway is not configured: TELEGRAM_BOT_TOKEN is missing");
    }

    const chatId = target.destination || gateway.telegram.defaultChatId || env["TELEGRAM_DEFAULT_CHAT_ID"]?.trim() || "";
    if (!chatId) {
      throw new Error('Telegram send requires a chat ID. Use "telegram:<chatId>" or set gateway.telegram.defaultChatId.');
    }

  const gatewayClient = new TelegramGateway();
  await gatewayClient.initialize({
    token,
    allowedChatIds: gateway.telegram.allowedChatIds.length > 0
      ? gateway.telegram.allowedChatIds.map((value) => Number(value)).filter((value) => Number.isFinite(value))
      : undefined,
  });
  try {
    await gatewayClient.send(chatId, request.message);
  } finally {
    await gatewayClient.stop().catch(() => {});
  }
  return `telegram:${chatId}`;
  }

  const token = gateway.discord.token || env["DISCORD_BOT_TOKEN"]?.trim() || "";
  const clientId = gateway.discord.clientId || env["DISCORD_CLIENT_ID"]?.trim() || "";
  if (!token || !clientId) {
    throw new Error("Discord gateway is not configured: DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID are required");
  }

  const channelId = target.destination || gateway.discord.defaultChannelId || env["DISCORD_DEFAULT_CHANNEL_ID"]?.trim() || "";
  if (!channelId) {
    throw new Error('Discord send requires a channel ID. Use "discord:<channelId>" or set gateway.discord.defaultChannelId.');
  }

  const gatewayClient = new DiscordGateway();
  await gatewayClient.initialize({ token, clientId });
  await gatewayClient.start();
  try {
    await gatewayClient.sendMessage(channelId, request.message);
  } finally {
    await gatewayClient.stop().catch(() => {});
  }
  return `discord:${channelId}`;
}

function readGatewayConfig(
  config: WorkspaceManifest["config"] | null | undefined,
  env: NodeJS.ProcessEnv,
): {
  telegram: {
    enabled: boolean;
    token: string;
    allowedChatIds: number[];
    defaultChatId: string;
  };
  discord: {
    enabled: boolean;
    token: string;
    clientId: string;
    defaultChannelId: string;
  };
  agentChat: {
    url: string;
  };
  exchange: {
    id: string;
    apiKey: string;
    secret: string;
  };
  auth: {
    owner: {
      id: string;
    };
    approval_required_for: unknown[];
  };
} {
  const value = (config ?? {}) as GatewayConfigShape;
  const gateway = value.gateway ?? {};
  const telegramConfig = gateway.telegram ?? {};
  const discordConfig = gateway.discord ?? {};
  const allowedChatIds = normalizeNumberArray(
    telegramConfig.allowedChatIds ?? parseList(env["TELEGRAM_ALLOWED_USER_IDS"]),
  );

  return {
    telegram: {
      enabled: telegramConfig.enabled !== false && (telegramConfig.enabled === true || Boolean(telegramConfig.token) || Boolean(env["TELEGRAM_BOT_TOKEN"])),
      token: telegramConfig.token?.trim() || env["TELEGRAM_BOT_TOKEN"]?.trim() || "",
      allowedChatIds,
      defaultChatId: telegramConfig.defaultChatId?.trim() || env["TELEGRAM_DEFAULT_CHAT_ID"]?.trim() || "",
    },
    discord: {
      enabled: discordConfig.enabled !== false && (discordConfig.enabled === true || Boolean(discordConfig.token) || Boolean(env["DISCORD_BOT_TOKEN"])),
      token: discordConfig.token?.trim() || env["DISCORD_BOT_TOKEN"]?.trim() || "",
      clientId: discordConfig.clientId?.trim() || env["DISCORD_CLIENT_ID"]?.trim() || "",
      defaultChannelId: discordConfig.defaultChannelId?.trim() || env["DISCORD_DEFAULT_CHANNEL_ID"]?.trim() || "",
    },
    agentChat: {
      url: gateway.agentChat?.url?.trim() || env["DYNATRADER_AGENT_CHAT_URL"]?.trim() || "",
    },
    exchange: {
      id: value.exchange?.id?.trim() || "",
      apiKey: value.exchange?.apiKey?.trim() || "",
      secret: value.exchange?.secret?.trim() || "",
    },
    auth: {
      owner: {
        id: value.auth?.owner?.id?.trim() || "",
      },
      approval_required_for: Array.isArray(value.auth?.approval_required_for)
        ? value.auth!.approval_required_for
        : [],
    },
  };
}

function normalizeNumberArray(values: Array<number | string>): number[] {
  return values
    .map((value) => typeof value === "number" ? value : Number(value))
    .filter((value) => Number.isFinite(value));
}

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").map((value) => value.trim()).filter(Boolean);
}
