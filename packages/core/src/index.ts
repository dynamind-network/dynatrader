/**
 * DynaTrader SDK — Public API
 *
 * Importable SDK for building trading agents on top of DynaTrader.
 * Other products can import this package.
 *
 * Usage:
 *   import { AgentCore, ToolRegistryImpl } from '@dyna/agent-core';
 *
 * NOTE: Types from @dyna/contracts are re-exported here so SDK consumers
 * don't need to depend on the contracts package directly.
 */

// =============================================================================
// Agent Core
// =============================================================================
export { AgentCore } from './agent/core/agent-core';
export type { AgentCoreConfig, AgentIteration, AgentTurnResult } from './agent/core/agent-core';
export { AgentStateMachine } from './agent/core/agent-core';
export { ConversationManager } from './agent/core/conversation-manager';
export type { ConversationConfig } from './agent/core/conversation-manager';

// Re-export AgentState from contracts (used by AgentStateMachine internally)
export type { AgentState } from '@dyna/contracts';

// =============================================================================
// Session Management
// =============================================================================
export { SessionManager } from './agent/core/session-manager';
export type { Session, SessionInfo, SessionMetadata } from './agent/core/session-manager';

// =============================================================================
// Recovery
// =============================================================================
export { RecoveryManager } from './agent/core/recovery-manager';
export type { RecoveryConfig, RecoveryState, RecoveryAction } from './agent/core/recovery-manager';

// =============================================================================
// Intent Routing
// =============================================================================
export { IntentRouter } from './agent/core/intent-router';
export type { IntentRoute, TurnBudget } from './agent/core/intent-router';

// =============================================================================
// Slash Commands
// =============================================================================
export { SlashCommandRegistry } from './agent/core/slash-commands';
export type { SlashCommand, CommandContext, CommandResult } from './agent/core/slash-commands';

// =============================================================================
// Hooks
// =============================================================================
export { HooksManager } from './agent/core/hooks';
export type { HookEvent, Hook, HookContext, HookResult } from './agent/core/hooks';

// =============================================================================
// Provider Diagnostics
// =============================================================================
export { ProviderDoctor } from './agent/core/provider-doctor';
export type { ProviderCapabilities, ProviderHealth, DiagnosisResult } from './agent/core/provider-doctor';

// =============================================================================
// Research Goals
// =============================================================================
export { GoalManager } from './agent/core/goal-manager';
export type { ResearchGoal, Claim, Evidence, GoalBudget, CompletionPolicy, GoalStep, GoalPriority } from './agent/core/goal-manager';

// =============================================================================
// Model Router
// =============================================================================
export { ModelRouterImpl } from './orchestration/models/model-router';
export type { ModelRouterConfig } from './orchestration/models/model-router';

// Re-export key model types from contracts
export type { ModelRequest, ModelResponse, ModelStreamChunk } from '@dyna/contracts';

// =============================================================================
// Provider Registry (shared between core and terminal)
// =============================================================================
export { PROVIDERS, initProvidersFromYAML, reloadProviders, refreshModels } from './providers/registry';
export { loadProvidersFromYAML, invalidateProvidersCache } from './providers/yaml-loader';
export type { LoadOptions } from './providers/yaml-loader';
export {
  listCatalogModels,
  findModelById,
  resolveModelQuery,
  parseEffortLevel,
  modelSupportsEffort,
  isKnownProvider,
  listProviderNames,
  formatProviderStatus,
  EFFORT_LEVELS,
} from './providers/catalog';
export type { ProviderEntry, CatalogModel, EffortLevel, ResolveModelResult } from './providers/types';

// =============================================================================
// Config (shared between core and terminal)
// =============================================================================
export { loadConfig, saveConfig, defaultConfig } from './config';
export type { DynaConfig } from './config';

// =============================================================================
// API Key Resolution (shared between core and terminal)
// =============================================================================
export { resolveApiKeys } from './auth/key-resolver';
export type { KeyResolverOptions } from './auth/key-resolver';

// =============================================================================
// Tool Registry
// =============================================================================
export { ToolRegistryImpl } from './runtime/tools/tool-registry';
export type { ToolRegistryConfig } from './runtime/tools/tool-registry';

// Re-export key tool types from contracts
export type { ToolDefinition, ToolHandler, ToolCall, ToolResult, ToolCategory } from '@dyna/contracts';
export { classifyShellCommand } from './security/shell-command-policy.js';
export type { ShellCommandDecision } from './security/shell-command-policy.js';

// =============================================================================
// Plugin System (capability seams)
// =============================================================================
export { PluginRegistry } from './plugins/registry';
export type { PluginRegistryOptions, RegisteredPlugin, PluginRegistryStats } from './plugins/registry';
export { bootPluginTree, composePluginRows, registerBuiltinPlugin } from './plugins/composition';
export type { PluginLayer, PluginRow, PluginRowInput, MountReport } from './plugins/composition';
export { MCPBridge } from './plugins/mcp-bridge';
export type { MCPBridgeConfig, MCPToolMapping, MCPBridgeConnection } from './plugins/mcp-bridge';
export type {
  PluginCapability,
  DynaPlugin,
  PluginFactory,
  PluginContext,
  PluginLogger,
  PluginManifest,
  PluginToolDeclaration,
  PluginToolHandler,
  MarketDataProvider,
  ExchangeAdapterRegistry,
  SignalProvider,
  RiskProvider,
  NewsProvider,
  ExchangeProvider,
  BacktestProvider,
  DeFiProvider,
  MacroProvider,
  WalletProvider,
  DexRoutingProvider,
  GasEstimationProvider,
  Candle,
  OrderBook,
  Signal,
  SignalDirection,
  SignalTier,
  ConsensusSignal,
  AccuracyStats,
  RiskGateRequest as PluginRiskGateRequest,
  RiskGateResult as PluginRiskGateResult,
  CircuitBreakerConfig as PluginCircuitBreakerConfig,
  NewsArticle,
  SentimentData,
  NewsOptions,
  ExchangeInfo,
  BacktestConfig as PluginBacktestConfig,
  BacktestResult as PluginBacktestResult,
  StrategyInfo as PluginStrategyInfo,
  Chain as DeFiChain,
  Protocol as DeFiProtocol,
  Pool as DeFiPool,
  MacroImpact,
  MacroEvent,
  FOMCMeeting,
  WalletBalanceInfo,
  WalletSwapQuote,
  DEXRouteInfo,
  GasEstimateResult,
  GasHistoryEntry,
} from './plugins/types';

// =============================================================================
// MCP (Model Context Protocol)
// =============================================================================
export { McpServer } from './mcp/server';
export { McpClient, McpToolProxy } from './mcp/client';
export type { McpServerConnection } from './mcp/client';
export type { McpTool, McpRequest, McpResponse, McpServerConfig, McpToolCall, McpToolResult } from './mcp/types';

// =============================================================================
// Gateway: JSON-RPC
// =============================================================================
export { JsonRpcServer } from './gateway/json-rpc/server';
export type { JsonRpcServerConfig } from './gateway/json-rpc/server';
export type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  ServerEvent,
  MessageDeltaEvent,
  ToolStartEvent,
  ToolCompleteEvent,
  ApprovalRequestEvent,
  ThinkingEvent,
  ErrorEvent,
  SessionUpdateEvent,
  PlanModeEvent,
  PlanStepUpdateEvent,
} from './gateway/json-rpc/types';
export { JsonRpcErrorCodes } from './gateway/json-rpc/types';
export { RpcMethods, RpcEvents } from './gateway/json-rpc/protocol';
export type { RpcMethodName, RpcEventName, GoalManageAction, GoalManageParams, GoalManageResult, GoalSummaryRPC } from './gateway/json-rpc/protocol';

// =============================================================================
// Auth Profiles (API Key Rotation)
// =============================================================================
export { AuthProfileManager } from './auth/index.js';
export {
  loadAuthProfileStore,
  saveAuthProfileStore,
  resolveAuthStorePath,
  createEmptyStore,
  listProfilesForProvider,
  dedupeProfileIds,
  getCredentialKey,
  isCredentialValid,
} from './auth/store.js';
export { resolveAuthProfileOrder } from './auth/order.js';
export {
  isProfileInCooldown,
  getSoonestCooldownExpiry,
  clearExpiredCooldowns,
  markAuthProfileUsed,
  markAuthProfileFailure,
  markAuthProfileCooldown,
  clearAuthProfileCooldown,
  calculateAuthProfileCooldownMs,
} from './auth/usage.js';
export type {
  ApiKeyProfile,
  AuthProfileCredential,
  AuthProfileConfig,
  AuthConfig,
  AuthProfileFailureReason,
  AuthProfileStore,
  ProfileUsageStats,
  ResolvedProviderAuth,
  TokenProfile,
} from './auth/types.js';

// =============================================================================
// Workspace Runtime (for backend integration)
// =============================================================================
export { DynaTraderRuntime } from './orchestration/workspace/index.js';
export type { RuntimeConfig, RuntimeMode } from './orchestration/workspace/types.js';

// =============================================================================
// Circuit Breakers + Hard Risk Gate (standalone functions)
// =============================================================================
export { executeRiskGate, isRiskGateRequired } from './risk/core/hard-gate.js';
export type { RiskGateRequest, RiskGateResult } from './risk/core/hard-gate.js';
export { isTradingAllowed, updateCircuitBreakers, DEFAULT_CIRCUIT_BREAKER_CONFIG } from './risk/core/circuit-breakers.js';
export type { CircuitBreakerState, CircuitBreakerConfig } from './risk/core/circuit-breakers.js';

// =============================================================================
// Exchange Adapter
// =============================================================================
export { CCXTAdapter } from './market/exchange/ccxt-adapter.js';
export type { CCXTAdapterConfig } from './market/exchange/ccxt-adapter.js';
export { AlpacaAdapter } from './market/exchange/alpaca-adapter.js';
export type { AlpacaAdapterConfig } from './market/exchange/alpaca-adapter.js';
export { IBKRAdapter } from './market/exchange/ibkr-adapter.js';
export type { IBKRAdapterConfig } from './market/exchange/ibkr-adapter.js';
export { LongbridgeAdapter } from './market/exchange/longbridge-adapter.js';
export type { LongbridgeAdapterConfig } from './market/exchange/longbridge-adapter.js';
export { BrokerAggregator } from './market/exchange/broker-aggregator.js';
export type { BrokerBalanceSnapshot, BrokerMarketSnapshot } from './market/exchange/broker-aggregator.js';

// =============================================================================
// Workspace artifacts and health
// =============================================================================
export { IssueBoard } from './issue-board/issue-board.js';
export { TrackedEntityStore } from './tracking/tracked-entity.js';
export { Inbox } from './inbox/inbox.js';
export { TradingGit } from './orchestration/workspace/trading-git.js';
export type { StagedOrder, Commit, PushResult, StagingStatus } from './orchestration/workspace/trading-git.js';
export { HealthServer } from './health-server.js';
export { EvalHarness, EvolutionLoop, SkillMutator, EvolutionPrGenerator, scoreFitness, validateConstraints } from './evolution/index.js';
export type { EvolutionTask, EvaluationTrace, FitnessScore, EvolutionRequest, EvolutionResult, EvolutionBranchRequest, EvolutionBranchResult, PrGeneratorConfig } from './evolution/index.js';

// =============================================================================
// Audit Trail
// =============================================================================
export { AuditTrail } from './audit/audit-trail.js';

// =============================================================================
// Re-exported contract types (for SDK convenience)
// =============================================================================
export type {
  ConversationMessage,
  ChatResponse,
  TradeMode,
  AgentTurnContext,
  StrategySource,
  SkillManifest,
  OrderIntent,
  ExchangeRiskSnapshot,
  RiskDecision,
  ExecutionMode,
  ExecutionResult,
  ApprovalToken,
} from '@dyna/contracts';

// =============================================================================
// Knowledge Types (simple wiki store)
// =============================================================================
export type {
  BaseKnowledge,
  Citation,
  SourceRef,
  ExtractionRef,
  ArtifactMeta,
} from './knowledge/types/base.js';

// =============================================================================
// Agent Profiles (multi-agent support)
// =============================================================================
export { AgentProfileManager } from './agent/profiles/agent-profile-manager.js';
export type {
  AgentProfileCreateRequest,
  AgentProfileUpdateRequest,
  AgentProfileSummary,
} from './agent/profiles/agent-profile-manager.js';

// =============================================================================
// Agent Messaging (A2A communication)
// =============================================================================
export { MessageBus, getMessageBus, resetMessageBus } from './agent/messaging/message-bus.js';
export type { AgentMessage, MessageHandler, MessageBusStats } from './agent/messaging/message-bus.js';
export { AgentCommunicator, createAgentCommunicator } from './agent/messaging/agent-communicator.js';
export type { CommunicatorConfig, SendMessageRequest, SendMessageResponse, AgentInfo } from './agent/messaging/agent-communicator.js';

// =============================================================================
// A2A Protocol (Agent-to-Agent)
// =============================================================================
export { A2AServer, createA2AServer } from './orchestration/a2a/a2a-http-server.js';
export type { A2AServerConfig, A2ATaskHandler, A2AServerStatus } from './orchestration/a2a/a2a-http-server.js';
export { A2AClient, createA2AClient } from './orchestration/a2a/a2a-client.js';
export type { A2AClientConfig, A2ASendRequest, A2ASendResponse, A2AClientStatus } from './orchestration/a2a/a2a-client.js';
export { A2ADiscovery, createA2ADiscovery } from './orchestration/a2a/a2a-discovery.js';
export type { A2ADiscoveryConfig, A2APeerConfig, A2ADiscoveredPeer, A2ADiscoveryStatus } from './orchestration/a2a/a2a-discovery.js';

// =============================================================================
// StateDb (unified persistence layer)
// =============================================================================
export { StateDb } from './state-db/state-db';
export { AgentTaskService, KanbanTaskCompatibilityAdapter } from './state-db';
export type { AgentTask, AgentTaskListFilter, AgentTaskScope, AgentTaskStatus, AgentTaskPriority } from './state-db';
export { createDynaTraderSdk, createDynaSdkInvoker } from './runtime/sdk/dynatrader-sdk';
export type { DynaSdkMethod, DynaSdkCallContext, DynaSdkInvoker, DynaTraderSdk } from './runtime/sdk/dynatrader-sdk';
export { SessionReplRuntime, NodeReplService, PythonReplService, ReplRuntimeError } from './runtime/repl/session-runtime';
export type { ReplLanguage, ReplKernel, ReplKernelFactory, LocalSdkBridge, ReplExecutionOutput } from './runtime/repl/session-runtime';
export { SubprocessReplKernelFactory } from './runtime/repl/subprocess-kernel';
export type { SubprocessReplOptions } from './runtime/repl/subprocess-kernel';
export { NodeReplTool, PythonReplTool } from './runtime/tools/tools/repl-tools';
export { TodoTool } from './runtime/tools/tools/todo-tool';
export type {
  SessionRow,
  GoalRow,
  GoalStepRow,
  CronJobRow,
  CronStateRow,
  TradeRow,
  PositionRow,
  PortfolioSnapshotRow,
  PriceCacheRow,
  MemoryRow,
  MemoryRelationRow,
  TaskRow,
  StateMetaRow,
} from './state-db/types';
