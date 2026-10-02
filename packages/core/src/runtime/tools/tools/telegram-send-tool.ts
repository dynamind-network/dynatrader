import type { ToolCall, ToolResult, ToolHandler, ToolDefinition } from '@dyna/contracts';
import { sendGatewayMessage } from '../../../gateway/runtime-gateway';
import type { WorkspaceManifest } from '../../../orchestration/workspace/types';

export interface TelegramSendToolConfig {
  workspaceConfig?: WorkspaceManifest['config'] | null;
}

export class TelegramSendTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'telegram_send',
    description: 'Send a Telegram message to the configured operator chat or an explicit chat ID',
    category: 'session',
    inputSchema: {
      message: 'string',
      chatId: 'string?',
    },
    outputSchema: {
      deliveredTo: 'string',
      status: 'string',
    },
    permissionsRequired: ['gateway.telegram.send'],
    sideEffects: ['notification', 'network_access'],
    riskLevel: 'medium',
    timeoutMs: 15000,
  };

  constructor(private readonly config: TelegramSendToolConfig = {}) {}

  async execute(call: ToolCall): Promise<ToolResult> {
    const startedAt = Date.now();
    try {
      const message = call.args.message;
      if (typeof message !== 'string' || !message.trim()) {
        return {
          success: false,
          error: 'message must be a non-empty string',
          durationMs: Date.now() - startedAt,
          truncated: false,
        };
      }

      const chatId = typeof call.args.chatId === 'string' ? call.args.chatId.trim() : '';
      const target = chatId ? `telegram:${chatId}` : 'telegram';

      const deliveredTo = await sendGatewayMessage(
        { target, message: message.trim() },
        this.config.workspaceConfig ?? undefined,
      );

      return {
        success: true,
        data: {
          deliveredTo,
          status: 'sent',
        },
        durationMs: Date.now() - startedAt,
        truncated: false,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
        truncated: false,
      };
    }
  }
}
