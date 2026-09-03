import type { ToolRegistry } from '../tools/tool-registry.js';
import type { SubagentRegistry } from '../agents/subagent.js';
import type { SkillManager } from '../agents/skill-manager.js';
import type { CommandRegistry as CustomCommandRegistry } from '../agents/command-registry.js';
import type { ToolArtifact, PositionCardArtifact } from '../ui/types.js';

export type CommandCategory = 'system' | 'skill' | 'agent' | 'config' | 'mcp' | 'session';

export interface PositionData {
  symbol: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
  leverage: number;
  liquidationPrice?: number;
}

export interface CommandContext {
  cwd: string;
  toolRegistry?: ToolRegistry;
  subagentRegistry?: SubagentRegistry;
  skillManager?: SkillManager;
  commandRegistry?: CustomCommandRegistry;
  currentModel?: string;
  getPosition?: (symbol: string) => PositionData | undefined;
  onMessage: (message: {
    role: 'system' | 'user' | 'assistant';
    content: string;
    timestamp: Date;
  }) => void;
  onProcessingChange?: (isProcessing: boolean) => void;
  onModelChange?: (model: string) => void;
  onEffortChange?: (effort: string) => void;
  currentEffort?: string;
  getApiKeys?: () => Record<string, string>;
  onNavigate?: (screen: string) => void;
  onClearSession?: () => void;
  onListSessions?: () => Promise<string>;
  onResumeSession?: (sessionId: string) => Promise<{ success: boolean; message: string }>;
  onConnectProvider?: (provider: string) => void;
  onDisconnectProvider?: (provider: string) => Promise<boolean>;
  onAuthChanged?: () => Promise<void>;
  onSubagentsChanged?: () => Promise<void>;
  onQuestionRequired?: (prompt: {
    question: string;
    options: Array<{ label: string; value: string }>;
  }) => Promise<string | null>;
  onStartAgentCreate?: () => void;
  onShowSessionPicker?: () => void;
  onEnterPlanMode?: (goal?: string) => Promise<void>;
  onExitPlanMode?: () => Promise<void>;
  onCompact?: () => Promise<{ success: boolean; message: string }>;
  onListTools?: () => Promise<Array<{ name: string; description: string; category: string }>>;
  onListDelegatedTasks?: () => Promise<
    Array<{ taskId: string; agent: string; task: string; status: string; createdAt: string }>
  >;
  onCancelDelegatedTask?: (taskId: string) => Promise<boolean>;
  onGoalSet?: (objective: string) => void;
  onGoalGet?: () => { objective: string; status: string; progress?: { stepsCompleted: number; totalSteps: number }; tokenBudget?: number; tokensUsed?: number } | null;
  onGoalPause?: () => void;
  onGoalResume?: () => void;
  onGoalComplete?: () => void;
  onGoalClear?: () => void;
  onUndo?: () => Promise<{ success: boolean; message: string }>;
  onRedo?: () => Promise<{ success: boolean; message: string }>;
  onForkSession?: (newTitle?: string) => Promise<{ success: boolean; message: string }>;
  onBtw?: (question: string) => Promise<string>;
  onExportSession?: (format: 'markdown' | 'json') => Promise<{ success: boolean; message: string }>;
  onWatch?: (args: string) => Promise<string>;
}

export type CommandResult = string | { content: string; artifact: ToolArtifact };

export interface SlashCommand {
  name: string;
  description: string;
  category: CommandCategory;
  argumentHint?: string;
  handler: (args: string, context: CommandContext) => Promise<CommandResult>;
  autocomplete?: (query: string) => Promise<string[]>;
}

export class SlashCommandRegistry {
  private commands = new Map<string, SlashCommand>();
  private loadOrder: string[] = [];

  register(command: SlashCommand): void {
    this.commands.set(command.name.toLowerCase(), command);
    if (!this.loadOrder.includes(command.name.toLowerCase())) {
      this.loadOrder.push(command.name.toLowerCase());
    }
  }

  unregister(name: string): boolean {
    this.loadOrder = this.loadOrder.filter((n) => n !== name.toLowerCase());
    return this.commands.delete(name.toLowerCase());
  }

  get(name: string): SlashCommand | undefined {
    return this.commands.get(name.toLowerCase());
  }

  has(name: string): boolean {
    return this.commands.has(name.toLowerCase());
  }

  list(): SlashCommand[] {
    return this.loadOrder
      .map((name) => this.commands.get(name))
      .filter((c): c is SlashCommand => c !== undefined);
  }

  listByCategory(category: CommandCategory): SlashCommand[] {
    return this.list().filter((c) => c.category === category);
  }

  getNames(): string[] {
    return this.loadOrder;
  }

  getDescriptions(): Array<{
    name: string;
    description: string;
    category: string;
    argumentHint?: string;
  }> {
    return this.list().map((c) => ({
      name: c.name,
      description: c.description,
      category: c.category,
      argumentHint: c.argumentHint,
    }));
  }

  async execute(name: string, args: string, context: CommandContext): Promise<CommandResult> {
    const command = this.get(name);
    if (!command) {
      return `Unknown command: /${name}. Type /help for available commands.`;
    }
    try {
      return await command.handler(args, context);
    } catch (error) {
      return `Command /${name} failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async autocomplete(name: string, query: string): Promise<string[]> {
    const command = this.get(name);
    if (command?.autocomplete) {
      return command.autocomplete(query);
    }
    return [];
  }

  clear(): void {
    this.commands.clear();
    this.loadOrder = [];
  }
}

export const globalCommandRegistry = new SlashCommandRegistry();

export function getCommandRegistry(): SlashCommandRegistry {
  return globalCommandRegistry;
}
