/**
 * Mid-Turn Steering — SteeringInbox
 *
 * Accepts user messages while the agent is mid-turn.
 * Messages are drained at step boundaries and folded into the
 * next prompt as a `### notice` section.
 *
 * Events from any source (user, parent, supervisor)
 * arrive through the same channel. The agent must acknowledge them
 * before the next LLM call.
 */

export interface SteeringMessage {
  id: string;
  content: string;
  source: "user" | "parent" | "supervisor" | "system";
  timestamp: number;
  priority: "low" | "normal" | "high";
}

export interface SteeringInboxConfig {
  /** Max messages to keep before dropping oldest. Default: 20 */
  maxCapacity?: number;
  /** Whether to keep high-priority messages even when full. Default: true */
  preserveHighPriority?: boolean;
}

/**
 * Thread-safe steering inbox for mid-turn message delivery.
 */
export class SteeringInbox {
  private readonly maxCapacity: number;
  private readonly preserveHighPriority: boolean;
  private messages: SteeringMessage[] = [];
  private drained = false;

  constructor(config?: SteeringInboxConfig) {
    this.maxCapacity = config?.maxCapacity ?? 20;
    this.preserveHighPriority = config?.preserveHighPriority ?? true;
  }

  /**
   * Deliver a message to the inbox.
   * Returns false if the message was dropped (capacity exceeded).
   */
  deliver(message: Omit<SteeringMessage, "id" | "timestamp">): boolean {
    const full: SteeringMessage = {
      ...message,
      id: `steering-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
    };

    if (this.messages.length >= this.maxCapacity) {
      if (this.preserveHighPriority && full.priority === "high") {
        // Drop oldest low/normal priority message
        const idx = this.messages.findIndex((m) => m.priority !== "high");
        if (idx >= 0) {
          this.messages.splice(idx, 1);
        } else {
          // All high priority — drop oldest
          this.messages.shift();
        }
      } else {
        this.messages.shift();
      }
    }

    this.messages.push(full);
    this.drained = false;
    return true;
  }

  /**
   * Drain all pending messages and format them as a prompt section.
   * Returns null if no messages are pending.
   *
   * After calling this, the messages are consumed until the next delivery.
   */
  drain(): string | null {
    if (this.messages.length === 0) return null;
    this.drained = true;

    const msgs = [...this.messages];
    this.messages = [];

    if (msgs.length === 0) return null;

    const lines = ["### notices", ""];
    for (const msg of msgs) {
      const source = msg.source === "user" ? "User" : msg.source;
      const priority = msg.priority === "high" ? " [HIGH]" : "";
      lines.push(`- [${source}]${priority} ${msg.content}`);
    }
    lines.push("");
    lines.push("Acknowledge the above before continuing.");

    return lines.join("\n");
  }

  /**
   * Check if there are pending messages.
   */
  hasPending(): boolean {
    return this.messages.length > 0;
  }

  /**
   * Get count of pending messages.
   */
  pendingCount(): number {
    return this.messages.length;
  }

  /**
   * Peek at messages without consuming them.
   */
  peek(): readonly SteeringMessage[] {
    return [...this.messages];
  }

  /**
   * Clear all messages.
   */
  clear(): void {
    this.messages = [];
  }
}
