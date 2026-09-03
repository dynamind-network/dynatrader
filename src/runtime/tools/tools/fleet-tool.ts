import type { ToolCall, ToolResult, ToolHandler, ToolDefinition } from '@dyna/contracts';
import type { FleetManager } from '../../fleet/fleet-manager.js';

/**
 * FleetTool - Parallel agent orchestration
 *
 * Enables agents to:
 * - Spawn multiple agents working on different tasks concurrently
 * - Track status and progress of fleet agents
 * - Send messages to running agents
 * - Collect results from completed agents
 * - Cancel running agents
 */
export class FleetTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'fleet',
    description: `Parallel agent fleet management. Actions:
- spawn: Spawn a new agent on a task (returns agent ID)
- status: Get status of a specific agent or entire fleet
- cancel: Cancel a running agent
- cancel_all: Cancel all running agents
- send: Send a message to a running agent
- broadcast: Send a message to all running agents
- results: Get results from completed agents
- list: List all fleet agents
- clear: Clear completed agents older than 1 hour`,
    category: 'session',
    inputSchema: {
      action: { type: 'string', enum: ['spawn', 'status', 'cancel', 'cancel_all', 'send', 'broadcast', 'results', 'list', 'clear'] },
      agentId: 'string?',
      task: 'string?',
      agentName: 'string?',
      timeout: 'number?',
      content: 'string?',
      fleetId: 'string?',
    },
    outputSchema: {
      success: 'boolean',
      data: 'any?',
    },
    permissionsRequired: ['session.fleet'],
    sideEffects: ['spawns_agent'],
    riskLevel: 'medium',
    timeoutMs: 30000,
  };

  constructor(private fleetManager: FleetManager) {}

  async execute(call: ToolCall): Promise<ToolResult> {
    const start = Date.now();
    try {
      const action = call.args.action as string;
      const agentId = call.args.agentId as string | undefined;
      const task = call.args.task as string | undefined;
      const agentName = call.args.agentName as string | undefined;
      const timeout = (call.args.timeout as number) || 30 * 60 * 1000;
      const content = call.args.content as string | undefined;
      const fleetId = call.args.fleetId as string | undefined;

      let result: unknown;

      switch (action) {
        case 'spawn': {
          if (!task) throw new Error('spawn requires task');
          const agent = await this.fleetManager.spawnAgent(task, {
            agentName,
            timeout,
          });
          result = { agentId: agent.id, status: agent.status, task: agent.task };
          break;
        }
        case 'status': {
          if (fleetId) {
            const agent = this.fleetManager.getStatus(fleetId);
            if (!agent) throw new Error(`Agent not found: ${fleetId}`);
            result = agent;
          } else {
            result = this.fleetManager.getFleetStatus();
          }
          break;
        }
        case 'cancel': {
          if (!fleetId) throw new Error('cancel requires fleetId (agent ID)');
          const cancelled = this.fleetManager.cancelAgent(fleetId);
          result = { cancelled, agentId: fleetId };
          break;
        }
        case 'cancel_all': {
          const count = this.fleetManager.cancelAll();
          result = { cancelled: count };
          break;
        }
        case 'send': {
          if (!fleetId || !content) throw new Error('send requires fleetId and content');
          const sent = this.fleetManager.sendMessage(fleetId, content);
          result = { sent, agentId: fleetId };
          break;
        }
        case 'broadcast': {
          if (!content) throw new Error('broadcast requires content');
          const count = this.fleetManager.broadcast(content);
          result = { sentTo: count };
          break;
        }
        case 'results': {
          if (fleetId) {
            const r = this.fleetManager.getResult(fleetId);
            result = { agentId: fleetId, result: r };
          } else {
            const all = this.fleetManager.getAllResults();
            result = { results: Object.fromEntries(all), count: all.size };
          }
          break;
        }
        case 'list': {
          const agents = this.fleetManager.listAgents();
          result = { agents, count: agents.length };
          break;
        }
        case 'clear': {
          const cleared = this.fleetManager.clearCompleted();
          result = { cleared };
          break;
        }
        default:
          throw new Error(`Unknown action: ${action}. Use spawn, status, cancel, cancel_all, send, broadcast, results, list, or clear.`);
      }

      return {
        success: true,
        data: result,
        durationMs: Date.now() - start,
        truncated: false,
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message ?? String(err),
        durationMs: Date.now() - start,
        truncated: false,
      };
    }
  }
}
