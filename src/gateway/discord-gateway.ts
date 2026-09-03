/**
 * DiscordGateway
 *
 * Discord bot gateway for Dyna-Trader.
 *
 * Responsibilities:
 * - Connects to Discord via a bot token using discord.js v14
 * - Sends messages and embeds to Discord channels
 * - Registers message event handlers
 * - Reports connection status
 * - Auto-reconnects on disconnect (native discord.js behavior)
 */

import {
  Client,
  GatewayIntentBits,
  Events,
} from "discord.js";
import type { Message, EmbedBuilder } from "discord.js";
import { Logger } from "../audit/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiscordConfig {
  /** Discord bot token */
  token: string;
  /** Discord application client ID */
  clientId: string;
  /** Optional guild (server) ID to scope the bot to */
  guildId?: string;
  /** Gateway intents; defaults to Guilds, GuildMessages, MessageContent */
  intents?: GatewayIntentBits[];
}

export interface GatewayStatus {
  /** Whether the client is currently connected */
  connected: boolean;
  /** Timestamp when the client successfully connected */
  startedAt?: Date;
  /** Number of guilds the bot is in */
  guildCount: number;
  /** Number of channels the bot can see */
  channelCount: number;
}

/** Callback invoked on each incoming message. */
export type MessageCallback = (msg: Message) => void;

// ---------------------------------------------------------------------------
// DiscordGateway
// ---------------------------------------------------------------------------

export class DiscordGateway {
  private client: Client | null = null;
  private config: DiscordConfig | null = null;
  private startedAt: Date | null = null;
  private readonly messageCallbacks = new Set<MessageCallback>();
  private readonly logger: Logger;
  private readyBound: (() => void) | null = null;
  private messageBound: ((msg: Message) => void) | null = null;

  constructor() {
    this.logger = new Logger("DiscordGateway");
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Initialize the Discord client with the provided config.
   * Sets up intents and registers internal event handlers.
   */
  async initialize(config: DiscordConfig): Promise<void> {
    this.config = config;

    const intents = config.intents ?? [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ];

    this.client = new Client({ intents });

    // --- ready handler ---
    this.readyBound = () => {
      this.startedAt = new Date();
      const guildCount = this.client?.guilds.cache.size ?? 0;
      const channelCount = this.client?.channels.cache.size ?? 0;
      this.logger.info("Discord client ready", { guilds: guildCount, channels: channelCount });
    };
    this.client.on(Events.ClientReady, this.readyBound);

    // --- message handler ---
    this.messageBound = (msg: Message) => {
      if (msg.author.bot) return; // ignore own messages
      for (const cb of this.messageCallbacks) {
        try {
          cb(msg);
        } catch (err) {
          this.logger.error("Message callback error", { error: err });
        }
      }
    };
    this.client.on(Events.MessageCreate, this.messageBound);

    // Log disconnects (discord.js auto-reconnects natively)
    this.client.on(Events.ShardDisconnect, (_event, shardId) => {
      this.logger.warn("Discord shard disconnected", { shardId });
    });
    this.client.on(Events.ShardReconnecting, (shardId) => {
      this.logger.info("Discord shard reconnecting", { shardId });
    });
    this.client.on(Events.ShardResume, (shardId, replayed) => {
      this.logger.info("Discord shard resumed", { shardId, replayed });
    });
  }

  /**
   * Log in to Discord using the configured bot token.
   */
  async start(): Promise<void> {
    if (!this.config) {
      throw new Error("DiscordGateway not initialized: call initialize() first");
    }
    if (!this.client) {
      throw new Error("DiscordGateway client not available");
    }
    try {
      await this.client.login(this.config.token);
      this.logger.info("Discord client logged in");
    } catch (err) {
      this.logger.error("Discord login failed", { error: err });
      throw err;
    }
  }

  /**
   * Log out and destroy the Discord client.
   */
  async stop(): Promise<void> {
    if (!this.client) return;
    try {
      this.client.destroy();
      this.logger.info("Discord client destroyed");
    } catch (err) {
      this.logger.error("Error destroying Discord client", { error: err });
    }
    this.client = null;
    this.startedAt = null;
  }

  // -----------------------------------------------------------------------
  // Messaging
  // -----------------------------------------------------------------------

  /**
   * Send a plain text message to the specified channel.
   */
  async sendMessage(channelId: string, content: string): Promise<Message> {
    this.ensureReady();
    try {
      const channel = await this.client!.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) {
        throw new Error(`Channel ${channelId} not found or is not text-based`);
      }
      if ("send" in channel) {
        return await channel.send(content);
      }
      throw new Error(`Channel ${channelId} does not support sending messages`);
    } catch (err) {
      this.logger.error("Failed to send message", { channelId, error: err });
      throw err;
    }
  }

  /**
   * Send an embed to the specified channel.
   */
  async sendEmbed(channelId: string, embed: EmbedBuilder): Promise<Message> {
    this.ensureReady();
    try {
      const channel = await this.client!.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) {
        throw new Error(`Channel ${channelId} not found or is not text-based`);
      }
      if ("send" in channel) {
        return await channel.send({ embeds: [embed] });
      }
      throw new Error(`Channel ${channelId} does not support sending messages`);
    } catch (err) {
      this.logger.error("Failed to send embed", { channelId, error: err });
      throw err;
    }
  }

  // -----------------------------------------------------------------------
  // Event hooks
  // -----------------------------------------------------------------------

  /**
   * Register a callback that fires on every incoming message.
   * Bot messages are automatically filtered out.
   */
  onMessage(callback: MessageCallback): void {
    this.messageCallbacks.add(callback);
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  /**
   * Return the current connection status.
   */
  getStatus(): GatewayStatus {
    const connected = this.client !== null && this.startedAt !== null;
    const guildCount = this.client?.guilds.cache.size ?? 0;
    const channelCount = this.client?.channels.cache.size ?? 0;
    return {
      connected,
      startedAt: this.startedAt ?? undefined,
      guildCount,
      channelCount,
    };
  }

  /**
   * Return the underlying discord.js Client instance.
   * Useful for advanced usage beyond this wrapper.
   */
  getClient(): Client {
    this.ensureReady();
    return this.client!;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Throw if the client has not been started yet.
   */
  private ensureReady(): void {
    if (!this.client || !this.startedAt) {
      throw new Error("DiscordGateway is not started");
    }
  }
}
