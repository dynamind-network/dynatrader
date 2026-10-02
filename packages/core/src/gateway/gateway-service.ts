/**
 * Gateway Service
 *
 * Manages multiple gateway integrations (Discord, Telegram, etc.)
 * through a unified plugin interface.
 *
 * Responsibilities:
 * - Register/unregister named gateway plugins
 * - Broadcast events to all registered plugins
 * - Query aggregated status across all gateways
 * - Provide a DiscordPlugin wrapper over DiscordGateway
 */

import type { DiscordConfig, GatewayStatus, MessageCallback } from "./discord-gateway";
import { DiscordGateway } from "./discord-gateway";
import { Logger } from "../audit/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A gateway event that can be broadcast to all registered plugins.
 */
export interface GatewayEvent {
  /** Event type identifier (e.g. "trade_alert", "system_notification") */
  type: string;
  /** Optional target channel identifier */
  channel?: string;
  /** Message content */
  content: string;
  /** Optional structured data payload */
  data?: Record<string, unknown>;
  /** When the event was created */
  timestamp: Date;
}

/**
 * Unified interface that all gateway plugins must implement.
 */
export interface GatewayPlugin {
  /** Human-readable plugin name */
  readonly name: string;

  /** Initialize the plugin with configuration. */
  initialize(config: Record<string, unknown>): Promise<void>;

  /** Start the plugin (connect to the service). */
  start(): Promise<void>;

  /** Stop the plugin (disconnect and clean up). */
  stop(): Promise<void>;

  /** Send a message to a specific channel. */
  send(channel: string, content: string): Promise<void>;

  /** Get current connection status. */
  getStatus(): GatewayStatus;
}

// ---------------------------------------------------------------------------
// GatewayService
// ---------------------------------------------------------------------------

export class GatewayService {
  private readonly gateways = new Map<string, GatewayPlugin>();
  private readonly logger = new Logger("GatewayService");

  /**
   * Register a gateway plugin under the given name.
   * Throws if a plugin with the same name is already registered.
   */
  register(name: string, plugin: GatewayPlugin): void {
    if (this.gateways.has(name)) {
      throw new Error(`Gateway plugin "${name}" is already registered`);
    }
    this.gateways.set(name, plugin);
    this.logger.info("Gateway plugin registered", { name });
  }

  /**
   * Unregister a previously registered gateway plugin.
   * Does nothing if the name is not found.
   */
  unregister(name: string): void {
    if (!this.gateways.has(name)) return;
    this.gateways.delete(name);
    this.logger.info("Gateway plugin unregistered", { name });
  }

  /**
   * Get a registered gateway plugin by name.
   * Returns undefined if not found.
   */
  get(name: string): GatewayPlugin | undefined {
    return this.gateways.get(name);
  }

  /**
   * Broadcast a gateway event to all registered plugins that support the
   * event's target channel. Each plugin's send() is called individually;
   * failures in one plugin do not affect others.
   */
  async broadcast(event: GatewayEvent): Promise<void> {
    if (this.gateways.size === 0) {
      this.logger.warn("No gateways registered for broadcast", { eventType: event.type });
      return;
    }

    const results = await Promise.allSettled(
      Array.from(this.gateways.entries()).map(async ([name, plugin]) => {
        const targetChannel = event.channel ?? name;
        await plugin.send(targetChannel, event.content);
      }),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "rejected") {
        const name = Array.from(this.gateways.keys())[i];
        this.logger.error("Broadcast failed for gateway", {
          name,
          eventType: event.type,
          error: result.reason,
        });
      }
    }
  }

  /**
   * Get the status of all registered gateway plugins.
   */
  getStatus(): Record<string, GatewayStatus> {
    const statuses: Record<string, GatewayStatus> = {};
    for (const [name, plugin] of this.gateways) {
      statuses[name] = plugin.getStatus();
    }
    return statuses;
  }
}

// ---------------------------------------------------------------------------
// DiscordPlugin — GatewayPlugin wrapper over DiscordGateway
// ---------------------------------------------------------------------------

export interface DiscordPluginConfig {
  /** Discord bot configuration */
  discord: DiscordConfig;
}

export class DiscordPlugin implements GatewayPlugin {
  readonly name = "discord";
  private readonly gateway: DiscordGateway;

  constructor(gateway?: DiscordGateway) {
    this.gateway = gateway ?? new DiscordGateway();
  }

  async initialize(config: Record<string, unknown>): Promise<void> {
    const cfg = config as unknown as DiscordPluginConfig;
    await this.gateway.initialize(cfg.discord);
  }

  async start(): Promise<void> {
    await this.gateway.start();
  }

  async stop(): Promise<void> {
    await this.gateway.stop();
  }

  async send(channel: string, content: string): Promise<void> {
    await this.gateway.sendMessage(channel, content);
  }

  getStatus(): GatewayStatus {
    return this.gateway.getStatus();
  }

  /**
   * Register a message callback on the underlying DiscordGateway.
   */
  onMessage(callback: MessageCallback): void {
    this.gateway.onMessage(callback);
  }

  /**
   * Return the underlying DiscordGateway instance for advanced use.
   */
  getDiscordGateway(): DiscordGateway {
    return this.gateway;
  }
}
