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
  providerRequiresApiKey,
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

export { DEFAULT_SYSTEM_PROMPT, createSystemPrompt } from './core/system-prompt.js';
