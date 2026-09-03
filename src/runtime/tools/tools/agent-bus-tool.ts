import type { ToolCall, ToolResult, ToolHandler, ToolDefinition } from '@dyna/contracts';
import type { AgentBus } from '../../../agent/messaging/agent-bus.js';

/**
 * AgentBusTool - Inter-agent messaging via pub/sub and request/response
 *
 * Enables agents to:
 * - Publish messages to topics (broadcast to all subscribers)
 * - Subscribe to topics (receive messages)
 * - Make direct requests to other agents (request/response)
 * - Reply to incoming requests
 * - Query message history
 */
export class AgentBusTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'agent_bus',
    description: `Inter-agent messaging bus. Actions:
- publish: Broadcast a message to all subscribers of a topic
- subscribe: Listen on a topic for messages from other agents
- request: Send a direct request to a specific agent and wait for reply
- reply: Reply to an incoming request
- history: Query recent message history
- subscribers: List agents subscribed to a topic
- pending: List pending requests waiting for replies`,
    category: 'session',
    inputSchema: {
      action: { type: 'string', enum: ['publish', 'subscribe', 'request', 'reply', 'history', 'subscribers', 'pending'] },
      agentId: 'string?',
      topic: 'string?',
      content: 'any?',
      to: 'string?',
      requestId: 'string?',
      timeoutMs: 'number?',
      limit: 'number?',
    },
    outputSchema: {
      success: 'boolean',
      data: 'any?',
    },
    permissionsRequired: ['session.messaging'],
    sideEffects: ['inter_agent_communication'],
    riskLevel: 'low',
    timeoutMs: 10000,
  };

  constructor(private bus: AgentBus) {}

  async execute(call: ToolCall): Promise<ToolResult> {
    const start = Date.now();
    try {
      const action = call.args.action as string;
      const agentId = (call.args.agentId as string) || 'anonymous';
      const topic = call.args.topic as string | undefined;
      const content = call.args.content;
      const to = call.args.to as string | undefined;
      const requestId = call.args.requestId as string | undefined;
      const timeoutMs = (call.args.timeoutMs as number) || 30000;
      const limit = (call.args.limit as number) || 50;

      let result: unknown;

      switch (action) {
        case 'publish': {
          if (!topic) throw new Error('publish requires topic');
          this.bus.publish(agentId, topic, content);
          result = { published: true, topic, messageId: Date.now().toString() };
          break;
        }
        case 'subscribe': {
          if (!topic) throw new Error('subscribe requires topic');
          const unsub = this.bus.subscribe(agentId, topic, (_msg: unknown) => {
            // Store in history for retrieval
          });
          result = { subscribed: true, topic, agentId };
          break;
        }
        case 'request': {
          if (!to || !topic) throw new Error('request requires to and topic');
          const reply = await this.bus.request(agentId, to, topic, content, timeoutMs);
          result = { reply, from: to, topic };
          break;
        }
        case 'reply': {
          if (!requestId) throw new Error('reply requires requestId');
          const replied = this.bus.reply(requestId, agentId, content);
          result = { replied, requestId };
          break;
        }
        case 'history': {
          const messages = this.bus.getHistory(topic, limit);
          result = { messages, count: messages.length };
          break;
        }
        case 'subscribers': {
          if (!topic) throw new Error('subscribers requires topic');
          const subs = this.bus.getSubscribers(topic);
          result = { subscribers: subs, topic };
          break;
        }
        case 'pending': {
          const pending = this.bus.getPendingRequests();
          result = { pending, count: pending.length };
          break;
        }
        default:
          throw new Error(`Unknown action: ${action}. Use publish, subscribe, request, reply, history, subscribers, or pending.`);
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
