/**
 * Agent-to-Agent Communication — Message Routing
 *
 * Direct message routing between agent sessions via a supervisor.
 * Supports request/response and fire-and-forget patterns.
 */

import { randomUUID } from "node:crypto";

export type AgentMessageType = "request" | "response" | "fire-and-forget" | "broadcast";

export interface AgentMessage {
  id: string;
  type: AgentMessageType;
  fromSessionId: string;
  toSessionId: string | "*";
  topic: string;
  payload: unknown;
  timestamp: number;
  correlationId?: string;
  replyTo?: string;
}

export interface AgentMessageHandler {
  (message: AgentMessage): Promise<unknown | void>;
}

export interface AgentMessagingConfig {
  /** Max pending messages per session. Default: 100 */
  maxPendingPerSession?: number;
  /** Message TTL (ms). Default: 300000 (5 min) */
  messageTtlMs?: number;
}

/**
 * In-memory agent-to-agent message bus.
 */
export class AgentMessaging {
  private readonly maxPendingPerSession: number;
  private readonly messageTtlMs: number;

  private handlers = new Map<string, AgentMessageHandler>();
  private pending = new Map<string, AgentMessage[]>();
  private responses = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(config?: AgentMessagingConfig) {
    this.maxPendingPerSession = config?.maxPendingPerSession ?? 100;
    this.messageTtlMs = config?.messageTtlMs ?? 300000;
  }

  /**
   * Register a message handler for a topic.
   */
  on(topic: string, handler: AgentMessageHandler): void {
    this.handlers.set(topic, handler);
  }

  /**
   * Unregister a handler.
   */
  off(topic: string): void {
    this.handlers.delete(topic);
  }

  /**
   * Send a fire-and-forget message.
   */
  send(
    fromSessionId: string,
    toSessionId: string,
    topic: string,
    payload: unknown,
  ): AgentMessage {
    const msg: AgentMessage = {
      id: randomUUID(),
      type: "fire-and-forget",
      fromSessionId,
      toSessionId,
      topic,
      payload,
      timestamp: Date.now(),
    };
    this.deliver(msg);
    return msg;
  }

  /**
   * Send a request and wait for a response.
   */
  async request(
    fromSessionId: string,
    toSessionId: string,
    topic: string,
    payload: unknown,
    timeoutMs?: number,
  ): Promise<unknown> {
    const msg: AgentMessage = {
      id: randomUUID(),
      type: "request",
      fromSessionId,
      toSessionId,
      topic,
      payload,
      timestamp: Date.now(),
      correlationId: randomUUID(),
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.responses.delete(msg.correlationId!);
        reject(new Error(`Request ${msg.id} timed out after ${timeoutMs ?? 60_000}ms`));
      }, timeoutMs ?? 60_000);

      this.responses.set(msg.correlationId!, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });

      this.deliver(msg);
    });
  }

  /**
   * Broadcast a message to all sessions.
   */
  broadcast(fromSessionId: string, topic: string, payload: unknown): AgentMessage {
    const msg: AgentMessage = {
      id: randomUUID(),
      type: "broadcast",
      fromSessionId,
      toSessionId: "*",
      topic,
      payload,
      timestamp: Date.now(),
    };
    this.deliver(msg);
    return msg;
  }

  /**
   * Reply to a request message.
   */
  reply(originalMessage: AgentMessage, payload: unknown): void {
    if (originalMessage.type !== "request" || !originalMessage.correlationId) return;
    const pending = this.responses.get(originalMessage.correlationId);
    if (pending) {
      pending.resolve(payload);
      this.responses.delete(originalMessage.correlationId);
    }
  }

  /**
   * Get pending messages for a session.
   */
  getPending(sessionId: string): AgentMessage[] {
    const msgs = this.pending.get(sessionId) ?? [];
    // Filter expired
    const now = Date.now();
    const valid = msgs.filter((m) => now - m.timestamp < this.messageTtlMs);
    this.pending.set(sessionId, valid);
    return valid;
  }

  /**
   * Drain pending messages for a session.
   */
  drainPending(sessionId: string): AgentMessage[] {
    const msgs = this.getPending(sessionId);
    this.pending.set(sessionId, []);
    return msgs;
  }

  /**
   * Clear all messages for a session.
   */
  clearSession(sessionId: string): void {
    this.pending.delete(sessionId);
  }

  private deliver(message: AgentMessage): void {
    if (message.toSessionId === "*") {
      // Broadcast — deliver to all sessions except sender
      for (const [sid, msgs] of this.pending) {
        if (sid !== message.fromSessionId) {
          msgs.push(message);
          if (msgs.length > this.maxPendingPerSession) {
            msgs.shift();
          }
        }
      }
      // Also check registered handlers
      const handler = this.handlers.get(message.topic);
      if (handler) {
        handler(message).catch(() => undefined);
      }
      return;
    }

    // Direct message
    const targetPending = this.pending.get(message.toSessionId) ?? [];
    targetPending.push(message);
    if (targetPending.length > this.maxPendingPerSession) {
      targetPending.shift();
    }
    this.pending.set(message.toSessionId, targetPending);

    // Check registered handlers
    const handler = this.handlers.get(message.topic);
    if (handler) {
      handler(message).catch(() => undefined);
    }

    // If it's a request and the handler replied inline, the response is already resolved
    if (message.type === "request" && message.correlationId) {
      // Check if handler already replied — if not, deliver to session's pending queue
    }
  }
}
