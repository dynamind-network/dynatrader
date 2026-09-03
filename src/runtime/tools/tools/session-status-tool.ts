import type { ToolCall, ToolResult, ToolHandler, ToolDefinition } from '@dyna/contracts';
import type { SessionManager } from '@dyna/channels-core';

export class SessionStatusTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'session_status',
    description: 'Get the status of a specific session',
    category: 'session',
    inputSchema: { sessionId: 'string' },
    outputSchema: { session: 'object' },
    permissionsRequired: ['session.status'],
    sideEffects: [],
    riskLevel: 'low',
    timeoutMs: 5000,
  };

  constructor(private sessionManager: SessionManager) {}

  async execute(call: ToolCall): Promise<ToolResult> {
    const start = Date.now();
    try {
      const sessionId = call.args.sessionId as string | undefined;
      if (!sessionId || typeof sessionId !== 'string') {
        return {
          success: false,
          error: 'sessionId must be a non-empty string',
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      const session = this.sessionManager.getSession(sessionId);
      if (!session) {
        return {
          success: false,
          error: `Session not found: ${sessionId}`,
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      return {
        success: true,
        data: {
          id: session.id,
          userId: session.userId,
          accountId: session.accountId,
          status: session.state?.blocked ? 'blocked' : session.state?.connected ? 'active' : 'inactive',
          connected: session.state?.connected ?? false,
          blocked: session.state?.blocked ?? false,
          blockReason: session.state?.blockReason ?? null,
          messageCount: session.state?.messageCount ?? 0,
          errorCount: session.state?.errorCount ?? 0,
          lastActivity: session.lastActivity.toISOString(),
          createdAt: session.createdAt.toISOString(),
          expiresAt: session.expiresAt.toISOString(),
          riskLevel: session.metadata?.riskLevel ?? 'medium',
          deviceType: session.metadata.deviceType ?? null,
          pairedChannel: session.pairing?.channelId ?? null,
          pairedAt: session.pairing?.pairedAt.toISOString() ?? null,
        },
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
