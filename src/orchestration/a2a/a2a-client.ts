/**
 * A2A Client
 *
 * Client for communicating with remote agents via the Google A2A protocol.
 * Supports:
 * - Agent Card discovery
 * - Task submission
 * - Multi-turn conversations
 * - Push notifications
 *
 * A2A client implementation.
 */

import { randomUUID } from 'crypto';
import type {
  AgentCard,
  Task,
  A2AMessage,
  A2ARequest,
  A2AResponse,
} from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface A2AClientConfig {
  /** Base URL of the remote agent. */
  baseUrl: string;
  /** Authentication token (bearer). Optional. */
  authToken?: string;
  /** Request timeout in ms. Default: 30000. */
  timeoutMs?: number;
  /** Maximum retries. Default: 3. */
  maxRetries?: number;
}

export type A2AClientConfigResolved = Required<Omit<A2AClientConfig, 'authToken'>> & { authToken?: string };

export interface A2ASendRequest {
  /** Message to send. */
  message: string;
  /** Session ID for multi-turn conversations. */
  sessionId?: string;
  /** Metadata to attach to the message. */
  metadata?: Record<string, unknown>;
}

export interface A2ASendResponse {
  /** Task ID. */
  taskId: string;
  /** Session ID. */
  sessionId: string;
  /** Task status. */
  status: Task['status'];
  /** Reply message (if completed). */
  reply?: A2AMessage;
}

export interface A2AClientStatus {
  connected: boolean;
  agentCard?: AgentCard;
  lastError?: string;
  requestCount: number;
  errorCount: number;
}

// ---------------------------------------------------------------------------
// A2AClient
// ---------------------------------------------------------------------------

export class A2AClient {
  private config: A2AClientConfigResolved;
  private agentCard: AgentCard | null = null;
  private status: A2AClientStatus = {
    connected: false,
    requestCount: 0,
    errorCount: 0,
  };

  constructor(config: A2AClientConfig) {
    this.config = {
      baseUrl: config.baseUrl,
      authToken: config.authToken,
      timeoutMs: config.timeoutMs ?? 120_000,
      maxRetries: config.maxRetries ?? 3,
    };
  }

  /**
   * Discover the remote agent's capabilities.
   * Fetches the Agent Card from /.well-known/agent-card.json.
   */
  async discover(): Promise<AgentCard> {
    const url = `${this.config.baseUrl}/.well-known/agent-card.json`;

    const response = await this.fetchWithTimeout(url);

    if (!response.ok) {
      throw new Error(`Failed to discover agent: ${response.status} ${response.statusText}`);
    }

    this.agentCard = await response.json() as AgentCard;
    this.status.connected = true;
    this.status.agentCard = this.agentCard;

    return this.agentCard;
  }

  /**
   * Get the cached Agent Card.
   * Discovers if not already cached.
   */
  async getAgentCard(): Promise<AgentCard> {
    if (!this.agentCard) {
      return this.discover();
    }
    return this.agentCard;
  }

  /**
   * Send a message to the remote agent.
   * Returns immediately with a task ID.
   */
  async send(request: A2ASendRequest): Promise<A2ASendResponse> {
    const message: A2AMessage = {
      role: 'user',
      parts: [{ type: 'text', text: request.message }],
      metadata: request.metadata ?? {},
    };

    const result = await this.jsonRpc('tasks/send', {
      message,
      sessionId: request.sessionId,
    }) as { taskId: string; sessionId: string; status: Task['status'] };

    return {
      taskId: result.taskId,
      sessionId: result.sessionId,
      status: result.status,
    };
  }

  /**
   * Send a message and wait for the task to complete.
   * Polls the task status until completed or failed.
   */
  async sendAndWait(
    request: A2ASendRequest,
    pollIntervalMs: number = 1000,
  ): Promise<A2ASendResponse & { reply?: A2AMessage }> {
    const sendResult = await this.send(request);

    // Poll until completed or failed
    let task = await this.getTask(sendResult.taskId);
    while (task.status.state === 'working' || task.status.state === 'submitted') {
      await this.sleep(pollIntervalMs);
      task = await this.getTask(sendResult.taskId);
    }

    return {
      ...sendResult,
      status: task.status,
      reply: task.status.message as A2AMessage | undefined,
    };
  }

  /**
   * Get task status.
   */
  async getTask(taskId: string): Promise<Task> {
    const result = await this.jsonRpc('tasks/get', { taskId });
    return result as Task;
  }

  /**
   * Cancel a task.
   */
  async cancelTask(taskId: string): Promise<Task> {
    const result = await this.jsonRpc('tasks/cancel', { taskId });
    return result as Task;
  }

  /**
   * Multi-turn conversation via session.
   * Sends multiple messages and collects all responses.
   */
  async conversation(
    messages: string[],
    pollIntervalMs: number = 1000,
  ): Promise<A2AMessage[]> {
    const responses: A2AMessage[] = [];
    let sessionId: string | undefined;

    for (const message of messages) {
      const result = await this.sendAndWait(
        { message, sessionId },
        pollIntervalMs,
      );
      sessionId = result.sessionId;

      if (result.reply) {
        responses.push(result.reply);
      }
    }

    return responses;
  }

  /**
   * Get client status.
   */
  getStatus(): A2AClientStatus {
    return { ...this.status };
  }

  /**
   * Check if the remote agent is reachable.
   */
  async ping(): Promise<boolean> {
    try {
      await this.discover();
      return true;
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Private Helpers
  // -----------------------------------------------------------------------

  private async jsonRpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const request: A2ARequest = {
      jsonrpc: '2.0',
      id: randomUUID(),
      method,
      params,
    };

    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      try {
        this.status.requestCount++;

        const response = await this.fetchWithTimeout(this.config.baseUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.config.authToken ? { 'Authorization': `Bearer ${this.config.authToken}` } : {}),
          },
          body: JSON.stringify(request),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const json = await response.json() as A2AResponse;

        if (json.error) {
          throw new Error(`JSON-RPC error: ${json.error.message}`);
        }

        return json.result as Task;
      } catch (err) {
        lastError = err as Error;
        this.status.errorCount++;
        this.status.lastError = lastError.message;

        if (attempt < this.config.maxRetries - 1) {
          await this.sleep(1000 * (attempt + 1)); // Exponential backoff
        }
      }
    }

    throw lastError;
  }

  private async fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ---------------------------------------------------------------------------
// Factory: Create Client from Agent Card URL
// ---------------------------------------------------------------------------

export function createA2AClient(
  url: string,
  options?: {
    authToken?: string;
    timeoutMs?: number;
    maxRetries?: number;
  },
): A2AClient {
  return new A2AClient({
    baseUrl: url,
    authToken: options?.authToken,
    timeoutMs: options?.timeoutMs,
    maxRetries: options?.maxRetries,
  });
}
