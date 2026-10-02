/**
 * AgentBus — Inter-agent communication via pub/sub and request/response
 *
 * Enables agents to publish messages, subscribe to topics, and make
 * direct requests to other agents. Ported from UI layer to core runtime.
 *
 * Usage:
 *   const bus = new AgentBus();
 *   bus.subscribe('analyst', 'market.update', (msg) => { ... });
 *   bus.publish('analyst', 'market.update', { symbol: 'BTC/USD', price: 65000 });
 *   const reply = await bus.request('analyst', 'risk-manager', 'risk.check', { symbol: 'BTC/USD' });
 */

import { randomUUID } from 'node:crypto';

export interface BusMessage {
  id: string;
  from: string;
  topic: string;
  content: unknown;
  timestamp: number;
  replyTo?: string;
}

export type BusCallback = (message: BusMessage) => void;

export interface PendingRequest {
  id: string;
  from: string;
  topic: string;
  content: unknown;
  timestamp: number;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface AgentBusOptions {
  maxHistorySize?: number;
}

export class AgentBus {
  private subscribers: Map<string, Map<string, BusCallback[]>> = new Map();
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private messageHistory: BusMessage[] = [];
  private maxHistorySize: number;

  constructor(options?: AgentBusOptions) {
    this.maxHistorySize = options?.maxHistorySize ?? 1000;
  }

  subscribe(agentId: string, topic: string, callback: BusCallback): () => void {
    if (!this.subscribers.has(agentId)) {
      this.subscribers.set(agentId, new Map());
    }

    const agentTopics = this.subscribers.get(agentId)!;
    if (!agentTopics.has(topic)) {
      agentTopics.set(topic, []);
    }

    agentTopics.get(topic)!.push(callback);

    return () => {
      const callbacks = agentTopics.get(topic);
      if (callbacks) {
        const idx = callbacks.indexOf(callback);
        if (idx >= 0) callbacks.splice(idx, 1);
      }
    };
  }

  publish(from: string, topic: string, content: unknown): void {
    const message: BusMessage = {
      id: randomUUID(),
      from,
      topic,
      content,
      timestamp: Date.now(),
    };

    this.addToHistory(message);

    for (const [agentId, agentTopics] of this.subscribers) {
      if (agentId === from) continue;

      const callbacks = agentTopics.get(topic);
      if (callbacks) {
        for (const cb of callbacks) {
          try {
            cb(message);
          } catch {
            // Subscriber error shouldn't crash the bus
          }
        }
      }

      const wildcardCallbacks = agentTopics.get('*');
      if (wildcardCallbacks) {
        for (const cb of wildcardCallbacks) {
          try {
            cb(message);
          } catch {
            // Subscriber error
          }
        }
      }
    }
  }

  async request(
    from: string,
    to: string,
    topic: string,
    content: unknown,
    timeoutMs: number = 120_000,
  ): Promise<unknown> {
    const requestId = randomUUID();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Request ${requestId} to ${to} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, {
        id: requestId,
        from,
        topic,
        content,
        timestamp: Date.now(),
        resolve,
        reject,
        timeout,
      });

      const message: BusMessage = {
        id: requestId,
        from,
        topic,
        content,
        timestamp: Date.now(),
        replyTo: requestId,
      };

      const agentTopics = this.subscribers.get(to);
      if (agentTopics) {
        const callbacks = agentTopics.get(topic);
        if (callbacks) {
          for (const cb of callbacks) {
            try {
              cb(message);
            } catch {
              // Subscriber error
            }
          }
        }
      }

      this.addToHistory(message);
    });
  }

  reply(requestId: string, from: string, content: unknown): boolean {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return false;

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(requestId);

    const replyMsg: BusMessage = {
      id: randomUUID(),
      from,
      topic: `${pending.topic}.reply`,
      content,
      timestamp: Date.now(),
      replyTo: requestId,
    };

    this.addToHistory(replyMsg);

    pending.resolve(content);
    return true;
  }

  unsubscribe(agentId: string, topic?: string): void {
    if (!topic) {
      this.subscribers.delete(agentId);
      return;
    }

    const agentTopics = this.subscribers.get(agentId);
    if (agentTopics) {
      agentTopics.delete(topic);
    }
  }

  getHistory(topic?: string, limit?: number): BusMessage[] {
    let messages = this.messageHistory;
    if (topic) {
      messages = messages.filter((m) => m.topic === topic || m.topic.startsWith(`${topic}.`));
    }
    if (limit) {
      messages = messages.slice(-limit);
    }
    return messages;
  }

  getSubscribers(topic: string): string[] {
    const result: string[] = [];
    for (const [agentId, agentTopics] of this.subscribers) {
      if (agentTopics.has(topic) || agentTopics.has('*')) {
        result.push(agentId);
      }
    }
    return result;
  }

  getPendingRequests(): Array<{ id: string; from: string; topic: string; age: number }> {
    const now = Date.now();
    return Array.from(this.pendingRequests.values()).map((r) => ({
      id: r.id,
      from: r.from,
      topic: r.topic,
      age: now - r.timestamp,
    }));
  }

  getStats(): { agents: number; topics: number; pendingRequests: number; historySize: number } {
    const topics = new Set<string>();
    for (const agentTopics of this.subscribers.values()) {
      for (const topic of agentTopics.keys()) {
        topics.add(topic);
      }
    }
    return {
      agents: this.subscribers.size,
      topics: topics.size,
      pendingRequests: this.pendingRequests.size,
      historySize: this.messageHistory.length,
    };
  }

  private addToHistory(message: BusMessage): void {
    this.messageHistory.push(message);
    if (this.messageHistory.length > this.maxHistorySize) {
      this.messageHistory = this.messageHistory.slice(-this.maxHistorySize / 2);
    }
  }

  clear(): void {
    this.subscribers.clear();
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Bus cleared'));
    }
    this.pendingRequests.clear();
    this.messageHistory = [];
  }
}
