import type { AgentLoop } from '../core/agent-loop.js';
import type { SubagentRegistry } from '../agents/subagent.js';
import type { SkillManager } from '../agents/skill-manager.js';
import type { CommandRegistry } from '../agents/command-registry.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { ExecutionMode, QuestionPrompt } from '../index.js';
import { parseSlashCommand } from '../utils/slash-command.js';
import { getCommandRegistry, registerBuiltinCommands } from '../commands/index.js';
import type { CommandContext, CommandResult } from '../commands/command-registry.js';
import type { ToolArtifact } from '../ui/types.js';
import { Auth } from '../auth/index.js';

interface CommandMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: Date;
  status?: 'pending' | 'completed' | 'error';
  toolName?: string;
  runId?: string;
  preview?: string;
  commandOutput?: boolean;
  toolArtifact?: ToolArtifact;
}

interface CommandServiceOptions {
  agentLoop?: AgentLoop;
  subagentRegistry?: SubagentRegistry;
  skillManager?: SkillManager;
  commandRegistry?: CommandRegistry;
  toolRegistry?: ToolRegistry;
  cwd: string;
  getConversationId: () => string;
  getPosition?: (symbol: string) =>
    | {
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
    | undefined;
  onMessage: (message: CommandMessage) => void;
  onProcessingChange: (isProcessing: boolean) => void;
  onToolChange: (tool: string | null) => void;
  onModelChange: (model: string) => void;
  onEffortChange?: (effort: string) => void;
  getApiKeys?: () => Record<string, string>;
  onActiveToolsChange: (tools: string[]) => void;
  onNavigate: (screen: string) => void;
  onConnectProvider: (provider: string) => void;
  onClearSession: () => void;
  onListSessions: () => Promise<string>;
  onResumeSession: (sessionId: string) => Promise<{ success: boolean; message: string }>;
  onQuestionRequired: (prompt: {
    question: string;
    options: Array<{ label: string; value: string }>;
  }) => Promise<string | null>;
  onStartAgentCreate: () => void;
  onAuthChanged: () => Promise<void>;
  onSubagentsChanged: () => Promise<void>;
  onShowSessionPicker: () => void;
  currentModel: string | null;
  currentEffort?: string;
}

export class CommandService {
  private options: CommandServiceOptions;
  private currentModel: string | null;
  private initialized = false;

  constructor(options: CommandServiceOptions) {
    this.options = options;
    this.currentModel = options.currentModel;
  }

  private ensureInitialized(): void {
    if (this.initialized) return;
    registerBuiltinCommands();
    this.initialized = true;
  }

  async executeCommand(text: string): Promise<void> {
    this.ensureInitialized();

    const trimmed = text.trim();
    if (!trimmed) return;

    if (trimmed.startsWith('@')) {
      await this.handleAgentMention(trimmed);
      return;
    }

    if (trimmed.startsWith('/')) {
      const parsed = parseSlashCommand(trimmed);

      if (!parsed) {
        this.options.onMessage({
          role: 'system',
          content: 'Invalid command format',
          timestamp: new Date(),
        });
        return;
      }

      const registry = getCommandRegistry();
      const command = registry.get(parsed.command);

      if (!command) {
        this.options.onMessage({
          role: 'system',
          content: `Unknown command: /${parsed.command}. Type /help for available commands.`,
          timestamp: new Date(),
        });
        return;
      }

      const context: CommandContext = {
        cwd: this.options.cwd,
        toolRegistry: this.options.toolRegistry,
        subagentRegistry: this.options.subagentRegistry,
        skillManager: this.options.skillManager,
        commandRegistry: this.options.commandRegistry,
        currentModel: this.currentModel ?? undefined,
        currentEffort: this.options.currentEffort,
        getApiKeys: this.options.getApiKeys,
        getPosition: this.options.getPosition,
        onMessage: this.options.onMessage,
        onProcessingChange: this.options.onProcessingChange,
        onModelChange: (model: string) => {
          this.currentModel = model;
          this.options.onModelChange(model);
        },
        onEffortChange: this.options.onEffortChange,
        onNavigate: this.options.onNavigate,
        onClearSession: this.options.onClearSession,
        onListSessions: this.options.onListSessions,
        onResumeSession: this.options.onResumeSession,
        onConnectProvider: this.options.onConnectProvider,
        onDisconnectProvider: async (provider: string) => {
          const existing = await Auth.get(provider);
          if (!existing) return false;
          await Auth.remove(provider);
          await this.options.onAuthChanged();
          return true;
        },
        onAuthChanged: this.options.onAuthChanged,
        onSubagentsChanged: this.options.onSubagentsChanged,
        onQuestionRequired: this.options.onQuestionRequired,
        onStartAgentCreate: this.options.onStartAgentCreate,
        onShowSessionPicker: this.options.onShowSessionPicker,
        onEnterPlanMode: async (goal?: string) => {
          await this.options.agentLoop?.setPlanningMode(true, goal);
        },
        onExitPlanMode: async () => {
          await this.options.agentLoop?.setPlanningMode(false);
        },
        onCompact: async () =>
          this.options.agentLoop?.compact() ?? {
            success: false,
            message: 'Session compaction is unavailable.',
          },
        onListTools: async () => this.options.agentLoop?.listAvailableTools() ?? [],
        onListDelegatedTasks: async () => this.options.agentLoop?.listDelegatedTasks() ?? [],
        onCancelDelegatedTask: async (taskId: string) =>
          this.options.agentLoop?.cancelDelegatedTask(taskId) ?? false,
        onGoalSet: (objective: string) => {
          this.options.onMessage({
            role: 'system',
            content: `Goal set: "${objective}"`,
            timestamp: new Date(),
            commandOutput: true,
          });
        },
        onGoalGet: () => null,
        onGoalPause: () => {},
        onGoalResume: () => {},
        onGoalComplete: () => {},
        onGoalClear: () => {},
        onUndo: async () => {
          const { getUndoRedoManager } = await import('../core/undo-redo.js');
          const manager = getUndoRedoManager();
          return manager.undo(this.options.cwd, this.options.getConversationId());
        },
        onRedo: async () => {
          const { getUndoRedoManager } = await import('../core/undo-redo.js');
          const manager = getUndoRedoManager();
          return manager.redo(this.options.cwd, this.options.getConversationId());
        },
        onForkSession: async (newTitle?: string) => {
          const { forkSession } = await import('../core/session-fork.js');
          const sessionsDir = require('path').join(
            require('../utils/constants.js').getDynamindPath('sessions')
          );
          return forkSession(sessionsDir, this.options.getConversationId(), newTitle);
        },
        onBtw: async (question: string) => {
          if (!this.options.agentLoop) return 'Agent not available for side questions.';
          const result = await this.options.agentLoop.run(
            question,
            { conversationId: `btw-${this.options.getConversationId()}`, workingDirectory: this.options.cwd, isSubagent: false }
          );
          return result;
        },
        onExportSession: async (format: 'markdown' | 'json') => {
          const { exportSession } = await import('../core/session-export.js');
          const messages = this.options.agentLoop?.getConversation() ?? [];
          return exportSession(
            messages as any,
            this.options.getConversationId(),
            'Exported Session',
            format,
            this.options.cwd
          );
        },
        onWatch: async (args: string) => {
          const { startWatcher, stopWatcher, listWatchers, stopAllWatchers } = await import('../core/watch-manager.js');
          const parts = args.split(/\s+/);
          const action = parts[0]?.toLowerCase();

          if (action === 'list') {
            const watchers = listWatchers(this.options.cwd);
            if (watchers.length === 0) return 'No active watchers.';
            return watchers.map((w) => `${w.id} [${w.active ? 'active' : 'stopped'}] ${w.command}`).join('\n');
          }

          if (action === 'stop') {
            const id = parts[1];
            if (!id) return 'Usage: /watch stop <id>';
            return stopWatcher(this.options.cwd, id) ? `Stopped watcher ${id}` : `Watcher ${id} not found`;
          }

          if (action === 'clear') {
            stopAllWatchers(this.options.cwd);
            return 'All watchers stopped.';
          }

          // Start a new watcher: /watch <command>
          if (!args.trim()) return 'Usage: /watch <command>';
          const watcher = startWatcher(this.options.cwd, '**/*', args.trim());
          return `Started watcher ${watcher.id}: ${watcher.command}`;
        },
      };

      try {
        const result: CommandResult = await registry.execute(parsed.command, parsed.args, context);
        if (typeof result === 'string') {
          this.options.onMessage({
            role: 'system',
            content: result,
            timestamp: new Date(),
            commandOutput: true,
          });
        } else {
          this.options.onMessage({
            role: 'system',
            content: result.content,
            timestamp: new Date(),
            commandOutput: true,
            toolArtifact: result.artifact,
          });
        }
      } catch (error) {
        this.options.onMessage({
          role: 'system',
          content: `Command failed: ${error instanceof Error ? error.message : String(error)}`,
          timestamp: new Date(),
          commandOutput: true,
        });
      }
      return;
    }

    if (this.options.agentLoop) {
      this.options.onProcessingChange(true);

      try {
        const context = {
          workingDirectory: this.options.cwd,
          conversationId: this.options.getConversationId(),
          isSubagent: false,
          askQuestion: async (prompt: QuestionPrompt) => {
            return await this.options.onQuestionRequired({
              question: prompt.question,
              options: prompt.options,
            });
          },
        };

        await this.options.agentLoop.run(trimmed, context);
      } catch (error) {
        this.options.onMessage({
          role: 'system',
          content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          timestamp: new Date(),
        });
      }

      this.options.onProcessingChange(false);
    } else {
      this.options.onMessage({
        role: 'system',
        content: 'Agent not initialized. Please configure API keys.',
        timestamp: new Date(),
      });
    }
  }

  async createCustomAgent(
    data: Record<string, unknown>
  ): Promise<{ success: boolean; message: string }> {
    if (!this.options.subagentRegistry) {
      return { success: false, message: 'Agent registry not available.' };
    }

    const name = typeof data.name === 'string' ? data.name.trim() : '';
    const description = typeof data.description === 'string' ? data.description.trim() : '';
    const scope = data.scope === 'global' ? 'global' : 'project';
    const visible = data.visible !== false;
    const maxTurns = typeof data.maxTurns === 'number' ? data.maxTurns : Number(data.maxTurns);
    const tools = Array.isArray(data.tools)
      ? data.tools.filter((tool): tool is string => typeof tool === 'string')
      : [];

    if (!name) {
      return { success: false, message: 'Agent name is required.' };
    }

    if (!Number.isFinite(maxTurns) || maxTurns <= 0) {
      return { success: false, message: 'Agent max turns must be a positive number.' };
    }

    const loader = this.options.subagentRegistry.getAgentLoader();
    const body = [
      `You are ${name}.`,
      description ? `` : '',
      description ? description : '',
      '',
      'Follow the workspace instructions and act only within your assigned role.',
    ]
      .filter(Boolean)
      .join('\n');

    const filePath = await loader.createAgent(
      name,
      {
        name,
        description,
        enabled: true,
        hidden: !visible,
        mode: { subagent: true, skill: false, command: false },
        agent: { model: '', maxTurns, canSpawnSubagents: false },
        tools,
      },
      body,
      scope
    );

    if (!filePath) {
      return { success: false, message: 'Failed to create agent file.' };
    }

    await this.options.onSubagentsChanged?.();

    return {
      success: true,
      message: `Created ${scope} agent "${name}" at ${filePath}.`,
    };
  }

  private async handleAgentMention(text: string): Promise<void> {
    const match = text.match(/^@(\S+)\s*(.*)$/);
    if (!match) return;

    const [, agentName, task] = match;

    if (!this.options.subagentRegistry) {
      this.options.onMessage({
        role: 'system',
        content: 'Agent registry not available.',
        timestamp: new Date(),
        commandOutput: true,
      });
      return;
    }

    const agent = this.options.subagentRegistry.get(agentName);
    if (!agent) {
      const visibleAgents = this.options.subagentRegistry.getVisible();
      this.options.onMessage({
        role: 'system',
        content: `Unknown agent: ${agentName}. Available: ${visibleAgents.map((a) => a.name).join(', ') || 'none'}`,
        timestamp: new Date(),
      });
      return;
    }

    if (!task || task.trim().length === 0) {
      this.options.onMessage({
        role: 'system',
        content: `@${agentName} - ${agent.description || 'No description'}\n\nUsage: @${agentName} <task>`,
        timestamp: new Date(),
      });
      return;
    }

    this.options.onMessage({
      role: 'system',
      content: `Dispatching to @${agentName}...`,
      timestamp: new Date(),
    });

    this.options.onProcessingChange?.(true);

    try {
      if (this.options.agentLoop) {
        const subtaskMode = task.includes('--async') || task.includes('--background');
        const cleanTask = task.replace(/--async|--background/g, '').trim();

        this.options.onMessage({
          role: 'system',
          content: `@${agentName}${subtaskMode ? ' [background]' : ''}:\n\n${cleanTask}`,
          timestamp: new Date(),
        });

        if (subtaskMode) {
          this.options.onMessage({
            role: 'system',
            content: `@${agentName} started in the DynaTrader runtime.`,
            timestamp: new Date(),
          });
          const taskId = await this.options.agentLoop.startDelegatedTask(agentName, cleanTask, {
            workingDirectory: this.options.cwd,
            conversationId: this.options.getConversationId(),
          });
          this.options.onMessage({
            role: 'system',
            content: `@${agentName} is running as ${taskId}. Completion will be announced here.`,
            timestamp: new Date(),
          });
        } else {
          const result = await this.options.agentLoop.delegateTask(agentName, cleanTask, {
            workingDirectory: this.options.cwd,
            conversationId: this.options.getConversationId(),
          });

          this.options.onMessage({
            role: 'system',
            content: `@${agentName} completed:\n\n${typeof result === 'string' ? result : JSON.stringify(result, null, 2)}`,
            timestamp: new Date(),
          });
        }
      } else {
        this.options.onMessage({
          role: 'system',
          content: `@${agentName} result: Agent not initialized.`,
          timestamp: new Date(),
        });
      }
    } catch (error) {
      this.options.onMessage({
        role: 'system',
        content: `@${agentName} failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        timestamp: new Date(),
      });
    }

    this.options.onProcessingChange?.(false);
  }

  async submitApiKey(provider: string, key: string): Promise<void> {
    try {
      const { Auth } = await import('../auth/index.js');
      await Auth.set(provider, { type: 'api', key });

      this.options.onMessage({
        role: 'system',
        content: `Connected to ${provider}. API key saved successfully.`,
        timestamp: new Date(),
      });

      await this.options.onAuthChanged();
    } catch (error) {
      this.options.onMessage({
        role: 'system',
        content: `Failed to connect to ${provider}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        timestamp: new Date(),
      });
    }
  }
}
