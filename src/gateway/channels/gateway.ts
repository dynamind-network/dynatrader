/**
 * Gateway Service
 *
 * Central service for managing sessions, channels, and message routing
 */

import { MemoryStoreImpl } from "@dyna/memory-core";
import { eventBus } from "@dyna/event-bus";
import type { ChannelEnvelope, TradeMode } from "@dyna/contracts";
import { SessionManager } from "./sessions";
import { ChannelManager } from "./channels";

export interface GatewayConfig {
  sessionTimeout: number;
  channelTimeout: number;
  maxChannels: number;
  maxMembers: number;
  allowedChannelTypes: string[];
}

export interface GatewayMetrics {
  activeSessions: number;
  activeChannels: number;
  messagesPerSecond: number;
  errorsPerSecond: number;
  memoryUsage: number;
}

export interface UserSession {
  userId: string;
  sessionId: string;
  channels: string[];
  lastActivity: Date;
}

export class GatewayService {
  private sessionManager: SessionManager;
  private channelManager: ChannelManager;
  private config: GatewayConfig;
  private metrics: GatewayMetrics;
  private messageQueue: Array<{
    envelope: ChannelEnvelope;
    timestamp: number;
    retries: number;
  }> = [];
  private isRunning = false;
  private cleanupSessionInterval: ReturnType<typeof setInterval> | null = null;
  private messageQueueInterval: ReturnType<typeof setInterval> | null = null;
  private metricsInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    memory: MemoryStoreImpl,
    config: Partial<GatewayConfig> = {}
  ) {
    this.config = {
      sessionTimeout: 30 * 60 * 1000, // 30 minutes
      channelTimeout: 24 * 60 * 60 * 1000, // 24 hours
      maxChannels: 1000,
      maxMembers: 10000,
      allowedChannelTypes: ["text", "voice", "trading", "control", "alert"],
      ...config,
    };

    this.sessionManager = new SessionManager(memory);
    this.channelManager = new ChannelManager(memory, this.sessionManager);
    this.metrics = {
      activeSessions: 0,
      activeChannels: 0,
      messagesPerSecond: 0,
      errorsPerSecond: 0,
      memoryUsage: 0,
    };

    this.setupEventHandlers();
  }

  /**
   * Start the gateway service
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;

    // Create default channels
    const adminSession = await this.sessionManager.createSession("system", "system", {
      permissions: ["*"],
      riskLevel: "low",
    });

    await this.channelManager.createDefaultChannels(adminSession);

    // Start periodic cleanup
    this.startPeriodicCleanup();

    await eventBus.emit("gateway_started", { config: this.config });
  }

  /**
   * Stop the gateway service
   */
  async stop(): Promise<void> {
    this.isRunning = false;

    // Clear periodic cleanup intervals
    if (this.cleanupSessionInterval) { clearInterval(this.cleanupSessionInterval); this.cleanupSessionInterval = null; }
    if (this.messageQueueInterval) { clearInterval(this.messageQueueInterval); this.messageQueueInterval = null; }
    if (this.metricsInterval) { clearInterval(this.metricsInterval); this.metricsInterval = null; }

    // Clear message queue
    this.messageQueue = [];

    await eventBus.emit("gateway_stopped" as never);
  }

  /**
   * Create and connect a new session
   */
  async createSession(
    userId: string,
    accountId: string,
    metadata: {
      userAgent?: string;
      ipAddress?: string;
      deviceType?: "desktop" | "mobile" | "api";
      location?: string;
      permissions?: string[];
      riskLevel?: "low" | "medium" | "high";
    } = {}
  ): Promise<string> {
    const sessionId = await this.sessionManager.createSession(
      userId,
      accountId,
      metadata
    );

    await this.sessionManager.connectSession(sessionId, {
      userAgent: metadata.userAgent,
      ipAddress: metadata.ipAddress,
    });

    this.updateMetrics();

    return sessionId;
  }

  /**
   * Process an incoming message
   */
  async processMessage(envelope: ChannelEnvelope): Promise<void> {
    if (!this.isRunning) {
      throw new Error("Gateway is not running");
    }

    // Validate envelope
    this.validateEnvelope(envelope);

    // Check session exists and is active
    const session = this.sessionManager.getSession(envelope.sessionId);
    if (!session || !session.state.connected) {
      throw new Error("Invalid or inactive session");
    }

    // Check channel exists
    const channel = this.channelManager.getChannel(envelope.channel);
    if (!channel) {
      throw new Error("Channel not found");
    }

    // Check permissions
    if (!this.channelManager.canAccessSession(session, envelope.channel)) {
      throw new Error("Access denied to channel");
    }

    // Add to message queue
    this.messageQueue.push({
      envelope,
      timestamp: Date.now(),
      retries: 0,
    });

    this.updateMetrics();
  }

  /**
   * Send a message to a specific session
   */
  async sendToSession(
    targetSessionId: string,
    envelope: ChannelEnvelope,
    fromSessionId?: string
  ): Promise<void> {
    const session = this.sessionManager.getSession(targetSessionId);
    if (!session || !session.state.connected) {
      throw new Error("Target session is not active");
    }

    // Update envelope to include sender info
    const enrichedEnvelope: ChannelEnvelope = {
      ...envelope,
      senderId: fromSessionId ?? "system",
      trusted: true,
    };

    await this.sessionManager.processMessage(targetSessionId, enrichedEnvelope);
    this.updateMetrics();
  }

  /**
   * Broadcast message to channel
   */
  async broadcastToChannel(
    channelId: string,
    envelope: ChannelEnvelope,
    fromSessionId?: string
  ): Promise<void> {
    await this.channelManager.sendToChannel(channelId, envelope, fromSessionId);
    this.updateMetrics();
  }

  /**
   * Join a channel
   */
  async joinChannel(sessionId: string, channelId: string, permissions?: string[]): Promise<void> {
    await this.channelManager.joinChannel(sessionId, channelId, permissions);
    this.updateMetrics();
  }

  /**
   * Leave a channel
   */
  async leaveChannel(sessionId: string, channelId: string): Promise<void> {
    await this.channelManager.leaveChannel(sessionId, channelId);
    this.updateMetrics();
  }

  /**
   * Get user's channels
   */
  async getUserChannels(userId: string): Promise<Array<{ session: string; channel: any }>> {
    const sessions = this.sessionManager.getSessionsByUser(userId);
    const channels: Array<{ session: string; channel: any }> = [];

    for (const session of sessions) {
      const userChannels = this.channelManager.getUserChannels(session.id);
      channels.push(
        ...userChannels.map(channel => ({
          session: session.id,
          channel,
        }))
      );
    }

    return channels;
  }

  /**
   * Get active sessions count
   */
  getActiveSessionsCount(): number {
    return this.sessionManager.getActiveSessions().length;
  }

  /**
   * Get active channels count
   */
  getActiveChannelsCount(): number {
    return this.channelManager.getAllChannels().length;
  }

  /**
   * Get gateway metrics
   */
  getMetrics(): GatewayMetrics {
    return { ...this.metrics };
  }

  /**
   * Block a session
   */
  async blockSession(sessionId: string, reason: string): Promise<void> {
    await this.sessionManager.blockSession(sessionId, reason);

    // Disconnect from all channels
    const session = this.sessionManager.getSession(sessionId);
    if (session) {
      const channels = this.channelManager.getUserChannels(sessionId);
      for (const channel of channels) {
        await this.channelManager.leaveChannel(sessionId, channel.id);
      }
    }

    this.updateMetrics();
  }

  /**
   * Validate envelope format
   */
  private validateEnvelope(envelope: ChannelEnvelope): void {
    if (!envelope.channel) {
      throw new Error("Missing channel");
    }
    if (!envelope.senderId) {
      throw new Error("Missing senderId");
    }
    if (!envelope.sessionId) {
      throw new Error("Missing sessionId");
    }
    if (typeof envelope.text !== "string" && !envelope.attachments) {
      throw new Error("Missing text or attachments");
    }
  }

  /**
   * Start periodic cleanup
   */
  private startPeriodicCleanup(): void {
    if (!this.isRunning) return;

    // Clean up expired sessions
    this.cleanupSessionInterval = setInterval(async () => {
      const expired = await this.sessionManager.cleanupExpiredSessions();
      if (expired.length > 0) {
        console.log(`Cleaned up ${expired.length} expired sessions`);
      }
      this.updateMetrics();
    }, 5 * 60 * 1000); // Every 5 minutes

    // Process message queue
    this.messageQueueInterval = setInterval(() => {
      this.processMessageQueue();
    }, 1000); // Every second

    // Update metrics
    this.metricsInterval = setInterval(() => {
      this.updateMetrics();
    }, 30 * 1000); // Every 30 seconds
  }

  /**
   * Process message queue
   */
  private processMessageQueue(): void {
    const now = Date.now();
    const processed: number[] = [];

    for (let i = 0; i < this.messageQueue.length; i++) {
      const item = this.messageQueue[i]!;
      if (!item) continue;

      // Check timeout (10 seconds)
      if (now - item.timestamp > 10000) {
        processed.push(i);
        continue;
      }

      // Process message
      try {
        this.channelManager.processMessage(item.envelope.sessionId, item.envelope);
        processed.push(i);
      } catch (error) {
        console.error(`Error processing message:`, error);
        item.retries++;

        // Max 3 retries
        if (item.retries >= 3) {
          console.error(`Message failed after 3 retries:`, item.envelope);
          processed.push(i);
        }
      }
    }

    // Remove processed messages (in reverse order to maintain indices)
    for (let i = processed.length - 1; i >= 0; i--) {
      this.messageQueue.splice(processed[i]!, 1);
    }
  }

  /**
   * Update metrics
   */
  private updateMetrics(): void {
    this.metrics.activeSessions = this.getActiveSessionsCount();
    this.metrics.activeChannels = this.getActiveChannelsCount();
    this.metrics.messagesPerSecond = this.calculateMessagesPerSecond();
    this.metrics.errorsPerSecond = this.calculateErrorsPerSecond();

    // Calculate memory usage
    const memoryUsage = process.memoryUsage ? process.memoryUsage().heapUsed : 0;
    this.metrics.memoryUsage = memoryUsage;
  }

  /**
   * Calculate messages per second
   */
  private calculateMessagesPerSecond(): number {
    // Simplified calculation - in reality would track message timestamps
    return this.messageQueue.length;
  }

  /**
   * Calculate errors per second
   */
  private calculateErrorsPerSecond(): number {
    // Simplified - would track error timestamps
    return 0;
  }

  /**
   * Setup event handlers
   */
  private setupEventHandlers(): void {
    // Handle session events
    eventBus.on("session_created", (data) => {
      this.updateMetrics();
    });

    eventBus.on("session_disconnected", (data) => {
      this.updateMetrics();
    });

    eventBus.on("session_blocked", (data) => {
      this.updateMetrics();
    });

    // Handle channel events
    eventBus.on("channel_created", (data) => {
      this.updateMetrics();
    });

    eventBus.on("channel_joined", (data) => {
      this.updateMetrics();
    });

    eventBus.on("channel_left", (data) => {
      this.updateMetrics();
    });
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string) {
    return this.sessionManager.getSession(sessionId);
  }

  /**
   * Get channel by ID
   */
  getChannel(channelId: string) {
    return this.channelManager.getChannel(channelId);
  }

  /**
   * Get all sessions
   */
  getAllSessions() {
    return this.sessionManager.getAllSessions();
  }

  /**
   * Get all channels
   */
  getAllChannels() {
    return this.channelManager.getAllChannels();
  }

  /**
   * Get message queue size
   */
  getMessageQueueSize(): number {
    return this.messageQueue.length;
  }
}
