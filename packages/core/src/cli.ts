/**
 * Public integration surface for the DynaTrader CLI package.
 *
 * Keep these exports explicit: this entry contains the runtime building
 * blocks the shipped CLI consumes without exposing Core's source layout.
 */
export { DynaTraderRuntime } from './orchestration/workspace/index';
export type {
  RuntimeConfig,
  RuntimeStatus,
  WorkspaceManifest,
  PipelineResult,
} from './orchestration/workspace/index';
export { getWorkspacePath, getStatePath, ensureWorkspace } from './workspace-init';
export { HaltState } from './runtime/halt/halt-state';
export { HealthServer } from './health-server';
export { TelegramGateway } from './gateway/telegram/telegram-gateway';
export type { TelegramMessage } from './gateway/telegram/telegram-gateway';
export { ApprovalManager } from './gateway/telegram/approval-manager';
export { CommandRouter } from './gateway/telegram/command-router';
export { TELEGRAM_MENU_COMMANDS } from './gateway/telegram/command-menu';
export { CallbackRouter } from './gateway/telegram/callback-router';
export { DiscordGateway } from './gateway/discord-gateway';
export { HaltTradingTool } from './agent/tools/risk-tools';
export { VoiceTranscriptionTool } from './runtime/tools/tools/voice-transcription-tool';
export { TtsTool } from './runtime/tools/tools/tts-tool';
export {
  resolveGatewayRuntimeConfig,
  buildGatewayRuntimeStatus,
  sendGatewayMessage,
  listGatewayTargets,
} from './gateway/runtime-gateway';
export { requireVisibleResponse } from './runtime/visible-response';
export { buildTelegramChatOptions } from './runtime/telegram-turn';
export { AgentCore } from './agent/core/agent-core';
export type { DelegationRequest } from './agent/core/agent-core';
export { HooksManager } from './agent/core/hooks';
export { SkillManager } from './agent/core/skill-manager';
export { SkillLoader } from './agent/skills/skill-loader';
export { createTradingTools } from './agent/tools/trading-tools';
export { AuditTrail } from './audit/audit-trail';
export { loadConfig, saveConfig } from './config';
export type { DynaConfig } from './config';
export { JsonRpcServer } from './gateway/json-rpc/server';
export { RunCardManager } from './governance/run-cards';
export { PaperEngine } from './market/backtest/paper-engine';
export { createExchangeAdapter } from './market/exchange/exchange-factory';
export { ExecutionRouterImpl } from './runtime/execution/execution-router';
export { AgentRegistry } from './runtime/subagents/agent-registry';
export { ToolRegistryImpl } from './runtime/tools/tool-registry';
export { registerAgentTools } from './runtime/tools/register-agent-tools';
// REPL + SDK bridge: this is how a headless host (the desktop stdio agent)
// gives the model a code-execution surface it can chain SDK calls from.
export { createDynaSdkInvoker } from './runtime/sdk/dynatrader-sdk';
export { SessionReplRuntime, NodeReplService, PythonReplService } from './runtime/repl/session-runtime';
export { SubprocessReplKernelFactory } from './runtime/repl/subprocess-kernel';
export { NodeReplTool, PythonReplTool } from './runtime/tools/tools/repl-tools';
export type { AgentToolRegistrationOptions } from './runtime/tools/register-agent-tools';
export { FIRST_PARTY_SDK_TOOL_CATALOG, getAvailableSdkToolDefinitions, isAvailableSdkTool } from './runtime/sdk/sdk-tool-catalog';
export { EditTool } from './runtime/tools/tools/edit-tool';
export { ExecTool, TaskListTool, TaskOutputTool, TaskStopTool } from './runtime/tools/tools/exec-tool';
export { GlobTool } from './runtime/tools/tools/glob-tool';
export { GrepTool } from './runtime/tools/tools/grep-tool';
export { MarketDataTool } from './runtime/tools/tools/market-data-tool';
export { MemorySearchTool } from './runtime/tools/tools/memory-search-tool';
export { MemoryWriteTool } from './runtime/tools/tools/memory-write-tool';
export { ReadTool } from './runtime/tools/tools/read-tool';
export { SessionSearchTool } from './runtime/tools/tools/session-search-tool';
export { WebFetchTool } from './runtime/tools/tools/web-fetch-tool';
export { WebSearchTool } from './runtime/tools/tools/web-search-tool';
export { WriteTool } from './runtime/tools/tools/write-tool';
export { loadWorkspaceAgentPrompt } from './runtime/workspace-agent-prompt';
export { MemoryStoreImpl } from './memory/core/memory-store';
export { SqliteMemoryStore } from './memory/sqlite/sqlite-store';
export {
  AnthropicProvider,
  DeepSeekProvider,
  GoogleProvider,
  LMStudioProvider,
  ModelRouterImpl,
  OllamaProvider,
  OpenAIProvider,
  OpenRouterProvider,
} from './orchestration/models/index';
export { normalizeMarketRecord } from './market/utils';
export { IssueBoard } from './issue-board';
export type { IssueStatus } from './issue-board';
export { TrackedEntityStore } from './tracking/tracked-entity';
export { Inbox } from './inbox';
export {
  canUseGenericCredentialAliases,
  getCredentialEnv,
  hasCredentialEnv,
} from './market/exchange/credential-env';
export { DaemonController } from './gateway/daemon-controller';
export { ContextCompactionEngine } from './context/context-compaction-engine';
export { KanbanBoard } from './orchestration/workspace/kanban-board';
export type { Task, TaskStatus } from './orchestration/workspace/kanban-board';
export { WorkspaceManager } from './orchestration/workspace/workspace-manager';
export { StateDb } from './state-db/state-db';
export { AgentTaskService, KanbanTaskCompatibilityAdapter } from './state-db';
export type { AgentTask, AgentTaskListFilter, AgentTaskScope, AgentTaskStatus, AgentTaskPriority } from './state-db';
export type { ConversationMessageRow, ConversationSessionRow } from './state-db/types';

export type {
  AgentTurnContext,
  ExchangeAdapter,
  OrderIntent,
  StrategySource,
  TradeMode,
} from './types/index';
