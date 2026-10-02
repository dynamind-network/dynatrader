import type { BotCommand } from "./telegram-gateway";

/** Commands available before the daemon-specific command set is running. */
export const TELEGRAM_MENU_COMMANDS: BotCommand[] = [
  { command: "start", description: "Start a conversation" },
  { command: "help", description: "Show available commands" },
  { command: "approve", description: "Approve the pending operation" },
  { command: "reject", description: "Reject the pending operation" },
  { command: "status", description: "Show runtime status" },
];
