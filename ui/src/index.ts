import { buildWorkspaceContextPrompt } from './config/workspace-context.js';

export * from './core/types.js';
export { AgentLoop } from './core/agent-loop.js';
export * from './auth/index.js';

export {
  PROVIDERS,
  reloadProviders,
  initProvidersFromYAML,
  refreshModels,
  createProvider,
  findProviderForModel,
  resolveDefaultModel,
  getAllModels,
  detectLMStudioModels,
  listCatalogModels,
  findModelById,
  resolveModelQuery,
  parseEffortLevel,
  modelSupportsEffort,
  isKnownProvider,
  listProviderNames,
  formatProviderStatus,
  EFFORT_LEVELS,
  type ProviderConfig,
  type ModelInfo,
  type AIProvider,
  type CatalogModel,
  type EffortLevel,
} from './core/providers.js';

export * from './tools/index.js';
export * from './agents/index.js';
export * from './utils/index.js';
export * from './commands/index.js';
export { registerSpawnAgentTools } from './agents/subagent.js';
export {
  buildWorkspaceContextPrompt,
  loadWorkspaceIdentitySync,
} from './config/workspace-context.js';

export { findProjectRoot, getProjectDirectory } from './utils/project-detection.js';
export { MCPClientManager, parseMCPConfig } from './mcp/client.js';
export { loadMCPConfig, saveMCPConfig, exampleMCPConfig } from './config/mcp-config.js';
export {
  loadSettings,
  loadPluginSettingsSync,
  getApiKeys,
  clearSettingsCache,
  updatePluginSetting,
  type AppSettings,
  type PluginSettings,
} from './config/settings.js';
export { loadConfig, saveLastModel, type AppConfig } from './config/config.js';
export { MCPCommandHandler } from './mcp/command-handler.js';
export { ContextManager, SessionManager } from './core/context-manager.js';
export { CheckpointManager, getCheckpointManager, autoCheckpoint } from './core/git-checkpoint.js';
export { UndoRedoManager, getUndoRedoManager } from './core/undo-redo.js';
export { resolveMentions } from './core/mention-resolver.js';
export { isShellPassthrough, extractShellCommand, executeShell } from './core/shell-passthrough.js';
export { runAutoLint, formatLintResults } from './core/auto-lint.js';
export { startWatcher, stopWatcher, listWatchers, stopAllWatchers } from './core/watch-manager.js';
export { forkSession } from './core/session-fork.js';
export { loadCustomCommands, getCustomCommand } from './core/custom-commands.js';
export { showNotification, getActiveNotifications, dismissNotification } from './core/notification-toast.js';
export { exportSession } from './core/session-export.js';
export { createVimState, processVimInput } from './core/vim-state.js';
export type { VimMode, VimState, VimAction } from './core/vim-state.js';
export type { Checkpoint, CheckpointDiff } from './core/git-checkpoint.js';
export type { BudgetProjection } from './core/compaction.js';

export const DEFAULT_SYSTEM_PROMPT = `You are the terminal agent for this workspace, an AI-powered CLI harness for coding, research, planning, and delegated work.

## Your Identity
- You run in a terminal environment (Ink/React)
- You can spawn specialized subagents for focused tasks
- Custom tools are provided by the connected runtime and MCP servers
- The backend runtime handles model execution, tool orchestration, and delegated work

## Available Tools

### File Operations
- read_file: read files or directories (use offset/limit for large files)
- write_file: create or replace entire files
- edit_file: make surgical string replacements

### Code Search
- glob: find files by pattern (e.g., "src/**/*.tsx")
- grep: search file contents with regex

### Terminal
- shell: run git, npm, bun, pnpm, and other commands

### Web
- web_search: search the web for current information
- web_fetch: fetch specific URLs

### Custom Runtime Tools
- Tool availability depends on the connected backend and workspace configuration

### Subagents
- skill: invoke specialized skills for focused work
- spawn_agent: create specialized subagents for focused tasks

### User Interaction
- question: ask the user to choose from multiple options

### MCP Tools (when configured)
- Dynamic tools from connected MCP servers

## Guidelines
1. Be concise and action-oriented
2. When a tool is the right next step, use it immediately - don't narrate intent
3. For coding tasks: write code directly, only use glob/grep/read when you need codebase context
4. For domain-specific tasks: cite data sources, acknowledge uncertainty, and respect workspace policy
5. Use question tool when you need user input or clarification
6. Break complex tasks into steps, verify your work

## Examples
- "create a script" -> treat as coding task, write code directly
- "find the auth logic" -> use grep first, then read relevant files
- "run the tests" -> use shell to run test command
- "analyze this dataset" -> use runtime tools or spawn a configured subagent
- "plan a change" -> use /plan <goal> for a read-only, reviewable plan

Current working directory: {cwd}
`;

export function createSystemPrompt(cwd: string, additionalContext?: string): string {
  let prompt = DEFAULT_SYSTEM_PROMPT.replace('{cwd}', cwd);

  const workspaceContext = buildWorkspaceContextPrompt(cwd);
  if (workspaceContext) {
    prompt += `\n\nWorkspace context:\n${workspaceContext}`;
  }

  if (additionalContext) {
    prompt += `\n\nAdditional context:\n${additionalContext}`;
  }

  return prompt;
}
