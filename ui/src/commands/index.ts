export { parseSlashCommand } from '../utils/slash-command.js';

export {
  SlashCommandRegistry,
  getCommandRegistry,
  globalCommandRegistry,
  type SlashCommand,
  type CommandContext,
  type CommandCategory,
} from './command-registry.js';

export { registerBuiltinCommands } from './builtin-commands.js';

export interface CommandResult {
  success: boolean;
  message: string;
}

export interface CommandHandler {
  (args: string, projectDir: string): Promise<CommandResult>;
}
