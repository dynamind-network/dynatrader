/**
 * FleetManager — Parallel agent execution (core runtime)
 *
 * Spawns multiple agents on isolated sessions, each working on different tasks.
 * Supports status queries, messaging, cancellation, and result collection.
 *
 * Adapted from UI layer to use SubagentRuntime instead of AgentLoop.
 */

import { randomUUID } from 'node:crypto';

export type FleetAgentStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface FleetAgent {
  id: string;
  task: string;
  status: FleetAgentStatus;
  progress: number;
  result?: unknown;
  error?: string;
  sessionId: string;
  agentName: string;
  startedAt: number;
  completedAt?: number;
  messages: Array<{ from: string; content: string; timestamp: number }>;
}

export interface FleetAgentOptions {
  agentName?: string;
  sessionId?: string;
  timeout?: number;
  context?: Record<string, unknown>;
}

export interface FleetStatus {
  totalAgents: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  agents: FleetAgent[];
}

/**
 * Minimal interface for the SubagentRuntime that FleetManager depends on.
 */
export interface FleetSubagentRuntime {
  executeAgent(
    agentName: string,
    mode: 'research' | 'backtest' | 'paper' | 'shadow' | 'micro_live' | 'live',
    input: unknown,
  ): Promise<{
    agentName: string;
    mode: string;
    permissions: {
      allowedTools: string[];
      allowedSkills: string[];
      memoryAccess: { read: string[]; write: string[] };
    };
  }>;
}

export class FleetManager {
  private agents: Map<string, FleetAgent> = new Map();
  private subagentRuntime: FleetSubagentRuntime;
  private maxConcurrent: number;
  private runningCount = 0;

  constructor(subagentRuntime: FleetSubagentRuntime, options?: { maxConcurrent?: number }) {
    this.subagentRuntime = subagentRuntime;
    this.maxConcurrent = options?.maxConcurrent ?? 4;
  }

  async spawnAgent(
    task: string,
    options?: FleetAgentOptions,
  ): Promise<FleetAgent> {
    if (this.runningCount >= this.maxConcurrent) {
      throw new Error(
        `Max concurrent agents (${this.maxConcurrent}) reached. Wait for one to complete.`,
      );
    }

    const id = `fleet_${randomUUID().slice(0, 8)}`;
    const sessionId = options?.sessionId || `fleet_${id}`;

    const agent: FleetAgent = {
      id,
      task,
      status: 'running',
      progress: 0,
      sessionId,
      agentName: options?.agentName || 'general',
      startedAt: Date.now(),
      messages: [],
    };

    this.agents.set(id, agent);
    this.runningCount++;

    this.runAgent(agent, options?.timeout || 30 * 60 * 1000).catch((err) => {
      agent.status = 'failed';
      agent.error = err instanceof Error ? err.message : String(err);
      agent.completedAt = Date.now();
      this.runningCount--;
    });

    return agent;
  }

  private async runAgent(agent: FleetAgent, timeout: number): Promise<void> {
    const timer = setTimeout(() => {
      if (agent.status === 'running') {
        agent.status = 'failed';
        agent.error = `Timeout after ${timeout}ms`;
        agent.completedAt = Date.now();
        this.runningCount--;
      }
    }, timeout);

    try {
      const result = await this.subagentRuntime.executeAgent(
        agent.agentName,
        'paper',
        {
          task: agent.task,
          sessionId: agent.sessionId,
          isFleetAgent: true,
          fleetId: agent.id,
        },
      );

      clearTimeout(timer);

      if (agent.status === 'running') {
        agent.status = 'completed';
        agent.result = result;
        agent.progress = 100;
        agent.completedAt = Date.now();
        this.runningCount--;
      }
    } catch (err) {
      clearTimeout(timer);

      if (agent.status === 'running') {
        agent.status = 'failed';
        agent.error = err instanceof Error ? err.message : String(err);
        agent.completedAt = Date.now();
        this.runningCount--;
      }
    }
  }

  listAgents(): FleetAgent[] {
    return Array.from(this.agents.values());
  }

  getStatus(agentId: string): FleetAgent | undefined {
    return this.agents.get(agentId);
  }

  getFleetStatus(): FleetStatus {
    const agents = this.listAgents();
    return {
      totalAgents: agents.length,
      running: agents.filter((a) => a.status === 'running').length,
      completed: agents.filter((a) => a.status === 'completed').length,
      failed: agents.filter((a) => a.status === 'failed').length,
      cancelled: agents.filter((a) => a.status === 'cancelled').length,
      agents,
    };
  }

  cancelAgent(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent || agent.status !== 'running') return false;

    agent.status = 'cancelled';
    agent.completedAt = Date.now();
    this.runningCount--;
    return true;
  }

  cancelAll(): number {
    let cancelled = 0;
    for (const agent of this.agents.values()) {
      if (agent.status === 'running') {
        agent.status = 'cancelled';
        agent.completedAt = Date.now();
        this.runningCount--;
        cancelled++;
      }
    }
    return cancelled;
  }

  sendMessage(agentId: string, content: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;

    agent.messages.push({
      from: 'parent',
      content,
      timestamp: Date.now(),
    });

    return true;
  }

  getMessages(agentId: string): Array<{ from: string; content: string; timestamp: number }> {
    const agent = this.agents.get(agentId);
    return agent?.messages || [];
  }

  broadcast(content: string): number {
    let sent = 0;
    for (const agent of this.agents.values()) {
      if (agent.status === 'running') {
        agent.messages.push({
          from: 'broadcast',
          content,
          timestamp: Date.now(),
        });
        sent++;
      }
    }
    return sent;
  }

  getResult(agentId: string): unknown {
    const agent = this.agents.get(agentId);
    if (agent?.status === 'completed') return agent.result;
    return undefined;
  }

  getAllResults(): Map<string, unknown> {
    const results = new Map<string, unknown>();
    for (const [id, agent] of this.agents) {
      if (agent.status === 'completed' && agent.result !== undefined) {
        results.set(id, agent.result);
      }
    }
    return results;
  }

  clearCompleted(): number {
    let cleared = 0;
    for (const [id, agent] of this.agents) {
      if (
        agent.status === 'completed' ||
        agent.status === 'failed' ||
        agent.status === 'cancelled'
      ) {
        const age = Date.now() - (agent.completedAt || agent.startedAt);
        if (age > 60 * 60 * 1000) {
          this.agents.delete(id);
          cleared++;
        }
      }
    }
    return cleared;
  }

  formatStatus(): string {
    const status = this.getFleetStatus();
    if (status.totalAgents === 0) return 'No agents in fleet';

    const lines = [
      `Fleet Status: ${status.running} running / ${status.completed} completed / ${status.failed} failed / ${status.cancelled} cancelled`,
      '',
    ];

    for (const agent of status.agents) {
      const elapsed = ((agent.completedAt || Date.now()) - agent.startedAt) / 1000;
      const progressBar = '█'.repeat(Math.floor(agent.progress / 5)) +
        '░'.repeat(20 - Math.floor(agent.progress / 5));

      lines.push(
        `  [${agent.status.toUpperCase().padEnd(9)}] @${agent.agentName} (${agent.id})` +
          `\n    Task: ${agent.task.slice(0, 80)}` +
          `\n    Progress: ${progressBar} ${agent.progress}%` +
          `\n    Elapsed: ${elapsed.toFixed(1)}s` +
          (agent.error ? `\n    Error: ${agent.error}` : '') +
          (agent.messages.length > 0 ? `\n    Messages: ${agent.messages.length}` : ''),
      );
    }

    return lines.join('\n');
  }
}
