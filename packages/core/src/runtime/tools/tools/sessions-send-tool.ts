import type { ToolCall, ToolResult, ToolHandler, ToolDefinition, ChannelEnvelope } from '@dyna/contracts';
import type { SessionManager } from '@dyna/channels-core';

export class SessionsSendTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'sessions_send',
    description: 'Send a message to a session',
    category: 'session',
    inputSchema: {
      sessionId: 'string',
      text: 'string',
      channel: 'string?',
      senderId: 'string?',
      metadata: 'object?',
    },
    outputSchema: { sessionId: 'string', delivered: 'boolean' },
    permissionsRequired: ['session.send'],
    sideEffects: ['sends_message'],
    riskLevel: 'medium',
    timeoutMs: 10000,
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

      const text = call.args.text as string | undefined;
      if (!text || typeof text !== 'string') {
        return {
          success: false,
          error: 'text must be a non-empty string',
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      // Validate session exists and is active
      const session = this.sessionManager.getSession(sessionId);
      if (!session) {
        return {
          success: false,
          error: `Session not found: ${sessionId}`,
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      if (session.state?.blocked) {
        return {
          success: false,
          error: `Session is blocked: ${session.state?.blockReason ?? 'unknown reason'}`,
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      const channel = (call.args.channel as string | undefined) ?? 'system';
      const senderId = (call.args.senderId as string | undefined) ?? 'tool';
      const metadata = (call.args.metadata as Record<string, unknown> | undefined) ?? {};

      const envelope: ChannelEnvelope = {
        channel,
        senderId,
        sessionId,
        text,
        trusted: true,
        metadata,
      };

      await this.sessionManager.processMessage(sessionId, envelope);

      return {
        success: true,
        data: {
          sessionId,
          delivered: true,
          channel,
          timestamp: new Date().toISOString(),
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
