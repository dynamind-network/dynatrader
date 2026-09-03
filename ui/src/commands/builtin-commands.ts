import type { SlashCommand, CommandContext } from './command-registry.js';
import { getCommandRegistry } from './command-registry.js';
import {
  listWorkspaceStrategyTemplatesSync,
  resolveWorkspaceBacktestEngine,
} from '../tools/strategy-catalog.js';
import {
  findProviderForModel,
  getModelDisplayName,
  parseEffortLevel,
  EFFORT_LEVELS,
  resolveModelQuery,
  formatProviderStatus,
  isKnownProvider,
  listProviderNames,
  reloadProviders,
} from '../core/providers.js';

export function registerBuiltinCommands(): void {
  const registry = getCommandRegistry();

  registry.register(createHelpCommand());
  registry.register(createClearCommand());
  registry.register(createResumeCommand());
  registry.register(createModelCommand());
  registry.register(createModelsCommand());
  registry.register(createEffortCommand());
  registry.register(createModeCommand());
  registry.register(createAgentsCommand());
  registry.register(createToolsCommand());
  registry.register(createTasksCommand());
  registry.register(createMcpCommand());
  registry.register(createCompactCommand());
  registry.register(createConnectCommand());
  registry.register(createDisconnectCommand());
  registry.register(createExitCommand());
  registry.register(createSkillCommand());
  registry.register(createStrategiesCommand());
  registry.register(createPositionCommand());
  registry.register(createPlanCommand());
  registry.register(createGoalCommand());
  registry.register(createExitPlanCommand());
  registry.register(createReloadCommand());
  registry.register(createUndoCommand());
  registry.register(createRedoCommand());
  registry.register(createForkCommand());
  registry.register(createBtwCommand());
  registry.register(createExportCommand());
  registry.register(createWatchCommand());
}

function createPlanCommand(): SlashCommand {
  return {
    name: 'plan',
    description: 'Enter read-only planning mode',
    category: 'agent',
    argumentHint: '[goal]',
    handler: async (args, context) => {
      if (!context.onEnterPlanMode) return 'Planning mode is unavailable.';
      await context.onEnterPlanMode(args.trim() || undefined);
      return `Planning mode enabled.${args.trim() ? ` Goal: ${args.trim()}` : ''} The agent may inspect files but cannot modify them.`;
    },
  };
}

function createExitPlanCommand(): SlashCommand {
  return {
    name: 'exit-plan',
    description: 'Finish planning and request approval',
    category: 'agent',
    handler: async (_args, context) => {
      if (!context.onExitPlanMode) return 'Planning mode is unavailable.';
      await context.onExitPlanMode();
      return 'Plan submitted for approval.';
    },
  };
}

function createGoalCommand(): SlashCommand {
  return {
    name: 'goal',
    description: 'Set or manage a persistent goal',
    category: 'agent',
    argumentHint: '[set <objective>|status|pause|resume|complete|clear]',
    handler: async (args, context) => {
      const parts = args.trim().split(/\s+/);
      const action = parts[0]?.toLowerCase() || 'status';

      if (action === 'set' && parts.length > 1) {
        const objective = parts.slice(1).join(' ');
        context.onGoalSet?.(objective);
        return `Goal set: "${objective}"`;
      }

      if (action === 'pause') {
        context.onGoalPause?.();
        return 'Goal paused.';
      }

      if (action === 'resume') {
        context.onGoalResume?.();
        return 'Goal resumed.';
      }

      if (action === 'complete') {
        context.onGoalComplete?.();
        return 'Goal marked as complete.';
      }

      if (action === 'clear') {
        context.onGoalClear?.();
        return 'Goal cleared.';
      }

      const goal = context.onGoalGet?.();
      if (!goal) return 'No active goal. Use /goal set <objective> to create one.';

      return `Active goal: "${goal.objective}"
Status: ${goal.status}
Progress: ${goal.progress?.stepsCompleted ?? 0}/${goal.progress?.totalSteps ?? 0} steps
${goal.tokenBudget ? `Budget: ${goal.tokensUsed ?? 0}/${goal.tokenBudget} tokens` : ''}`;
    },
  };
}

function createHelpCommand(): SlashCommand {
  return {
    name: 'help',
    description: 'Show help and available commands',
    category: 'system',
    handler: async (_args, context) => {
      const registry = getCommandRegistry();
      const commands = registry.getDescriptions();

      const byCategory: Record<string, typeof commands> = {};
      for (const cmd of commands) {
        if (!byCategory[cmd.category]) {
          byCategory[cmd.category] = [];
        }
        byCategory[cmd.category].push(cmd);
      }

      const lines = ['Available Commands:', ''];

      const categoryLabels: Record<string, string> = {
        system: 'System',
        session: 'Session',
        config: 'Configuration',
        skill: 'Skills',
        agent: 'Agents',
        mcp: 'MCP Servers',
      };

      for (const [category, cmds] of Object.entries(byCategory)) {
        const label = categoryLabels[category] || category;
        lines.push(`${label}:`);
        for (const cmd of cmds.sort((a, b) => a.name.localeCompare(b.name))) {
          const hint = cmd.argumentHint ? ` ${cmd.argumentHint}` : '';
          const desc =
            cmd.description.length > 40 ? cmd.description.slice(0, 37) + '...' : cmd.description;
          lines.push(`  /${cmd.name.padEnd(10)} ${desc}${hint}`);
        }
        lines.push('');
      }

      lines.push('Usage:');
      lines.push('  Type a message to chat with the AI');
      lines.push('  @name task        - Dispatch to a configured workspace agent');
      lines.push('  /plan             - Enter read-only planning mode');
      lines.push('  /exit-plan        - Submit the current plan for approval');

      return lines.join('\n');
    },
  };
}

function createClearCommand(): SlashCommand {
  return {
    name: 'clear',
    description: 'Clear current session and start fresh',
    category: 'session',
    handler: async (_args, context) => {
      context.onClearSession?.();
      return 'Session cleared.';
    },
  };
}

function createResumeCommand(): SlashCommand {
  return {
    name: 'resume',
    description: 'Resume a previous session',
    category: 'session',
    argumentHint: '[session-id]',
    handler: async (args, context) => {
      if (args) {
        const result = await context.onResumeSession?.(args);
        return result?.message ?? 'Resume not available';
      }
      context.onNavigate?.('sessions');
      return '';
    },
  };
}

function createModelCommand(): SlashCommand {
  return {
    name: 'model',
    description: 'Switch AI model by id',
    category: 'config',
    argumentHint: '[set <model-id>|show|list|effort <level>]',
    handler: async (args, context) => {
      if (!args || !args.trim()) {
        context.onNavigate?.('models');
        return '';
      }

      const trimmed = args.trim();
      const parts = trimmed.split(/\s+/);
      const apiKeys = context.getApiKeys?.() ?? {};

      if (parts[0] === 'list') {
        context.onNavigate?.('models');
        return '';
      }

      if (parts[0] === 'show') {
        const model = context.currentModel ?? 'not set';
        const provider = model !== 'not set' ? findProviderForModel(model) : null;
        const name = model !== 'not set' ? getModelDisplayName(model) : model;
        const effort = context.currentEffort ?? 'none';
        return [
          `Model: ${name}`,
          `  id:       ${model}`,
          `  provider: ${provider ?? 'unknown'}`,
          `  effort:   ${effort}`,
        ].join('\n');
      }

      if (parts[0] === 'effort') {
        if (!parts[1]) {
          return `Current effort: ${context.currentEffort ?? 'none'}\nValid: ${EFFORT_LEVELS.join(', ')}`;
        }
        const level = parseEffortLevel(parts[1]);
        if (!level) {
          return `Unknown effort "${parts[1]}". Valid: ${EFFORT_LEVELS.join(', ')}`;
        }
        context.onEffortChange?.(level);
        return `-> Effort set to: ${level}`;
      }

      const query = parts[0] === 'set' && parts[1] ? parts.slice(1).join(' ') : trimmed;

      const resolved = resolveModelQuery(query, apiKeys);
      if (!resolved.ok) {
        const hint =
          resolved.suggestions.length > 0
            ? `\nSuggestions:\n${resolved.suggestions.map((s) => `  ${s}`).join('\n')}`
            : '';
        return `${resolved.error}${hint}`;
      }

      context.onModelChange?.(resolved.model.id);
      const keyNote = resolved.model.hasKey
        ? ''
        : `\nWarning: ${resolved.model.providerName} has no API key. Run /connect ${resolved.model.provider}`;
      return `-> Model set to: ${resolved.model.id} (${resolved.model.name})${keyNote}`;
    },
  };
}

function createEffortCommand(): SlashCommand {
  return {
    name: 'effort',
    description: 'Set reasoning effort level',
    category: 'config',
    argumentHint: '[none|low|medium|high|max]',
    handler: async (args, context) => {
      if (!args || !args.trim()) {
        return `Current effort: ${context.currentEffort ?? 'none'}\nValid: ${EFFORT_LEVELS.join(', ')}\nUsage: /effort <level>`;
      }
      const level = parseEffortLevel(args.trim());
      if (!level) {
        return `Unknown effort "${args.trim()}". Valid: ${EFFORT_LEVELS.join(', ')}`;
      }
      context.onEffortChange?.(level);
      return `-> Effort set to: ${level}`;
    },
  };
}

function createModelsCommand(): SlashCommand {
  return {
    name: 'models',
    description: 'Browse available AI models',
    category: 'config',
    handler: async (_args, context) => {
      context.onNavigate?.('models');
      return '';
    },
  };
}

function createModeCommand(): SlashCommand {
  return {
    name: 'mode',
    description: 'Set execution mode',
    category: 'config',
    argumentHint: '[normal|auto-approve]',
    handler: async (args, _context) => {
      if (args === 'auto' || args === 'auto-approve') {
        return 'Execution mode: auto-approve';
      }
      return 'Execution mode: normal';
    },
  };
}

function createAgentsCommand(): SlashCommand {
  return {
    name: 'agents',
    description: 'List available workspace agents',
    category: 'agent',
    argumentHint: '[list|create|path]',
    handler: async (args, context) => {
      const action = args.trim().toLowerCase();

      if (action === 'create') {
        context.onStartAgentCreate?.();
        return 'Creating a markdown workspace agent. Follow the prompts to finish setup.';
      }

      if (action === 'path') {
        const paths = context.subagentRegistry?.getAgentLoader().getPaths();
        if (!paths) return 'Agent registry not available';
        return `Workspace agent paths:\n- project: ${paths.project ?? 'not configured'}\n- global: ${paths.global ?? 'not configured'}`;
      }

      if (context.subagentRegistry) {
        const agents = context.subagentRegistry.getVisible();
        if (agents.length > 0) {
          return `Available agents:\n${agents
            .map((a) => `  @${a.name} - ${a.description || 'No description'}`)
            .join('\n')}`;
        }
        return 'No workspace agents are configured yet. Use /agents create to add one.';
      }
      return 'Agent registry not available';
    },
  };
}

function createToolsCommand(): SlashCommand {
  return {
    name: 'tools',
    description: 'List available tools',
    category: 'system',
    handler: async (_args, context) => {
      if (context.onListTools) {
        const tools = await context.onListTools();
        if (tools.length === 0) return 'No runtime tools are available for this session.';
        return `Available runtime tools (${tools.length}):\n${tools
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(
            (tool) =>
              `  - ${tool.name} [${tool.category}]${tool.description ? ` — ${tool.description}` : ''}`
          )
          .join('\n')}`;
      }
      if (context.toolRegistry) {
        const tools = context.toolRegistry.getToolNames();
        const stats = context.toolRegistry.getStats();
        return `Available runtime tools (${stats.total} total, ${stats.builtin} builtin, ${stats.mcp} MCP):\n${tools
          .sort()
          .map((t) => `  - ${t}`)
          .join('\n')}`;
      }
      return 'Tool registry not available';
    },
  };
}

function createTasksCommand(): SlashCommand {
  return {
    name: 'tasks',
    description: 'List or cancel delegated tasks',
    category: 'agent',
    argumentHint: '[cancel <task-id>]',
    handler: async (args, context) => {
      const [action, taskId] = args.trim().split(/\s+/, 2);
      if (action === 'cancel' && taskId) {
        if (!context.onCancelDelegatedTask) return 'Task cancellation is unavailable.';
        return (await context.onCancelDelegatedTask(taskId))
          ? `Cancelled delegated task ${taskId}.`
          : `Task ${taskId} is not running or was not found.`;
      }
      if (!context.onListDelegatedTasks) return 'Delegated task tracking is unavailable.';
      const tasks = await context.onListDelegatedTasks();
      if (!tasks.length) return 'No delegated tasks in this session.';
      return `Delegated tasks:\n${tasks.map((task) => `  ${task.taskId}  [${task.status}] @${task.agent} — ${task.task}`).join('\n')}`;
    },
  };
}

function createMcpCommand(): SlashCommand {
  return {
    name: 'mcp',
    description: 'Manage MCP servers',
    category: 'mcp',
    argumentHint: '[list|connect|disconnect|status|tools]',
    handler: async (args, context) => {
      context.onNavigate?.('mcp');
      return '';
    },
  };
}

function createCompactCommand(): SlashCommand {
  return {
    name: 'compact',
    description: 'Summarize and compact session',
    category: 'session',
    handler: async (_args, context) => {
      if (!context.onCompact) return 'Session compaction is unavailable.';
      const result = await context.onCompact();
      return result.message;
    },
  };
}

function createConnectCommand(): SlashCommand {
  return {
    name: 'connect',
    description: 'Set API key for provider',
    category: 'config',
    argumentHint: '<provider>',
    handler: async (args, context) => {
      const apiKeys = context.getApiKeys?.() ?? {};

      if (!args || !args.trim()) {
        return formatProviderStatus(apiKeys);
      }

      const provider = args.trim().toLowerCase();
      if (!isKnownProvider(provider)) {
        return `Unknown provider "${provider}". Valid: ${listProviderNames().join(', ')}`;
      }
      if (provider === 'lmstudio') {
        return 'LM Studio is local and does not need an API key. Use /model local or /models.';
      }

      context.onConnectProvider?.(provider);
      return `Enter API key for ${provider}. Press Enter to save or type /cancel to abort.`;
    },
  };
}

function createDisconnectCommand(): SlashCommand {
  return {
    name: 'disconnect',
    description: 'Remove API key for provider',
    category: 'config',
    argumentHint: '<provider>',
    handler: async (args, context) => {
      if (args) {
        if (!context.onDisconnectProvider) return 'Provider disconnection is unavailable.';
        const provider = args.trim().toLowerCase();
        const removed = await context.onDisconnectProvider(provider);
        return removed
          ? `Disconnected ${provider}. The active agent has been refreshed.`
          : `No stored credentials found for ${provider}.`;
      }
      return 'Usage: /disconnect <provider>';
    },
  };
}

function createExitCommand(): SlashCommand {
  return {
    name: 'exit',
    description: 'Exit the application',
    category: 'system',
    handler: async () => {
      process.exit(0);
    },
  };
}

function createSkillCommand(): SlashCommand {
  return {
    name: 'skill',
    description: 'Manage and invoke skills',
    category: 'skill',
    argumentHint: '[list|activate|deactivate|create|<name> [query]]',
    handler: async (args, context) => {
      if (!context.skillManager) {
        return 'Skill manager not available';
      }

      const parts = args.trim().split(/\s+/);
      const subcommand = parts[0]?.toLowerCase();
      const rest = parts.slice(1).join(' ');

      if (!subcommand || subcommand === 'list') {
        const all = context.skillManager.getAll();
        const activated = context.skillManager.getActivated();
        const available = context.skillManager.getAvailable();

        const lines = [`Skills (${all.length} total, ${activated.length} activated):`, ''];

        if (activated.length > 0) {
          lines.push('Activated:');
          for (const skill of activated) {
            lines.push(`  [x] ${skill.name} - ${skill.description || 'No description'}`);
          }
          lines.push('');
        }

        if (available.length > 0) {
          lines.push('Available (not activated):');
          for (const skill of available) {
            lines.push(`  [ ] ${skill.name} - ${skill.description || 'No description'}`);
          }
          lines.push('');
        }

        if (all.length === 0) {
          lines.push('No skills found. Create one with: /skill create <name>');
        } else {
          lines.push('Usage:');
          lines.push('  /skill activate <name>  - Activate a skill');
          lines.push('  /skill deactivate <name> - Deactivate a skill');
          lines.push('  /skill <name> [query]   - Invoke a skill');
          lines.push('  /skill create <name>    - Create a new skill');
        }

        return lines.join('\n');
      }

      if (subcommand === 'activate') {
        if (!rest) {
          return 'Usage: /skill activate <name>';
        }
        const success = await context.skillManager.activateSkill(rest);
        return success ? `Skill "${rest}" activated` : `Skill "${rest}" not found`;
      }

      if (subcommand === 'deactivate') {
        if (!rest) {
          return 'Usage: /skill deactivate <name>';
        }
        const success = await context.skillManager.deactivateSkill(rest);
        return success ? `Skill "${rest}" deactivated` : `Skill "${rest}" not found`;
      }

      if (subcommand === 'create') {
        if (!rest) {
          return 'Usage: /skill create <name>';
        }
        const skill = context.skillManager.getSkill(rest);
        if (skill) {
          return `Skill "${rest}" already exists`;
        }
        const dir = await context.skillManager.createSkillDirectory(
          rest,
          `Skill for ${rest}`,
          `# ${rest}\n\nDescribe the reusable workflow here.\n\n## Usage\n\n{{query}}`
        );
        return dir
          ? `Created skill "${rest}" at ${dir}\nEdit the SKILL.md file to customize it.`
          : `Failed to create skill "${rest}"`;
      }

      const skill = context.skillManager.getSkill(subcommand);
      if (!skill) {
        const all = context.skillManager.getAll();
        const names = all.map((s) => s.name).join(', ');
        return `Skill "${subcommand}" not found. Available: ${names || 'none'}`;
      }
      if (!skill.enabled) {
        return `Skill "${subcommand}" is not activated. Use /skill activate ${subcommand}`;
      }

      let result = skill.body;
      if (result.includes('{{query}}')) {
        result = result.replace(/{{\s*query\s*}}/g, rest || '');
      }

      const modelInfo = skill.model ? `\nModel: ${skill.model}` : '';
      const toolsInfo =
        skill.allowedTools.length > 0 ? `\nAllowed tools: ${skill.allowedTools.join(', ')}` : '';
      return `Skill: ${skill.name}${modelInfo}${toolsInfo}\n${'='.repeat(40)}\n\n${result}`;
    },
    autocomplete: async (query) => {
      return ['list', 'activate', 'deactivate', 'create'];
    },
  };
}

function createStrategiesCommand(): SlashCommand {
  return {
    name: 'strategies',
    description: 'List workspace strategy aliases',
    category: 'agent',
    handler: async () => {
      const templates = listWorkspaceStrategyTemplatesSync();
      const lines = ['Configured Strategy Aliases:', ''];

      if (templates.length === 0) {
        lines.push('No strategy templates found in .dynamind/strategy-templates.');
        lines.push(
          'Add JSON templates there and map aliases in .dynamind/config.json under strategyEngines.'
        );
        return lines.join('\n');
      }

      for (const template of templates) {
        const alias =
          resolveWorkspaceBacktestEngine(template.id) ??
          resolveWorkspaceBacktestEngine(template.name) ??
          template.backtestEngine;
        lines.push(`- ${template.name} (${template.id})${alias ? ` -> ${alias}` : ''}`);
      }

      lines.push('');
      lines.push(
        'Strategy aliases come from .dynamind/config.json and template backtest settings.'
      );
      return lines.join('\n');
    },
  };
}

function createPositionCommand(): SlashCommand {
  return {
    name: 'position',
    description: 'Show position for a symbol',
    category: 'system',
    argumentHint: '<symbol>',
    handler: async (args, context) => {
      const symbol = args?.trim().toUpperCase();
      if (!symbol) {
        return 'Usage: /position <symbol>';
      }

      // Check if position exists via context
      const position = context.getPosition?.(symbol);
      if (!position) {
        return `No position found for ${symbol}`;
      }

      // Return position card artifact
      return {
        content: `Position for ${symbol}`,
        artifact: {
          kind: 'position-card' as const,
          symbol: position.symbol,
          side: position.side,
          size: position.size,
          entryPrice: position.entryPrice,
          currentPrice: position.currentPrice,
          pnl: position.pnl,
          pnlPercent: position.pnlPercent,
          leverage: position.leverage,
          liquidationPrice: position.liquidationPrice,
        },
      };
    },
  };
}

function createCommandCommand(): SlashCommand {
  return {
    name: 'command',
    description: 'Manage and run commands',
    category: 'system',
    argumentHint: '[list|create|<name> [args]]',
    handler: async (args, context) => {
      if (!context.commandRegistry) {
        return 'Command registry not available';
      }

      const parts = args.trim().split(/\s+/);
      const subcommand = parts[0]?.toLowerCase();
      const rest = parts.slice(1).join(' ');

      if (!subcommand || subcommand === 'list') {
        const all = context.commandRegistry.getAll();
        const enabled = context.commandRegistry.getEnabled();

        const lines = [`Commands (${all.length} total, ${enabled.length} enabled):`, ''];

        for (const cmd of all) {
          const status = cmd.enabled ? '[x]' : '[ ]';
          const model = cmd.model ? ` (${cmd.model})` : '';
          const subtask = cmd.subtask ? ' [subtask]' : '';
          lines.push(
            `  ${status} /${cmd.name}${model}${subtask} - ${cmd.description || 'No description'}`
          );
        }

        if (all.length === 0) {
          lines.push('No commands found. Create one with: /command create <name>');
        } else {
          lines.push('');
          lines.push('Usage:');
          lines.push('  /command <name> [args]  - Run a command');
          lines.push('  /command create <name>  - Create a new command');
        }

        return lines.join('\n');
      }

      if (subcommand === 'create') {
        if (!rest) {
          return 'Usage: /command create <name>';
        }
        const cmd = context.commandRegistry.getCommand(rest);
        if (cmd) {
          return `Command "${rest}" already exists`;
        }
        const filePath = await context.commandRegistry.createCommand(
          rest,
          `Command for ${rest}`,
          `Execute the ${rest} command.\n\nArguments: $ARGUMENTS`
        );
        return filePath
          ? `Created command "${rest}" at ${filePath}\nEdit the file to customize it.`
          : `Failed to create command "${rest}"`;
      }

      const cmd = context.commandRegistry.getCommand(subcommand);
      if (!cmd) {
        const all = context.commandRegistry.getAll();
        const names = all.map((c) => c.name).join(', ');
        return `Command "${subcommand}" not found. Available: ${names || 'none'}`;
      }
      if (!cmd.enabled) {
        return `Command "${subcommand}" is disabled. Use /command enable ${subcommand}`;
      }

      let result = cmd.body;
      if (result.includes('$ARGUMENTS')) {
        result = result.replace(/\$ARGUMENTS/g, rest || '');
      }

      return `Command: ${cmd.name}\n${'='.repeat(40)}\n\n${result}`;
    },
    autocomplete: async (query) => {
      return ['list', 'create'];
    },
  };
}

function createReloadCommand(): SlashCommand {
  return {
    name: 'reload',
    description: 'Reload models and config from YAML files',
    category: 'config',
    handler: async () => {
      try {
        await reloadProviders();
        const providers = listProviderNames();
        return `Models reloaded from YAML. Providers: ${providers.join(', ')}`;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return `Failed to reload models: ${msg}`;
      }
    },
  };
}

function createUndoCommand(): SlashCommand {
  return {
    name: 'undo',
    description: 'Undo last file changes (git-backed)',
    category: 'session',
    handler: async (_args, context) => {
      if (!context.onUndo) return 'Undo is unavailable.';
      const result = await context.onUndo();
      return result.message;
    },
  };
}

function createRedoCommand(): SlashCommand {
  return {
    name: 'redo',
    description: 'Redo last undone file changes',
    category: 'session',
    handler: async (_args, context) => {
      if (!context.onRedo) return 'Redo is unavailable.';
      const result = await context.onRedo();
      return result.message;
    },
  };
}

function createForkCommand(): SlashCommand {
  return {
    name: 'fork',
    description: 'Fork current session into a new one',
    category: 'session',
    argumentHint: '[new-title]',
    handler: async (args, context) => {
      if (!context.onForkSession) return 'Session forking is unavailable.';
      const result = await context.onForkSession(args.trim() || undefined);
      return result.message;
    },
  };
}

function createBtwCommand(): SlashCommand {
  return {
    name: 'btw',
    description: 'Ask a side question without interrupting current work',
    category: 'agent',
    argumentHint: '<question>',
    handler: async (args, context) => {
      if (!args.trim()) return 'Usage: /btw <question>';
      if (!context.onBtw) return 'Side questions are unavailable.';
      const result = await context.onBtw(args.trim());
      return result;
    },
  };
}

function createExportCommand(): SlashCommand {
  return {
    name: 'export',
    description: 'Export session as markdown or JSON',
    category: 'session',
    argumentHint: '[markdown|json]',
    handler: async (args, context) => {
      if (!context.onExportSession) return 'Session export is unavailable.';
      const format = (args.trim().toLowerCase() || 'markdown') as 'markdown' | 'json';
      if (format !== 'markdown' && format !== 'json') {
        return 'Usage: /export [markdown|json]';
      }
      const result = await context.onExportSession(format);
      return result.message;
    },
  };
}

function createWatchCommand(): SlashCommand {
  return {
    name: 'watch',
    description: 'Watch files and run command on changes',
    category: 'system',
    argumentHint: '[list|stop|clear|<command>]',
    handler: async (args, context) => {
      if (!context.onWatch) return 'Watch mode is unavailable.';
      const result = await context.onWatch(args.trim());
      return result;
    },
  };
}
