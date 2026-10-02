/**
 * Event Bus
 *
 * Centralized event handling using Emittery
 */

import Emittery from "emittery";
import type {
  TradeEvent,
  RiskEvent,
  AgentEvent,
  ChannelEnvelope,
} from "@dyna/contracts";

/** Union type kept for backward-compatible type narrowing in consumers */
export type EventData =
  | TradeEvent
  | RiskEvent
  | AgentEvent
  | ChannelEnvelope
  | { type: string; payload: unknown };

/** Mapped event map for Emittery generic parameter */
export interface EventMap {
  trade: TradeEvent;
  risk: RiskEvent;
  agent: AgentEvent;
  channel: ChannelEnvelope;
  error: unknown;
  "*": unknown;
  [key: string]: unknown;
}

export interface EventBusConfig {
  maxListeners?: number;
  strictEvents?: boolean;
}

export class EventBus extends Emittery<EventMap> {
  private config: EventBusConfig;
  private eventHistory: Array<{
    id: string;
    type: string;
    timestamp: Date;
    data: unknown;
  }> = [];
  private maxHistorySize: number = 1000;

  constructor(config: EventBusConfig = {}) {
    super();

    this.config = {
      strictEvents: false,
      ...config,
    };

    // Set up built-in event handlers
    this.setupEventHandlers();
  }

  /**
   * Emit a dynamic event type (string key) with data, storing in history.
   * Use this when the event type is not a literal known at compile time
   * (e.g. runtime-specific event namespaces like "channel-runtime").
   */
  emitDynamic(type: string, data: unknown): Promise<void> {
    this.addToHistory(type, data);
    return this.emit(type as keyof EventMap, data);
  }

  /**
   * Emit an event with data, storing in history.
   */
  emitWithHistory(eventType: string, data: unknown): void {
    this.addToHistory(eventType, data);
    void this.emitDynamic(eventType, data);
  }

  /**
   * Emit multiple events
   */
  async emitBatch(events: Array<{ type: string; data: unknown }>): Promise<void> {
    await Promise.all(events.map(event => {
      this.addToHistory(event.type, event.data);
      return this.emitDynamic(event.type, event.data);
    }));
  }

  /**
   * Get event history
   */
  getHistory(options?: {
    type?: string;
    limit?: number;
    since?: Date;
  }): Array<{
    id: string;
    type: string;
    timestamp: Date;
    data: unknown;
  }> {
    let history = [...this.eventHistory];

    // Filter by type
    if (options?.type) {
      history = history.filter(event => event.type === options.type);
    }

    // Filter by date
    if (options?.since) {
      history = history.filter(event => event.timestamp >= options.since!);
    }

    // Apply limit
    const limit = options?.limit || 100;
    return history.slice(-limit);
  }

  /**
   * Clear event history
   */
  clearHistory(): void {
    this.eventHistory = [];
  }

  /**
   * Get event statistics
   */
  getStats(): {
    totalEvents: number;
    eventsByType: Record<string, number>;
    oldestEvent?: Date;
    newestEvent?: Date;
  } {
    const eventsByType: Record<string, number> = {};

    this.eventHistory.forEach(event => {
      eventsByType[event.type] = (eventsByType[event.type] || 0) + 1;
    });

    return {
      totalEvents: this.eventHistory.length,
      eventsByType,
      oldestEvent: this.eventHistory[0]?.timestamp,
      newestEvent: this.eventHistory[this.eventHistory.length - 1]?.timestamp,
    };
  }

  /**
   * Set maximum history size
   */
  setMaxHistorySize(size: number): void {
    this.maxHistorySize = size;
    // Trim history if needed
    if (this.eventHistory.length > size) {
      this.eventHistory = this.eventHistory.slice(-size);
    }
  }

  /**
   * Add event to history
   */
  private addToHistory(type: string, data: unknown): void {
    const event = {
      id: `event-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type,
      timestamp: new Date(),
      data,
    };

    this.eventHistory.push(event);

    // Trim history if needed
    if (this.eventHistory.length > this.maxHistorySize) {
      this.eventHistory = this.eventHistory.slice(-this.maxHistorySize);
    }
  }

  /**
   * Setup built-in event handlers
   */
  private setupEventHandlers(): void {
    // Auto-log all events
    this.on("*", (data) => {
      console.debug(`[EventBus] Event emitted:`, data);
    });

    // Error handling
    this.on("error", (error) => {
      console.error(`[EventBus] Error in event handler:`, error);
    });
  }
}

// Export singleton instance
export const eventBus = new EventBus({
  maxListeners: 200,
  strictEvents: false,
});

// Export utility functions
export const createEvent = <T>(type: string, data: T): T & { id: string; timestamp: Date } => ({
  id: `event-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
  timestamp: new Date(),
  ...data,
});

export const emitTrade = (event: TradeEvent) => {
  return eventBus.emit("trade", event);
};

export const emitRisk = (event: RiskEvent) => {
  return eventBus.emit("risk", event);
};

export const emitAgent = (event: AgentEvent) => {
  return eventBus.emit("agent", event);
};

export const emitChannel = (event: ChannelEnvelope) => {
  return eventBus.emit("channel", event);
};