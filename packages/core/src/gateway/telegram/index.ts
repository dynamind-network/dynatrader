/**
 * Dyna-Trader Telegram Gateway Package
 *
 * Real Telegram bot gateway that connects to the Telegram Bot API
 * using long polling. Supports approval flows for dangerous operations.
 */

export { TelegramGateway } from "./telegram-gateway";
export type { TelegramMessage, ChatAction, ReplyKeyboardOptions, BotCommand } from "./telegram-gateway";

export { ApprovalManager } from "./approval-manager";
export type {
  ApprovalChoice,
  PendingApproval,
  RiskLevel,
  DangerousPattern,
} from "./approval-manager";
export { DANGEROUS_PATTERNS } from "./approval-manager";

export { CommandRouter, CommandRouter as TelegramCommandRouter } from "./command-router";
export { TELEGRAM_MENU_COMMANDS } from "./command-menu";
export type { CommandHandler, CommandContext } from "./command-router";

export { CallbackRouter } from "./callback-router";
export type { CallbackHandler, CallbackContext, CallbackResult } from "./callback-router";
