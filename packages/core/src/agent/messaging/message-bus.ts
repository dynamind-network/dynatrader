/**
 * Async Message Bus
 *
 * Enables agent-to-agent communication via pub/sub messaging.
 * Supports both synchronous (request/response) and asynchronous
 * (fire-and-forget with callbacks) patterns.
 *
 * Patterns:
 * - Direct messaging (agent-to-agent)
 * - Topic-based pub/sub
 * - Request/Response with correlation IDs
 * - Broadcast to all agents
 */

import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MessagePriority = 'low' | 'normal' | 'high' | 'urgent';

export interface AgentMessage {
  /** Unique message ID. */
  id: string;
  /** Sender agent name. */
  from: string;
  /** Receiver agent name (null for broadcast). */
  to: string | null;
  /** Topic/channel for pub/sub. */
  topic: string;
  /** Message payload. */
  payload: unknown;
  /** Priority level. */
  priority: MessagePriority;
  /** Correlation ID for request/response pairing. */
  correlationId?: string;
  /** Timestamp. */
  timestamp: number;
  /** Time-to-live in ms (0 = no expiry). */
  ttl?: number;
  /** Metadata. */
  metadata?: Record<string, unknown>;
}

export interface MessageHandler {
  (message: AgentMessage): Promise<unknown> | void;
}

export interface RequestResponseOptions {
  /** Timeout in ms. Default: 120000. */
  timeoutMs?: number;
  /** Priority. Default: normal. */
  priority?: MessagePriority;
}

export interface MessageBusStats {
  totalMessages: number;
  messagesByTopic: Record<string, number>;
  messagesByAgent: Record<string, number>;
  pendingRequests: number;
  handlersRegistered: number;
}

// ---------------------------------------------------------------------------
// MessageBus
// ---------------------------------------------------------------------------

export class MessageBus extends EventEmitter {
  private handlers: Map<string, Set<MessageHandler>> = new Map();
  private pendingRequests: Map<string, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = new Map();
  private messageHistory: AgentMessage[] = [];
  private maxHistorySize: number;

  constructor(options?: { maxHistorySize?: number }) {
    super();
    this.maxHistorySize = options?.maxHistorySize ?? 1000;
  }

  // -----------------------------------------------------------------------
  // Publishing
  // -----------------------------------------------------------------------

  /**
   * Send a message to a specific agent (synchronous request/response).
   * Waits for the handler to process and return a result.
   */
  async request(
    to: string,
    topic: string,
    payload: unknown,
    options?: RequestResponseOptions,
  ): Promise<unknown> {
    const correlationId = randomUUID();
    const message: AgentMessage = {
      id: randomUUID(),
      from: 'system',
      to,
      topic,
      payload,
      priority: options?.priority ?? 'normal',
      correlationId,
      timestamp: Date.now(),
    };

    return new Promise((resolve, reject) => {
      const timeoutMs = options?.timeoutMs ?? 120_000;

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(correlationId);
        reject(new Error(`Request to ${topic} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(correlationId, { resolve, reject, timeout });

      // Emit to handlers
      this.deliverMessage(message);
    });
  }

  /**
   * Send a message to a specific agent (fire-and-forget).
   */
  async send(
    to: string,
    topic: string,
    payload: unknown,
    options?: { priority?: MessagePriority },
  ): Promise<void> {
    const message: AgentMessage = {
      id: randomUUID(),
      from: 'system',
      to,
      topic,
      payload,
      priority: options?.priority ?? 'normal',
      timestamp: Date.now(),
    };

    this.deliverMessage(message);
  }

  /**
   * Broadcast a message to all agents.
   */
  async broadcast(
    topic: string,
    payload: unknown,
    options?: { priority?: MessagePriority },
  ): Promise<void> {
    const message: AgentMessage = {
      id: randomUUID(),
      from: 'system',
      to: null,
      topic,
      payload,
      priority: options?.priority ?? 'normal',
      timestamp: Date.now(),
    };

    // Deliver to all handlers
    for (const [topicPattern, handlers] of this.handlers) {
      if (this.topicMatches(topic, topicPattern)) {
        for (const handler of handlers) {
          try {
            handler(message);
          } catch (err) {
            console.error(`Broadcast handler error:`, err);
          }
        }
      }
    }

    this.recordMessage(message);
    this.emit('broadcast', message);
  }

  /**
   * Send a message from a specific agent.
   */
  async sendFrom(
    from: string,
    to: string,
    topic: string,
    payload: unknown,
    options?: { priority?: MessagePriority; correlationId?: string },
  ): Promise<void> {
    const message: AgentMessage = {
      id: randomUUID(),
      from,
      to,
      topic,
      payload,
      priority: options?.priority ?? 'normal',
      correlationId: options?.correlationId,
      timestamp: Date.now(),
    };

    this.deliverMessage(message);
  }

  /**
   * Send a request from a specific agent and wait for response.
   */
  async requestFrom(
    from: string,
    to: string,
    topic: string,
    payload: unknown,
    options?: RequestResponseOptions,
  ): Promise<unknown> {
    const correlationId = randomUUID();
    const message: AgentMessage = {
      id: randomUUID(),
      from,
      to,
      topic,
      payload,
      priority: options?.priority ?? 'normal',
      correlationId,
      timestamp: Date.now(),
    };

    return new Promise((resolve, reject) => {
      const timeoutMs = options?.timeoutMs ?? 120_000;

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(correlationId);
        reject(new Error(`Request from ${from} to ${topic} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(correlationId, { resolve, reject, timeout });

      // Emit to handlers
      this.deliverMessage(message);
    });
  }

  /**
   * Reply to a request (completes a request/response cycle).
   */
  reply(correlationId: string, result: unknown): void {
    const pending = this.pendingRequests.get(correlationId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(correlationId);
      pending.resolve(result);
    }
  }

  // -----------------------------------------------------------------------
  // Subscribing
  // -----------------------------------------------------------------------

  /**
   * Subscribe to messages on a topic.
   * Supports wildcards: '*' for single level, '**' for multi-level.
   */
  subscribe(topic: string, handler: MessageHandler): () => void {
    if (!this.handlers.has(topic)) {
      this.handlers.set(topic, new Set());
    }
    this.handlers.get(topic)!.add(handler);

    // Return unsubscribe function
    return () => {
      this.handlers.get(topic)?.delete(handler);
      if (this.handlers.get(topic)?.size === 0) {
        this.handlers.delete(topic);
      }
    };
  }

  /**
   * Subscribe to all messages (regardless of topic).
   */
  subscribeAll(handler: MessageHandler): () => void {
    return this.subscribe('**', handler);
  }

  /**
   * Unsubscribe from a topic.
   */
  unsubscribe(topic: string, handler: MessageHandler): void {
    this.handlers.get(topic)?.delete(handler);
    if (this.handlers.get(topic)?.size === 0) {
      this.handlers.delete(topic);
    }
  }

  // -----------------------------------------------------------------------
  // History & Stats
  // -----------------------------------------------------------------------

  /**
   * Get message history.
   */
  getHistory(options?: {
    from?: string;
    to?: string;
    topic?: string;
    limit?: number;
  }): AgentMessage[] {
    let messages = [...this.messageHistory];

    if (options?.from) {
      messages = messages.filter(m => m.from === options.from);
    }
    if (options?.to) {
      messages = messages.filter(m => m.to === options.to);
    }
    if (options?.topic) {
      messages = messages.filter(m => this.topicMatches(m.topic, options.topic!));
    }

    if (options?.limit) {
      messages = messages.slice(-options.limit);
    }

    return messages;
  }

  /**
   * Get message bus statistics.
   */
  getStats(): MessageBusStats {
    const messagesByTopic: Record<string, number> = {};
    const messagesByAgent: Record<string, number> = {};

    for (const msg of this.messageHistory) {
      messagesByTopic[msg.topic] = (messagesByTopic[msg.topic] ?? 0) + 1;
      messagesByAgent[msg.from] = (messagesByAgent[msg.from] ?? 0) + 1;
    }

    return {
      totalMessages: this.messageHistory.length,
      messagesByTopic,
      messagesByAgent,
      pendingRequests: this.pendingRequests.size,
      handlersRegistered: Array.from(this.handlers.values()).reduce((sum, set) => sum + set.size, 0),
    };
  }

  /**
   * Clear message history.
   */
  clearHistory(): void {
    this.messageHistory = [];
  }

  // -----------------------------------------------------------------------
  // Private Helpers
  // -----------------------------------------------------------------------

  private deliverMessage(message: AgentMessage): void {
    // Check TTL
    if (message.ttl && message.ttl > 0) {
      const age = Date.now() - message.timestamp;
      if (age > message.ttl) {
        return; // Message expired
      }
    }

    // Deliver to matching handlers
    for (const [topicPattern, handlers] of this.handlers) {
      if (this.topicMatches(message.topic, topicPattern)) {
        for (const handler of handlers) {
          try {
            const result = handler(message);

            // If this is a request (has correlationId), handle response
            if (message.correlationId && result instanceof Promise) {
              result
                .then(response => {
                  this.reply(message.correlationId!, response);
                })
                .catch(err => {
                  console.error(`Handler error for request ${message.correlationId}:`, err);
                  const pending = this.pendingRequests.get(message.correlationId!);
                  if (pending) {
                    clearTimeout(pending.timeout);
                    this.pendingRequests.delete(message.correlationId!);
                    pending.reject(err);
                  }
                });
            }
          } catch (err) {
            console.error(`Handler error:`, err);
          }
        }
      }
    }

    this.recordMessage(message);
    this.emit('message', message);
  }

  private recordMessage(message: AgentMessage): void {
    this.messageHistory.push(message);

    // Trim history if needed
    if (this.messageHistory.length > this.maxHistorySize) {
      this.messageHistory = this.messageHistory.slice(-this.maxHistorySize);
    }
  }

  private topicMatches(topic: string, pattern: string): boolean {
    // Exact match
    if (topic === pattern) return true;

    // Wildcard match
    const topicParts = topic.split('/');
    const patternParts = pattern.split('/');

    let topicIdx = 0;
    let patternIdx = 0;

    while (topicIdx < topicParts.length && patternIdx < patternParts.length) {
      if (patternParts[patternIdx] === '**') {
        // Multi-level wildcard - match rest
        return true;
      }
      if (patternParts[patternIdx] === '*') {
        // Single-level wildcard
        topicIdx++;
        patternIdx++;
      } else if (patternParts[patternIdx] === topicParts[topicIdx]) {
        topicIdx++;
        patternIdx++;
      } else {
        return false;
      }
    }

    return topicIdx === topicParts.length && patternIdx === patternParts.length;
  }
}

// ---------------------------------------------------------------------------
// Singleton instance
// ---------------------------------------------------------------------------

let defaultBus: MessageBus | null = null;

export function getMessageBus(): MessageBus {
  if (!defaultBus) {
    defaultBus = new MessageBus();
  }
  return defaultBus;
}

export function resetMessageBus(): void {
  if (defaultBus) {
    defaultBus.removeAllListeners();
    defaultBus.clearHistory();
    defaultBus = null;
  }
}
