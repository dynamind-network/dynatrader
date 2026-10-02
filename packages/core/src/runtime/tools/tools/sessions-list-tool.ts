import type { ToolCall, ToolResult, ToolHandler, ToolDefinition } from '@dyna/contracts';
import type { SessionManager, Session } from '@dyna/channels-core';

export class SessionsListTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'sessions_list',
    description: 'List all active agent sessions',
    category: 'session',
    inputSchema: { filter: { type: 'string', enum: ['all', 'active', 'blocked'], optional: true } },
    outputSchema: { sessions: 'array' },
    permissionsRequired: ['session.list'],
    sideEffects: [],
    riskLevel: 'low',
    timeoutMs: 5000,
  };

  constructor(private sessionManager: SessionManager) {}

  async execute(call: ToolCall): Promise<ToolResult> {
    const start = Date.now();
    try {
      const filter = (call.args.filter as string | undefined) ?? 'all';

      let sessions: Session[];
      switch (filter) {
        case 'active':
          sessions = this.sessionManager.getActiveSessions();
          break;
        case 'blocked':
          sessions = this.sessionManager.getAllSessions().filter((s) => s.state?.blocked);
          break;
        case 'all':
        default:
          sessions = this.sessionManager.getAllSessions();
          break;
      }

      const serialized = sessions.map((s) => ({
        id: s.id,
        userId: s.userId,
        accountId: s.accountId,
        status: s.state?.blocked ? 'blocked' : s.state?.connected ? 'active' : 'inactive',
        connected: s.state?.connected ?? false,
        blocked: s.state?.blocked ?? false,
        blockReason: s.state?.blockReason ?? null,
        messageCount: s.state?.messageCount ?? 0,
        errorCount: s.state?.errorCount ?? 0,
        createdAt: s.createdAt.toISOString(),
        lastActivity: s.lastActivity.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
        riskLevel: s.metadata?.riskLevel ?? 'medium',
        channels: s.pairing?.channelId ?? null,
      }));

      return {
        success: true,
        data: { sessions: serialized, count: serialized.length, filter },
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
