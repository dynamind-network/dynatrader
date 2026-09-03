/**
 * Callback Router for Telegram inline keyboard callback queries
 *
 * Routes incoming callback_query data to registered handlers
 * based on prefix matching. Supports payload extraction.
 */

import { Logger } from "../../audit/logger";

export interface CallbackHandler {
  prefix: string;
  handler: (ctx: CallbackContext) => Promise<CallbackResult>;
  description: string;
}

export interface CallbackContext {
  callbackQueryId: string;
  chatId: number;
  messageId: number;
  userId: number;
  data: string;
  payload: string;
}

export interface CallbackResult {
  text?: string;
  editMessage?: string;
  showAlert?: boolean;
}

export class CallbackRouter {
  private handlers: CallbackHandler[] = [];
  private logger: Logger;

  constructor(logger?: Logger) {
    this.logger = logger ?? new Logger("CallbackRouter");
  }

  register(handler: CallbackHandler): void {
    this.handlers.push(handler);
  }

  unregister(prefix: string): void {
    this.handlers = this.handlers.filter((h) => h.prefix !== prefix);
  }

  async handle(ctx: CallbackContext): Promise<CallbackResult | null> {
    for (const handler of this.handlers) {
      if (ctx.data.startsWith(handler.prefix)) {
        const payload = ctx.data.slice(handler.prefix.length);
        const handlerCtx: CallbackContext = { ...ctx, payload };
        try {
          return await handler.handler(handlerCtx);
        } catch (error) {
          this.logger.error(`Callback handler "${handler.prefix}" failed`, { error });
          return null;
        }
      }
    }
    return null;
  }
}