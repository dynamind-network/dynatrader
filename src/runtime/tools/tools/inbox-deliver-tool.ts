import type { ToolCall, ToolResult, ToolHandler, ToolDefinition } from '@dyna/contracts';
import { Inbox } from '../../../inbox/inbox';

export interface InboxDeliverToolConfig {
  workspacePath: string;
  onDelivered?: (entry: { id: string; title: string; source?: string }) => Promise<void> | void;
}

export class InboxDeliverTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'inbox_deliver',
    description: 'Deliver a report or job result to the operator inbox and notify configured channels',
    category: 'session',
    inputSchema: { title: 'string', body: 'string', source: 'string?', metadata: 'object?' },
    outputSchema: { id: 'string', path: 'string', status: 'string' },
    permissionsRequired: ['inbox.write'],
    sideEffects: ['filesystem_write', 'notification'],
    riskLevel: 'low',
    timeoutMs: 10000,
  };

  private readonly inbox: Inbox;
  private readonly onDelivered?: InboxDeliverToolConfig['onDelivered'];

  constructor(config: InboxDeliverToolConfig) {
    this.inbox = new Inbox(config.workspacePath);
    this.onDelivered = config.onDelivered;
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const startedAt = Date.now();
    try {
      const title = call.args.title;
      const body = call.args.body;
      if (typeof title !== 'string' || !title.trim()) throw new Error('title is required');
      if (typeof body !== 'string') throw new Error('body is required');
      const entry = await this.inbox.deliver({
        title,
        body,
        source: typeof call.args.source === 'string' ? call.args.source : undefined,
        metadata: isRecord(call.args.metadata) ? call.args.metadata : undefined,
      });
      await this.onDelivered?.({ id: entry.id, title: entry.title, source: entry.source });
      return { success: true, data: { id: entry.id, path: entry.path, status: entry.status }, durationMs: Date.now() - startedAt, truncated: false };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt, truncated: false };
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
