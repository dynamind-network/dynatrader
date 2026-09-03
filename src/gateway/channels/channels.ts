/**
 * Channel Management
 *
 * Handles multi-channel communication and message routing
 */

import { MemoryStoreImpl } from "@dyna/memory-core";
import { eventBus } from "@dyna/event-bus";
import type { ChannelEnvelope } from "@dyna/contracts";
import { SessionManager } from "./sessions";

export interface Channel {
  id: string;
  name: string;
  type: "text" | "voice" | "trading" | "control" | "alert";
  description: string;
  permissions: string[];
  pairingMode: "open" | "restricted" | "invite-only";
  metadata?: Record<string, unknown>;
  created: Date;
}

export interface ChannelMembership {
  sessionId: string;
  channelId: string;
  joinedAt: Date;
  permissions: string[];
  role: "member" | "moderator" | "admin" | "bot";
  muted?: boolean;
  notification?: "all" | "mentions" | "none";
}

export interface ChannelEvent {
  type: "message" | "join" | "leave" | "mute" | "admin" | "delete";
  channelId: string;
  sessionId?: string;
  timestamp: Date;
  data?: unknown;
}

export interface ChannelFilter {
  type?: Channel["type"];
  permissions?: string[];
  pairingMode?: Channel["pairingMode"];
  memberCount?: { min?: number; max?: number };
}

export class ChannelManager {
  private memory: MemoryStoreImpl;
  private sessionManager: SessionManager;
  private channels: Map<string, Channel> = new Map();
  private memberships: Map<string, ChannelMembership[]> = new Map();
  private messageHandlers: Map<string, Array<(envelope: ChannelEnvelope) => void>> = new Map();

  constructor(memory: MemoryStoreImpl, sessionManager: SessionManager) {
    this.memory = memory;
    this.sessionManager = sessionManager;
    this.loadChannels();
  }

  /**
   * Create a new channel
   */
  async createChannel(
    name: string,
    type: Channel["type"],
    permissions: string[],
    pairingMode: Channel["pairingMode"] = "open",
    creatorId: string,
    metadata?: Record<string, unknown>
  ): Promise<string> {
    const id = `channel-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const channel: Channel = {
      id,
      name,
      type,
      description: name,
      permissions,
      pairingMode,
      metadata,
      created: new Date(),
    };

    this.channels.set(id, channel);

    // Add creator as admin
    const membership: ChannelMembership = {
      sessionId: creatorId,
      channelId: id,
      joinedAt: new Date(),
      permissions: ["*"],
      role: "admin",
    };

    if (!this.memberships.has(id)) {
      this.memberships.set(id, []);
    }
    this.memberships.get(id)!.push(membership);

    // Store in memory
    await this.memory.put({
      scope: "channels",
      kind: "channel_created",
      payload: { channel, creatorId },
      ts: new Date(),
    });

    await eventBus.emit("channel_created", { channel });

    return id;
  }

  /**
   * Get channel by ID
   */
  getChannel(id: string): Channel | undefined {
    return this.channels.get(id);
  }

  /**
   * Get all channels
   */
  getAllChannels(): Channel[] {
    return Array.from(this.channels.values());
  }

  /**
   * Get channels with filters
   */
  getChannels(filters: ChannelFilter = {}): Channel[] {
    return this.getAllChannels().filter(channel => {
      // Filter by type
      if (filters.type && channel.type !== filters.type) {
        return false;
      }

      // Filter by permissions
      if (filters.permissions && !filters.permissions.every(perm => channel.permissions.includes(perm))) {
        return false;
      }

      // Filter by pairing mode
      if (filters.pairingMode && channel.pairingMode !== filters.pairingMode) {
        return false;
      }

      // Filter by member count
      if (filters.memberCount) {
        const memberCount = this.getMembers(channel.id).length;
        if (filters.memberCount.min && memberCount < filters.memberCount.min) {
          return false;
        }
        if (filters.memberCount.max && memberCount > filters.memberCount.max) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Check if session can access channel
   */
  canAccessChannel(sessionId: string, channelId: string): boolean {
    const channel = this.getChannel(channelId);
    if (!channel) return false;

    const session = this.sessionManager.getSession(sessionId);
    if (!session) return false;

    // Check channel permissions
    if (channel.pairingMode === "open") {
      return true;
    }

    // Check session permissions
    return this.sessionManager.hasPermission(session, channelId);
  }

  /**
   * Join a channel
   */
  async joinChannel(sessionId: string, channelId: string, permissions: string[] = []): Promise<void> {
    // Check if session can access channel
    if (!this.canAccessChannel(sessionId, channelId)) {
      throw new Error("Access denied to channel");
    }

    const channel = this.getChannel(channelId);
    if (!channel) {
      throw new Error("Channel not found");
    }

    // Check if already member
    const membership = this.getMembership(sessionId, channelId);
    if (membership) {
      throw new Error("Already a member of this channel");
    }

    // Create membership
    const newMembership: ChannelMembership = {
      sessionId,
      channelId,
      joinedAt: new Date(),
      permissions: permissions.length > 0 ? permissions : ["read"],
      role: "member",
    };

    if (!this.memberships.has(channelId)) {
      this.memberships.set(channelId, []);
    }
    this.memberships.get(channelId)!.push(newMembership);

    // Store in memory
    await this.memory.put({
      scope: "channels",
      kind: "channel_join",
      payload: { sessionId, channelId, membership: newMembership },
      ts: new Date(),
    });

    await eventBus.emit("channel_joined", { sessionId, channelId, membership: newMembership });
  }

  /**
   * Leave a channel
   */
  async leaveChannel(sessionId: string, channelId: string): Promise<void> {
    const membership = this.getMembership(sessionId, channelId);
    if (!membership) {
      throw new Error("Not a member of this channel");
    }

    // Remove membership
    const memberships = this.memberships.get(channelId);
    if (memberships) {
      const index = memberships.findIndex(m => m.sessionId === sessionId);
      if (index > -1) {
        memberships.splice(index, 1);
      }
    }

    // Store in memory
    await this.memory.put({
      scope: "channels",
      kind: "channel_leave",
      payload: { sessionId, channelId },
      ts: new Date(),
    });

    await eventBus.emit("channel_left", { sessionId, channelId });
  }

  /**
   * Send message to channel
   */
  async sendToChannel(channelId: string, envelope: ChannelEnvelope, fromSessionId?: string): Promise<void> {
    const channel = this.getChannel(channelId);
    if (!channel) {
      throw new Error("Channel not found");
    }

    // Validate envelope
    if (!envelope.channel || envelope.channel !== channelId) {
      throw new Error("Invalid channel in envelope");
    }

    // Get channel members
    const members = this.getMembers(channelId);
    const targetSessionIds = members.map(m => m.sessionId);

    // Store message
    await this.memory.put({
      scope: "channels",
      kind: "channel_message",
      payload: { channelId, envelope, fromSessionId, timestamp: new Date() },
      ts: new Date(),
    });

    // Emit to all message handlers
    const handlers = this.messageHandlers.get(channelId) || [];
    for (const handler of handlers) {
      try {
        handler(envelope);
      } catch (error) {
        console.error(`Error in channel message handler:`, error);
      }
    }

    await eventBus.emit("channel_message_sent", {
      channelId,
      envelope,
      fromSessionId,
      targetSessionIds,
    });
  }

  /**
   * Process incoming message
   */
  async processMessage(sessionId: string, envelope: ChannelEnvelope): Promise<void> {
    // Check if session can send to channel
    if (!this.canAccessChannel(sessionId, envelope.channel)) {
      throw new Error("Access denied to channel");
    }

    // Validate envelope
    this.validateEnvelope(envelope);

    // Update session
    await this.sessionManager.processMessage(sessionId, envelope);

    // Send to channel
    await this.sendToChannel(envelope.channel, envelope, sessionId);
  }

  /**
   * Set channel permissions
   */
  async setChannelPermissions(channelId: string, adminSessionId: string, permissions: string[]): Promise<void> {
    const channel = this.getChannel(channelId);
    if (!channel) {
      throw new Error("Channel not found");
    }

    const adminMembership = this.getMembership(adminSessionId, channelId);
    if (!adminMembership || (adminMembership.role !== "admin" && adminMembership.role !== "moderator")) {
      throw new Error("Permission denied");
    }

    channel.permissions = permissions;
    this.channels.set(channelId, channel);

    await eventBus.emit("channel_permissions_updated", { channelId, adminSessionId, permissions });
  }

  /**
   * Set member role
   */
  async setMemberRole(channelId: string, adminSessionId: string, targetSessionId: string, role: ChannelMembership["role"]): Promise<void> {
    const adminMembership = this.getMembership(adminSessionId, channelId);
    if (!adminMembership || adminMembership.role !== "admin") {
      throw new Error("Only admins can set member roles");
    }

    const targetMembership = this.getMembership(targetSessionId, channelId);
    if (!targetMembership) {
      throw new Error("Target user not in channel");
    }

    targetMembership.role = role;
    this.memberships.set(channelId, this.getMembers(channelId));

    await eventBus.emit("channel_member_role_updated", { channelId, adminSessionId, targetSessionId, role });
  }

  /**
   * Mute a member
   */
  async muteMember(channelId: string, adminSessionId: string, targetSessionId: string): Promise<void> {
    const adminMembership = this.getMembership(adminSessionId, channelId);
    if (!adminMembership || (adminMembership.role !== "admin" && adminMembership.role !== "moderator")) {
      throw new Error("Permission denied");
    }

    const targetMembership = this.getMembership(targetSessionId, channelId);
    if (!targetMembership) {
      throw new Error("Target user not in channel");
    }

    targetMembership.muted = true;
    this.memberships.set(channelId, this.getMembers(channelId));

    await eventBus.emit("channel_member_muted", { channelId, adminSessionId, targetSessionId });
  }

  /**
   * Unmute a member
   */
  async unmuteMember(channelId: string, adminSessionId: string, targetSessionId: string): Promise<void> {
    const adminMembership = this.getMembership(adminSessionId, channelId);
    if (!adminMembership || (adminMembership.role !== "admin" && adminMembership.role !== "moderator")) {
      throw new Error("Permission denied");
    }

    const targetMembership = this.getMembership(targetSessionId, channelId);
    if (!targetMembership) {
      throw new Error("Target user not in channel");
    }

    targetMembership.muted = false;
    this.memberships.set(channelId, this.getMembers(channelId));

    await eventBus.emit("channel_member_unmuted", { channelId, adminSessionId, targetSessionId });
  }

  /**
   * Get channel members
   */
  getMembers(channelId: string): ChannelMembership[] {
    return this.memberships.get(channelId) || [];
  }

  /**
   * Get user's channels
   */
  getUserChannels(sessionId: string): Channel[] {
    const memberships = this.memberships.get(sessionId);
    if (!memberships) return [];

    return memberships.map(m => this.getChannel(m.channelId)).filter(Boolean) as Channel[];
  }

  /**
   * Get channel membership
   */
  getMembership(sessionId: string, channelId: string): ChannelMembership | undefined {
    const memberships = this.memberships.get(channelId);
    if (!memberships) return undefined;

    return memberships.find(m => m.sessionId === sessionId);
  }

  /**
   * Check if a session can access a channel
   */
  canAccessSession(session: { id: string; metadata?: { permissions?: string[] } }, channelId: string): boolean {
    const channel = this.getChannel(channelId);
    if (!channel) return false;

    // If channel is open, everyone has access
    if (channel.pairingMode === 'open') return true;

    // Check membership
    const membership = this.getMembership(session.id, channelId);
    if (!membership) return false;

    // Check if membership has required permissions
    return channel.permissions.every(p => membership.permissions.includes(p));
  }

  /**
   * Add message handler
   */
  onMessage(channelId: string, handler: (envelope: ChannelEnvelope) => void): () => void {
    if (!this.messageHandlers.has(channelId)) {
      this.messageHandlers.set(channelId, []);
    }
    this.messageHandlers.get(channelId)!.push(handler);

    return () => {
      const handlers = this.messageHandlers.get(channelId);
      if (handlers) {
        const index = handlers.indexOf(handler);
        if (index > -1) {
          handlers.splice(index, 1);
        }
      }
    };
  }

  /**
   * Validate envelope
   */
  private validateEnvelope(envelope: ChannelEnvelope): void {
    if (!envelope.channel || typeof envelope.channel !== "string") {
      throw new Error("Invalid channel in envelope");
    }

    if (!envelope.senderId || typeof envelope.senderId !== "string") {
      throw new Error("Invalid sender ID in envelope");
    }

    if (!envelope.sessionId || typeof envelope.sessionId !== "string") {
      throw new Error("Invalid session ID in envelope");
    }

    if (envelope.text && typeof envelope.text !== "string") {
      throw new Error("Invalid text in envelope");
    }
  }

  /**
   * Load channels from memory
   */
  private async loadChannels(): Promise<void> {
    try {
      const results = await this.memory.search({
        scope: "channels",
        text: "channel",
        topK: 100,
      });

      for (const result of results) {
        if (result.payload && typeof result.payload === "object") {
          const channel = result.payload as Channel;
          this.channels.set(channel.id, channel);
        }
      }
    } catch (error) {
      console.error("Failed to load channels:", error);
    }
  }

  /**
   * Create default channels
   */
  async createDefaultChannels(adminSessionId: string): Promise<void> {
    // General trading channel
    await this.createChannel(
      "general-trading",
      "text",
      ["*"],
      "open",
      adminSessionId,
      { description: "General trading discussions" }
    );

    // Risk alerts channel
    await this.createChannel(
      "risk-alerts",
      "alert",
      ["read", "admin"],
      "restricted",
      adminSessionId,
      { description: "Risk and compliance alerts" }
    );

    // Strategy development channel
    await this.createChannel(
      "strategy-dev",
      "trading",
      ["read", "write"],
      "invite-only",
      adminSessionId,
      { description: "Strategy development and testing" }
    );

    // Operator control channel
    await this.createChannel(
      "operator-control",
      "control",
      ["read", "write", "admin"],
      "restricted",
      adminSessionId,
      { description: "Operator control center" }
    );

    // Emergency channel
    await this.createChannel(
      "emergency",
      "alert",
      ["read", "admin"],
      "restricted",
      adminSessionId,
      { description: "Emergency communications" }
    );
  }
}
