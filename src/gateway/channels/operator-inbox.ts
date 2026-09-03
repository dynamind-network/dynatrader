/**
 * Operator Inbox
 *
 * Dedicated operator interface for managing alerts, approvals, and communications
 */

import { MemoryStoreImpl } from "@dyna/memory-core";
import { eventBus } from "@dyna/event-bus";
import type { ChannelEnvelope, TradeMode } from "@dyna/contracts";

export interface InboxMessage {
  id: string;
  type: "alert" | "approval" | "notification" | "emergency" | "system";
  priority: "low" | "medium" | "high" | "critical";
  title: string;
  content: string;
  sender: string;
  timestamp: Date;
  expiresAt?: Date;
  metadata?: Record<string, unknown>;
  read: boolean;
  actioned: boolean;
  actions?: InboxAction[];
}

export interface InboxAction {
  id: string;
  type: "approve" | "reject" | "review" | "investigate" | "acknowledge";
  label: string;
  description?: string;
  requiresConfirmation?: boolean;
}

export interface InboxFilter {
  type?: InboxMessage["type"][];
  priority?: InboxMessage["priority"][];
  read?: boolean;
  actioned?: boolean;
  sender?: string;
  dateRange?: { start: Date; end: Date };
}

export interface NotificationSettings {
  enableEmail: boolean;
  enablePush: boolean;
  enableInApp: boolean;
  alertTypes: string[];
  quietHours: { start: string; end: string };
  frequency: "immediate" | "daily" | "weekly";
}

export class OperatorInbox {
  private memory: MemoryStoreImpl;
  private messages: Map<string, InboxMessage> = new Map();
  private subscriptions: Map<string, NotificationSettings> = new Map();
  private notificationQueue: Array<{
    message: InboxMessage;
    timestamp: number;
    retries: number;
  }> = [];

  constructor(memory: MemoryStoreImpl) {
    this.memory = memory;
    this.loadMessages();
    this.loadSubscriptions();
  }

  /**
   * Create an inbox message
   */
  async createMessage(
    type: InboxMessage["type"],
    priority: InboxMessage["priority"],
    title: string,
    content: string,
    sender: string,
    recipient: string,
    metadata?: Record<string, unknown>,
    actions?: InboxAction[]
  ): Promise<string> {
    const id = `inbox-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const timestamp = new Date();

    const message: InboxMessage = {
      id,
      type,
      priority,
      title,
      content,
      sender,
      timestamp,
      metadata,
      read: false,
      actioned: false,
      actions,
    };

    // Set expiration for high priority messages
    if (priority === "critical") {
      message.expiresAt = new Date(timestamp.getTime() + 60 * 60 * 1000); // 1 hour
    } else if (priority === "high") {
      message.expiresAt = new Date(timestamp.getTime() + 24 * 60 * 60 * 1000); // 24 hours
    }

    this.messages.set(id, message);

    // Store in memory
    await this.memory.put({
      scope: "operator_inbox",
      kind: "inbox_message_created",
      payload: { message, recipient },
      ts: timestamp,
    });

    // Send notifications
    await this.sendNotifications(message, recipient);

    await eventBus.emit("inbox_message_created", { message, recipient });

    return id;
  }

  /**
   * Get message by ID
   */
  getMessage(id: string): InboxMessage | undefined {
    return this.messages.get(id);
  }

  /**
   * Get all messages
   */
  getAllMessages(): InboxMessage[] {
    return Array.from(this.messages.values());
  }

  /**
   * Get messages with filters
   */
  getMessages(filters: InboxFilter = {}): InboxMessage[] {
    return this.getAllMessages().filter(message => {
      // Filter by type
      if (filters.type && !filters.type.includes(message.type)) {
        return false;
      }

      // Filter by priority
      if (filters.priority && !filters.priority.includes(message.priority)) {
        return false;
      }

      // Filter by read status
      if (filters.read !== undefined && message.read !== filters.read) {
        return false;
      }

      // Filter by actioned status
      if (filters.actioned !== undefined && message.actioned !== filters.actioned) {
        return false;
      }

      // Filter by sender
      if (filters.sender && message.sender !== filters.sender) {
        return false;
      }

      // Filter by date range
      if (filters.dateRange) {
        if (message.timestamp < filters.dateRange.start || message.timestamp > filters.dateRange.end) {
          return false;
        }
      }

      // Check expiration
      if (message.expiresAt && message.expiresAt < new Date()) {
        return false;
      }

      return true;
    });
  }

  /**
   * Mark message as read
   */
  async markAsRead(messageId: string, operatorId: string): Promise<void> {
    const message = this.messages.get(messageId);
    if (!message) {
      throw new Error(`Message not found: ${messageId}`);
    }

    message.read = true;
    this.messages.set(messageId, message);

    await eventBus.emit("inbox_message_read", { message, operatorId });

    // Store update
    await this.memory.put({
      scope: "operator_inbox",
      kind: "inbox_message_read",
      payload: { messageId, operatorId, timestamp: new Date() },
      ts: new Date(),
    });
  }

  /**
   * Mark message as actioned
   */
  async markAsActioned(messageId: string, operatorId: string, actionId: string, result: string): Promise<void> {
    const message = this.messages.get(messageId);
    if (!message) {
      throw new Error(`Message not found: ${messageId}`);
    }

    message.actioned = true;
    this.messages.set(messageId, message);

    await eventBus.emit("inbox_message_actioned", { message, operatorId, actionId, result });

    // Store update
    await this.memory.put({
      scope: "operator_inbox",
      kind: "inbox_message_actioned",
      payload: { messageId, operatorId, actionId, result, timestamp: new Date() },
      ts: new Date(),
    });
  }

  /**
   * Execute message action
   */
  async executeAction(messageId: string, operatorId: string, actionId: string, parameters?: Record<string, unknown>): Promise<void> {
    const message = this.messages.get(messageId);
    if (!message) {
      throw new Error(`Message not found: ${messageId}`);
    }

    const action = message.actions?.find(a => a.id === actionId);
    if (!action) {
      throw new Error(`Action not found: ${actionId}`);
    }

    // Execute action based on type
    switch (action.type) {
      case "approve":
        await this.handleApprove(message, operatorId, parameters);
        break;
      case "reject":
        await this.handleReject(message, operatorId, parameters);
        break;
      case "review":
        await this.handleReview(message, operatorId, parameters);
        break;
      case "investigate":
        await this.handleInvestigate(message, operatorId, parameters);
        break;
      case "acknowledge":
        await this.handleAcknowledge(message, operatorId, parameters);
        break;
      default:
        throw new Error(`Unknown action type: ${action.type}`);
    }

    await this.markAsActioned(messageId, operatorId, actionId, "executed");
  }

  /**
   * Create alert message
   */
  async createAlert(
    priority: InboxMessage["priority"],
    title: string,
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<string> {
    return this.createMessage(
      "alert",
      priority,
      title,
      content,
      "system",
      "operators",
      metadata
    );
  }

  /**
   * Create approval request
   */
  async createApproval(
    title: string,
    content: string,
    sender: string,
    actions: InboxAction[],
    metadata?: Record<string, unknown>
  ): Promise<string> {
    return this.createMessage(
      "approval",
      "high",
      title,
      content,
      sender,
      "operators",
      metadata,
      actions
    );
  }

  /**
   * Create emergency notification
   */
  async createEmergency(
    title: string,
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<string> {
    const messageId = await this.createMessage(
      "emergency",
      "critical",
      title,
      content,
      "system",
      "operators",
      metadata,
      [
        {
          id: "acknowledge",
          type: "acknowledge",
          label: "Acknowledge",
        },
        {
          id: "investigate",
          type: "investigate",
          label: "Investigate",
          requiresConfirmation: true,
        },
      ]
    );

    // Critical messages get immediate notifications
    const message = this.messages.get(messageId);
    if (message) {
      await this.sendImmediateNotifications(message);
    }

    return messageId;
  }

  /**
   * Set notification preferences for operator
   */
  async setNotificationSettings(operatorId: string, settings: NotificationSettings): Promise<void> {
    this.subscriptions.set(operatorId, settings);

    await eventBus.emit("notification_settings_updated", { operatorId, settings });

    // Store update
    await this.memory.put({
      scope: "operator_inbox",
      kind: "notification_settings_updated",
      payload: { operatorId, settings },
      ts: new Date(),
    });
  }

  /**
   * Get notification settings for operator
   */
  getNotificationSettings(operatorId: string): NotificationSettings | undefined {
    return this.subscriptions.get(operatorId);
  }

  /**
   * Get unread count for operator
   */
  getUnreadCount(): number {
    return this.getAllMessages().filter(message => !message.read).length;
  }

  /**
   * Get critical messages count
   */
  getCriticalCount(): number {
    return this.getAllMessages().filter(
      message => message.priority === "critical" && !message.actioned
    ).length;
  }

  /**
   * Cleanup expired messages
   */
  async cleanupExpiredMessages(): Promise<string[]> {
    const now = new Date();
    const expired: string[] = [];

    for (const [id, message] of this.messages) {
      if (message.expiresAt && message.expiresAt < now && !message.actioned) {
        expired.push(id);
        this.messages.delete(id);
      }
    }

    return expired;
  }

  /**
   * Handle approve action
   */
  private async handleApprove(message: InboxMessage, operatorId: string, parameters?: Record<string, unknown>): Promise<void> {
    // This would integrate with the approval system
    console.log(`Approval handled by ${operatorId}:`, message.title, parameters);

    await eventBus.emit("approval_approved", { message, operatorId, parameters });
  }

  /**
   * Handle reject action
   */
  private async handleReject(message: InboxMessage, operatorId: string, parameters?: Record<string, unknown>): Promise<void> {
    console.log(`Rejection handled by ${operatorId}:`, message.title, parameters);

    await eventBus.emit("approval_rejected", { message, operatorId, parameters });
  }

  /**
   * Handle review action
   */
  private async handleReview(message: InboxMessage, operatorId: string, parameters?: Record<string, unknown>): Promise<void> {
    console.log(`Review handled by ${operatorId}:`, message.title, parameters);

    await eventBus.emit("approval_reviewed", { message, operatorId, parameters });
  }

  /**
   * Handle investigate action
   */
  private async handleInvestigate(message: InboxMessage, operatorId: string, parameters?: Record<string, unknown>): Promise<void> {
    console.log(`Investigation started by ${operatorId}:`, message.title, parameters);

    await eventBus.emit("investigation_started", { message, operatorId, parameters });
  }

  /**
   * Handle acknowledge action
   */
  private async handleAcknowledge(message: InboxMessage, operatorId: string, parameters?: Record<string, unknown>): Promise<void> {
    console.log(`Acknowledgment by ${operatorId}:`, message.title, parameters);

    await eventBus.emit("emergency_acknowledged", { message, operatorId, parameters });
  }

  /**
   * Send notifications for message
   */
  private async sendNotifications(message: InboxMessage, recipient: string): Promise<void> {
    const settings = this.subscriptions.get(recipient);
    if (!settings) return;

    // Check quiet hours
    if (this.isInQuietHours(settings)) {
      return;
    }

    const notifications = [];

    if (settings.enableInApp) {
      notifications.push("in-app");
    }

    if (settings.enablePush) {
      notifications.push("push");
    }

    if (settings.enableEmail && ["critical", "high"].includes(message.priority)) {
      notifications.push("email");
    }

    // Send notifications
    for (const type of notifications) {
      this.notificationQueue.push({
        message,
        timestamp: Date.now(),
        retries: 0,
      });
    }
  }

  /**
   * Send immediate notifications for emergency messages
   */
  private async sendImmediateNotifications(message: InboxMessage): Promise<void> {
    this.notificationQueue.push({
      message,
      timestamp: Date.now(),
      retries: 0,
    });
  }

  /**
   * Check if currently in quiet hours
   */
  private isInQuietHours(settings: NotificationSettings): boolean {
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinutes = now.getMinutes();
    const currentTime = currentHour * 60 + currentMinutes;

    const [startHour, startMinute] = settings.quietHours.start.split(":").map(Number);
    const [endHour, endMinute] = settings.quietHours.end.split(":").map(Number);

    const startTime = startHour! * 60 + startMinute!;
    const endTime = endHour! * 60 + endMinute!;

    // Handle overnight quiet hours
    if (startTime > endTime) {
      return currentTime >= startTime || currentTime <= endTime;
    }

    return currentTime >= startTime && currentTime <= endTime;
  }

  /**
   * Load messages from memory
   */
  private async loadMessages(): Promise<void> {
    try {
      const results = await this.memory.search({
        scope: "operator_inbox",
        text: "inbox_message",
        topK: 1000,
      });

      for (const result of results) {
        if (result.payload && typeof result.payload === "object") {
          const message = result.payload as InboxMessage;
          this.messages.set(message.id, message);
        }
      }
    } catch (error) {
      console.error("Failed to load inbox messages:", error);
    }
  }

  /**
   * Load subscriptions from memory
   */
  private async loadSubscriptions(): Promise<void> {
    try {
      const results = await this.memory.search({
        scope: "operator_inbox",
        text: "notification_settings",
        topK: 100,
      });

      for (const result of results) {
        if (result.payload && typeof result.payload === "object") {
          const { operatorId, settings } = result.payload as { operatorId: string; settings: NotificationSettings };
          this.subscriptions.set(operatorId, settings);
        }
      }
    } catch (error) {
      console.error("Failed to load notification settings:", error);
    }
  }
}
