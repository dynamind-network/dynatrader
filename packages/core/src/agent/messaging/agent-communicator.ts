/**
 * Agent Communicator
 *
 * High-level API for agent-to-agent communication.
 * Wraps the MessageBus and A2A systems to provide a unified interface
 * for both local (in-process) and remote (HTTP) agent communication.
 *
 * Supports:
 * - Synchronous request/response
 * - Asynchronous fire-and-forget
 * - Topic-based pub/sub
 * - Agent discovery and routing
 */

import { randomUUID } from 'crypto';
import type { AgentMessage, MessageHandler } from '../messaging/message-bus';
import { MessageBus } from '../messaging/message-bus';
import type { AgentProfileManager } from '../profiles/agent-profile-manager';
import type { A2ADiscovery } from '../../orchestration/a2a/a2a-discovery';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CommunicationMode = 'local' | 'remote' | 'auto';

export interface CommunicatorConfig {
  /** This agent's name. */
  agentName: string;
  /** Default communication mode. */
  mode: CommunicationMode;
  /** Request timeout in ms. Default: 120000. */
  timeoutMs?: number;
}

export interface SendMessageRequest {
  /** Target agent name. */
  to: string;
  /** Topic/channel. */
  topic: string;
  /** Message payload. */
  payload: unknown;
  /** Priority. */
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  /** Whether to wait for response. */
  expectResponse?: boolean;
}

export interface SendMessageResponse {
  /** Message ID. */
  messageId: string;
  /** Response (if expectResponse was true). */
  response?: unknown;
  /** Whether communication was local. */
  wasLocal: boolean;
  /** Duration in ms. */
  durationMs: number;
}

export interface AgentInfo {
  name: string;
  description: string;
  type: 'manager' | 'leaf';
  team: string;
  roles: string[];
  reachable: boolean;
  isLocal: boolean;
}

// ---------------------------------------------------------------------------
// AgentCommunicator
// ---------------------------------------------------------------------------

export class AgentCommunicator {
  private config: CommunicatorConfig;
  private messageBus: MessageBus;
  private profileManager?: AgentProfileManager;
  private discovery?: A2ADiscovery;

  constructor(
    config: CommunicatorConfig,
    messageBus?: MessageBus,
    profileManager?: AgentProfileManager,
    discovery?: A2ADiscovery,
  ) {
    this.config = {
      timeoutMs: 120_000,
      ...config,
    };
    this.messageBus = messageBus ?? new MessageBus();
    this.profileManager = profileManager;
    this.discovery = discovery;
  }

  // -----------------------------------------------------------------------
  // Synchronous Communication
  // -----------------------------------------------------------------------

  /**
   * Send a message and wait for a response (request/response pattern).
   */
  async request(to: string, topic: string, payload: unknown): Promise<unknown> {
    const startTime = Date.now();

    // Determine if target is local or remote
    const isLocal = await this.isLocalAgent(to);

    if (isLocal) {
      // Local communication via message bus
      return this.messageBus.requestFrom(
        this.config.agentName,
        to,
        topic,
        payload,
        { timeoutMs: this.config.timeoutMs },
      );
    } else {
      // Remote communication via A2A
      return this.remoteRequest(to, topic, payload);
    }
  }

  /**
   * Send a message to another agent (fire-and-forget).
   */
  async send(
    to: string,
    topic: string,
    payload: unknown,
    options?: { priority?: 'low' | 'normal' | 'high' | 'urgent' },
  ): Promise<void> {
    const isLocal = await this.isLocalAgent(to);

    if (isLocal) {
      await this.messageBus.sendFrom(
        this.config.agentName,
        to,
        topic,
        payload,
        { priority: options?.priority },
      );
    } else {
      await this.remoteSend(to, topic, payload);
    }
  }

  /**
   * Broadcast a message to all agents.
   */
  async broadcast(
    topic: string,
    payload: unknown,
    options?: { priority?: 'low' | 'normal' | 'high' | 'urgent' },
  ): Promise<void> {
    // Broadcast locally
    await this.messageBus.broadcast(topic, payload, options);

    // Broadcast to remote agents
    if (this.discovery) {
      const peers = this.discovery.getReachablePeers();
      for (const peer of peers) {
        try {
          await peer.client.send({ message: JSON.stringify({ topic, payload }) });
        } catch (err) {
          console.error(`Failed to broadcast to ${peer.config.name}:`, err);
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Subscription
  // -----------------------------------------------------------------------

  /**
   * Subscribe to messages on a topic.
   * Returns an unsubscribe function.
   */
  subscribe(topic: string, handler: MessageHandler): () => void {
    return this.messageBus.subscribe(topic, handler);
  }

  /**
   * Subscribe to all messages.
   */
  subscribeAll(handler: MessageHandler): () => void {
    return this.messageBus.subscribeAll(handler);
  }

  // -----------------------------------------------------------------------
  // Agent Discovery
  // -----------------------------------------------------------------------

  /**
   * List all known agents (local and remote).
   */
  async listAgents(): Promise<AgentInfo[]> {
    const agents: AgentInfo[] = [];

    // Local agents
    if (this.profileManager) {
      const profiles = await this.profileManager.list();
      for (const profile of profiles) {
        agents.push({
          name: profile.name,
          description: profile.description,
          type: profile.type,
          team: profile.team,
          roles: profile.roles,
          reachable: true,
          isLocal: true,
        });
      }
    }

    // Remote agents
    if (this.discovery) {
      const peers = this.discovery.getReachablePeers();
      for (const peer of peers) {
        agents.push({
          name: peer.config.name,
          description: peer.card?.description ?? '',
          type: 'leaf',
          team: '',
          roles: peer.config.capabilities ?? [],
          reachable: peer.reachable,
          isLocal: false,
        });
      }
    }

    return agents;
  }

  /**
   * Get info about a specific agent.
   */
  async getAgent(name: string): Promise<AgentInfo | null> {
    const agents = await this.listAgents();
    return agents.find(a => a.name === name) ?? null;
  }

  /**
   * Find agents by role or capability.
   */
  async findAgents(query: { role?: string; capability?: string }): Promise<AgentInfo[]> {
    const agents = await this.listAgents();

    return agents.filter(agent => {
      if (query.role && !agent.roles.includes(query.role)) {
        return false;
      }
      if (query.capability && !agent.roles.includes(query.capability)) {
        return false;
      }
      return true;
    });
  }

  // -----------------------------------------------------------------------
  // History & Stats
  // -----------------------------------------------------------------------

  /**
   * Get communication history.
   */
  getHistory(options?: {
    from?: string;
    to?: string;
    topic?: string;
    limit?: number;
  }): AgentMessage[] {
    return this.messageBus.getHistory(options);
  }

  /**
   * Get communication statistics.
   */
  getStats() {
    return this.messageBus.getStats();
  }

  // -----------------------------------------------------------------------
  // Private Helpers
  // -----------------------------------------------------------------------

  private async isLocalAgent(name: string): Promise<boolean> {
    if (this.profileManager) {
      return this.profileManager.exists(name);
    }
    return false;
  }

  private async remoteRequest(
    to: string,
    topic: string,
    payload: unknown,
  ): Promise<unknown> {
    if (!this.discovery) {
      throw new Error(`No discovery configured for remote communication`);
    }

    const peer = this.discovery.getPeer(to);
    if (!peer) {
      throw new Error(`Remote agent "${to}" not found`);
    }

    const result = await peer.client.sendAndWait({
      message: JSON.stringify({ topic, payload }),
    });

    return result.reply;
  }

  private async remoteSend(
    to: string,
    topic: string,
    payload: unknown,
  ): Promise<void> {
    if (!this.discovery) {
      throw new Error(`No discovery configured for remote communication`);
    }

    const peer = this.discovery.getPeer(to);
    if (!peer) {
      throw new Error(`Remote agent "${to}" not found`);
    }

    await peer.client.send({
      message: JSON.stringify({ topic, payload }),
    });
  }
}

// ---------------------------------------------------------------------------
// Factory: Create Communicator for an Agent
// ---------------------------------------------------------------------------

export function createAgentCommunicator(
  agentName: string,
  options?: {
    messageBus?: MessageBus;
    profileManager?: AgentProfileManager;
    discovery?: A2ADiscovery;
    timeoutMs?: number;
  },
): AgentCommunicator {
  return new AgentCommunicator(
    {
      agentName,
      mode: 'auto',
      timeoutMs: options?.timeoutMs,
    },
    options?.messageBus,
    options?.profileManager,
    options?.discovery,
  );
}
