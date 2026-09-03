import type { ToolCall, ToolResult, ToolHandler, ToolDefinition } from '@dyna/contracts';
import type { MemoryStore } from '@dyna/contracts';
import type { SessionManager } from '@dyna/channels-core';

export class SessionsHistoryTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'sessions_history',
    description: 'Get session message history with timestamps',
    category: 'session',
    inputSchema: {
      sessionId: 'string',
      limit: 'number?',
      kind: 'string?',
    },
    outputSchema: { messages: 'array', sessionId: 'string' },
    permissionsRequired: ['session.history'],
    sideEffects: [],
    riskLevel: 'low',
    timeoutMs: 5000,
  };

  constructor(
    private sessionManager: SessionManager,
    private memoryStore: MemoryStore,
  ) {}

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

      // Validate session exists
      const session = this.sessionManager.getSession(sessionId);
      if (!session) {
        return {
          success: false,
          error: `Session not found: ${sessionId}`,
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      const limit = (call.args.limit as number | undefined) ?? 50;
      const kind = call.args.kind as string | undefined;

      // Search memory for session messages
      const results = await this.memoryStore.search({
        scope: 'sessions',
        text: sessionId,
        topK: limit,
      });

      // Filter by sessionId in payload and optionally by kind
      const messages = results
        .filter((r) => {
          const payload = r.payload as Record<string, unknown> | undefined;
          if (!payload) return false;
          if (payload.sessionId !== sessionId) return false;
          if (kind && payload.kind !== kind) return false;
          return true;
        })
        .slice(0, limit)
        .map((r) => {
          const payload = r.payload as Record<string, unknown>;
          return {
            id: r.id,
            score: r.score,
            kind: r.id.startsWith('event-') ? 'message' : 'event',
            payload,
          };
        });

      return {
        success: true,
        data: {
          sessionId,
          messages,
          count: messages.length,
          session: {
            userId: session.userId,
            connected: session.state?.connected ?? false,
            blocked: session.state?.blocked ?? false,
            lastActivity: session.lastActivity.toISOString(),
          },
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
