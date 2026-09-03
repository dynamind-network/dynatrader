/**
 * Command Router for Telegram bot commands
 *
 * Routes incoming /command messages to registered handlers.
 * Supports aliases, admin-only restrictions, and auto-generated help text.
 */

import { Logger } from "../../audit/logger";

export interface CommandHandler {
  command: string;
  description: string;
  handler: (ctx: CommandContext) => Promise<string>;
  aliases?: string[];
  adminOnly?: boolean;
}

export interface CommandContext {
  chatId: number;
  userId: number;
  username?: string;
  args: string[];
  messageId: number;
  text: string;
}

export class CommandRouter {
  private handlers = new Map<string, CommandHandler>();
  private aliasMap = new Map<string, string>();
  private logger: Logger;

constructor(logger?: Logger) {
    this.logger = logger ?? new Logger("CommandRouter");
  }

  register(handler: CommandHandler): void {
    const cmd = handler.command.toLowerCase();
    this.handlers.set(cmd, handler);

    if (handler.aliases) {
      for (const alias of handler.aliases) {
        this.aliasMap.set(alias.toLowerCase(), cmd);
      }
    }
  }

  unregister(command: string): void {
    const cmd = command.toLowerCase();
    const handler = this.handlers.get(cmd);
    if (handler) {
      if (handler.aliases) {
        for (const alias of handler.aliases) {
          this.aliasMap.delete(alias.toLowerCase());
        }
      }
      this.handlers.delete(cmd);
    }
  }

  async handle(
    chatId: number,
    text: string,
    userId: number,
    username: string | undefined,
    messageId: number,
  ): Promise<string | null> {
    if (!text.startsWith("/")) return null;

    const parts = text.split(/\s+/);
    const commandText = parts[0]!.toLowerCase();
    const args = parts.slice(1);

    const commandName = this.aliasMap.get(commandText.replace("/", "")) ?? commandText.replace("/", "");
    const handler = this.handlers.get(commandName);

    if (!handler) return null;

    if (handler.adminOnly) {
      return "You don't have permission to use this command.";
    }

    const ctx: CommandContext = {
      chatId,
      userId,
      username,
      args,
      messageId,
      text,
    };

    try {
      return await handler.handler(ctx);
    } catch (error) {
      this.logger.error(`Command /${handler.command} failed`, { error });
      return `Error executing /${handler.command}. Please try again later.`;
    }
  }

  getHelpText(): string {
    const lines: string[] = ["Available commands:"];
    for (const [, handler] of this.handlers) {
      const aliases = handler.aliases?.length ? ` (aliases: /${handler.aliases.join(", /")})` : "";
      const admin = handler.adminOnly ? " [admin]" : "";
      lines.push(`  /${handler.command}${aliases}${admin} — ${handler.description}`);
    }
    return lines.join("\n");
  }

  getCommands(): Array<{ command: string; description: string }> {
    const result: Array<{ command: string; description: string }> = [];
    for (const [, handler] of this.handlers) {
      result.push({ command: handler.command, description: handler.description });
    }
    return result;
  }
}