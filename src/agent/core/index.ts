/**
 * Dyna-Trader Agent Core Package
 *
 * Provides enhanced agent coordination and reasoning capabilities.
 * Strategy logic is expressed as SKILL.md files — the agent reads
 * them and uses tools (plugins + core) to execute.
 */

export * from "./agent-core";
export * from "./conversation-manager";
export * from "./context-engine";
export * from "./iteration-budget";
export * from "./prompt-builder";
export * from "./types";
export * from "./memory-writer";
export * from "./skill-factory";
export * from "./cross-session-recall";
export * from "./recovery-manager";
export { ErrorClassifier, ErrorCategory, ErrorSeverity } from "./error-classifier";
export type { ClassifiedError } from "./error-classifier";
export * from "./intent-router";
export * from "./session-manager";
export * from "./slash-commands";
export * from "./hooks";
export * from "./goal-manager";
export * from "./provider-doctor";
export * from "./templates/index";
export * from "./post-turn-hooks";
export * from "./skill-manager";
export * from "./session-search";
export * from "./memory-consolidation";
export * from "./graduated-loop-detector";
export * from "./turn-controller";
export * from "./batch-executor";
export * from "./reflection-runner";
export { QueryRewriter, type RewriteResult, type MessageHistoryEntry } from "./query-rewriter";
export { MemoryFabric, type MemoryFabricConfig, type SearchContext, type MemorySearchResult } from "./memory-fabric-v25";
export * from "./durable-task-model";
export * from "./steering-channel";
export { ProviderFallbackChain, type ProviderHealth, type FallbackChainConfig, type FallbackChainEvents } from "./provider-fallback";
export * from "./daemon-sessions";
export * from "./agent-messaging";
export * from "./continual-harness";
export * from "./tool-call-parser";
export type { ToolCallPayload, ParseResult } from "./tool-call-parser";
export * from "./active-memory-recall";
export * from "./decision-models";
export * from "./skill-workshop";

// Re-export key types
export type { AgentCoreConfig, AgentIteration, AgentTurnResult } from "./agent-core";
export { AgentStateMachine } from "./agent-state-machine";
export type { ContextCompressionConfig, ContextState, CompactionConfig } from "./context-engine";
export type { BudgetConfig, BudgetAdjustment } from "./iteration-budget";
export type { PromptTemplate } from "./prompt-builder";
export type {
  TradeOutcome,
  MarketConditions,
  StrategyAdjustment,
  MarketRegime,
  MarketTrend,
  VolumeLevel,
} from "./types";
export type {
  MemoryEntry,
  MemoryEntryType,
  PerformanceSummary,
} from "./memory-writer";
export type { IntentRoute, TurnBudget } from "./intent-router";
export type { Session, SessionInfo, SessionMetadata } from "./session-manager";
export type { SlashCommand, CommandContext, CommandResult } from "./slash-commands";
export { SlashCommandRegistry, registerDefaultCommands } from "./slash-commands";
export { HooksManager } from "./hooks";
export type { HookEvent, HookContext, HookResult, Hook } from "./hooks";
export { GoalManager } from "./goal-manager";
export type { ResearchGoal, Claim, Evidence, GoalBudget, CompletionPolicy, GoalStep, GoalPriority } from "./goal-manager";
export { QualityScorer } from "./quality-scorer";
export type { ResponseScore } from "./quality-scorer";
export { TelemetryEmitter } from "./telemetry";
export type { HistogramStats, TelemetrySnapshot } from "./telemetry";
export { withTimeout, cancelTimeout, TimeoutError } from "./timeout";
export { createToolProgressEvent, CollectToolProgress } from "./streaming-tool-results";
export type { ToolProgressEvent } from "./streaming-tool-results";

// MCP (Model Context Protocol) integration
export * from "../../mcp/server";
export * from "../../mcp/client";
export * from "../../mcp/types";

// Export singletons
export { promptBuilder as default } from "./prompt-builder";
