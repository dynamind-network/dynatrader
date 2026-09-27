/**
 * Enhanced Agent Core - Conversational Agent Loop
 *
 * General-purpose conversational agent where trading features are tools
 * the LLM calls when appropriate (not a forced pipeline).
 *
 * Classes:
 * - AgentStateMachine: lifecycle state management
 * - ConversationManager: message buffer, context window, auto-compact
 * - AgentCore: main orchestrator with chat() and chatStream() API
 */

import type {
  StrategySource, SkillManifest, AgentTurnContext, OrderIntent,
  ModelRouter, ModelRequest, ToolRegistry, ToolCall, ToolDefinition, ToolHandler,
  AgentState, ConversationMessage, ModelStreamChunk, ChatResponse, ToolResult,
  ExecutionMode, TradeMode,
} from "@dyna/contracts";
import { encoding_for_model } from "tiktoken";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ContextEngine } from "./context-engine";
import type { ContextState, ContextCompressionConfig } from "./context-engine";
import { promptAssembly } from "../../context/prompt-assembly";
import { BudgetTracker } from "../../context/budget-tracker";
import { PostCompactionGuard } from "../../context/post-compaction-guard";
import { IterationBudget } from "./iteration-budget";
import { PromptBuilder } from "./prompt-builder";
import { MemoryStoreImpl } from "@dyna/memory-core";
import type { TradeRecord } from "@dyna/backtest";
import type { TradeOutcome, MarketConditions, StrategyAdjustment } from "./types";
import { MemoryWriter } from "./memory-writer";
import type { PerformanceSummary } from "./memory-writer";
import { CrossSessionRecall } from "./cross-session-recall";
import { SkillFactory } from "./skill-factory";
import { RecoveryManager } from "./recovery-manager";
import type { RecoveryConfig } from "./recovery-manager";
import { HooksManager } from "./hooks";
import type { HookEvent } from "./hooks";
import { IntentRouter } from "./intent-router";
import { ProviderDoctor } from "./provider-doctor";
import { GoalManager } from "./goal-manager";
import { GoalLoopManager } from "./goal-loop";
import type { DreamEngine } from "../dream/dream-engine";
import type { ResearchGoal, Claim, Evidence } from "./goal-manager";
import type { RunCardManager } from "../../governance/run-cards";
import { SessionManager } from "./session-manager";
import type { Session, SessionInfo } from "./session-manager";
import { SlashCommandRegistry, registerDefaultCommands } from "./slash-commands";
import type { CommandContext, CommandResult } from "./slash-commands";
import { ContextCompactionEngine } from "../../context/context-compaction-engine";
import { normalizeVisibleText } from "../../runtime/visible-response";
import { errorMessage } from "../../utils/errors";
import {
  generateOrderIntents as generateOrderIntentsFromStrategy,
  calculateConfidence, generateAnalysis, buildContextMessages,
} from "./order-utils";
import { runPostTurnHooks } from "./post-turn-hooks";
import { SkillManager } from "./skill-manager";
import { SessionSearch } from "./session-search";
import { MemoryConsolidation } from "./memory-consolidation";
import { ToolResultCompressor } from "../../context/tool-result-compressor";
import { resourceClassFor, type ResourceClass } from "./batch-executor";
import { GraduatedLoopDetector, type BatchLoopSignal, formatRepeatNotice, formatForcedLoopReply, formatWanderingRedirect } from "./graduated-loop-detector";
import { TurnController, type TurnOrigin } from "./turn-controller";
import { SteeringInbox, type SteeringMessage } from "./steering-channel";
import { executeBatch, type BatchCallInput, type BatchExecutionResult } from "./batch-executor";
import { ReflectionRunner, type ReflectionConfig } from "./reflection-runner";
import { resolveProfiles, getToolsForProfiles, type ToolProfile } from "../../runtime/tools/tool-profiles";
import { ActiveMemoryRecall, type RecallResult } from "./active-memory-recall";

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return String(value);
}

const CONFIDENCE_THRESHOLD_FOR_SKILL_UPDATE = 0.5;

const ANTI_NARRATION_RULES = `
IMPORTANT RULES:
- Do NOT narrate your actions (e.g., "I will now call...", "Let me check..."). Just do them.
- Do NOT explain what tools you're about to use. Use them silently.
- Do NOT describe your reasoning process in prose. Think silently, then act.
- If you have a direct answer, give it. Don't prefix with "Based on my analysis..." or "After reviewing...".
- Use tools when needed, respond with the result. Skip the commentary.
`;

// ---------------------------------------------------------------------------
// Valid state transitions
// ---------------------------------------------------------------------------
const VALID_TRANSITIONS: Record<AgentState, AgentState[]> = {
  idle: ["starting", "error"],
  starting: ["running", "error"],
  running: ["tool_executing", "compacting", "stopping", "error"],
  tool_executing: ["running", "stopping", "error"],
  compacting: ["running", "stopping", "error"],
  stopping: ["idle"],
  error: ["idle", "starting"],
};

// ---------------------------------------------------------------------------
// AgentStateMachine
// ---------------------------------------------------------------------------
export class AgentStateMachine {
  private state: AgentState = "idle";
  private listeners: Array<(state: AgentState, prev: AgentState) => void> = [];

  getState(): AgentState { return this.state; }

  transition(newState: AgentState): void {
    const allowed = VALID_TRANSITIONS[this.state];
    if (!allowed || !allowed.includes(newState)) {
      throw new Error(`Invalid state transition: ${this.state} -> ${newState}. Allowed: ${allowed?.join(", ") ?? "none"}`);
    }
    const prev = this.state;
    this.state = newState;
    for (const listener of this.listeners) listener(newState, prev);
  }

  onStateChange(listener: (state: AgentState, prev: AgentState) => void): () => void {
    this.listeners.push(listener);
    return () => { const idx = this.listeners.indexOf(listener); if (idx >= 0) this.listeners.splice(idx, 1); };
  }
}

import { ConversationManager, type ConversationConfig } from "./conversation-manager";
export type { ConversationConfig } from "./conversation-manager";

// ---------------------------------------------------------------------------
// Interfaces (preserved for backward compat)
// ---------------------------------------------------------------------------
export interface AgentCoreConfig {
  memory: MemoryStoreImpl;
  modelRouter?: ModelRouter;
  toolRegistry?: ToolRegistry;
  defaultMode?: TradeMode;
  contextConfig?: Partial<ContextCompressionConfig>;
  budgetConfig?: { maxIterations: number; maxTimeMs: number; maxMemoryUsage: number; maxApiCalls: number };
  /** Maximum model/tool turns in one response before yielding a bounded result. */
  maxToolTurns?: number;
  memoryWriter?: MemoryWriter;
  crossSessionRecall?: CrossSessionRecall;
  skillFactory?: SkillFactory;
  skillLoader?: import("../skills/skill-loader").SkillLoader;
  compactionEngine?: ContextCompactionEngine;
  conversationConfig?: Partial<ConversationConfig>;
  recoveryConfig?: RecoveryConfig;
  intentRouter?: IntentRouter;
  sessionManager?: SessionManager;
  slashCommandRegistry?: SlashCommandRegistry;
  hooksManager?: HooksManager;
  goalManager?: GoalManager;
  runCardManager?: RunCardManager;
  workspacePath?: string;
  providerDoctor?: ProviderDoctor;
  /** SQLite persistence layer — enables session and conversation persistence. */
  db?: import("../../state-db/state-db").StateDb;
  templateNames?: {
    chat?: string;
    strategy?: string;
  };
  routingTaskNames?: {
    analysis?: string;
    chat?: string;
  };
  /** Optional workspace-authored instructions injected into the system prompt. */
  workspacePrompt?: string;
  /** Executes an independently scoped task for the delegate_task tool. */
  delegateTask?: (request: DelegationRequest) => Promise<unknown>;
  dreamEngine?: DreamEngine;
  requestToolApproval?: (call: ToolCall, definition: ToolDefinition) => Promise<boolean>;
  postTurnHooks?: typeof runPostTurnHooks;
  skillManager?: SkillManager;
  sessionSearch?: SessionSearch;
  memoryConsolidation?: MemoryConsolidation;
  graduatedLoopDetector?: GraduatedLoopDetector;
  turnController?: TurnController;
  steeringInbox?: SteeringInbox;
  reflectionRunner?: ReflectionRunner;
  reflectionConfig?: ReflectionConfig;
  durableTasks?: import('./durable-task-model').DurableTaskModel;
  daemonSessions?: import('./daemon-sessions').DaemonSessionManager;
  agentMessaging?: import('./agent-messaging').AgentMessaging;
  continualHarness?: import('./continual-harness').ContinualHarness;
  memoryFabric?: import('./memory-fabric-v25').MemoryFabric;
  /** Maximum parallel tool calls per batch step. Default: 4, hard ceiling: 16 */
  maxParallelToolCalls?: number;
  /** Max wave size for pure_read fan-out. Default: unlimited */
  maxWaveSize?: number;
  /** Tool result compressor for the Atomic Agent Compress step */
  toolResultCompressor?: import('../../context/tool-result-compressor').ToolResultCompressor;
  /** Enable/disable tool result compression (default: true) */
  compressToolResults?: boolean;
  /** Programmatic risk gate — rejects LLM proposals exceeding configured limits. */
  riskGate?: {
    maxLeverage?: number;
    maxPositionPct?: number;
    maxDailyLossPct?: number;
  };
  /**
   * Active tool profiles — controls which tools the agent exposes to the LLM.
   * Core profiles (base, memory, multi_agent) are always included.
   * Additional profiles add tools on top (e.g., 'trading', 'risk', 'messaging').
   * Like DeepSeek Harness profiles and Hermes tool router.
   */
  activeProfiles?: ToolProfile[];
  /**
   * Active memory recall — pre-reply memory search that injects relevant
   * context BEFORE the main model generates a reply (OpenClaw pattern).
   */
  activeMemoryRecall?: ActiveMemoryRecall;
}

export interface DelegationRequest {
  task: string;
  agent?: string;
  context?: Record<string, unknown>;
  sessionId?: string;
  signal?: AbortSignal;
}

export interface AgentIteration {
  id: string;
  iteration: number;
  timestamp: Date;
  input: { context: AgentTurnContext; source: StrategySource; memoryContext: string; budgetState: any };
  output: { strategies: SkillManifest[]; orderIntents: OrderIntent[]; analysis: string; confidence: number };
  metrics: { timeTaken: number; memoryUsed: number; apiCalls: number };
}

export interface AgentTurnResult {
  iterations: AgentIteration[];
  finalStrategies: SkillManifest[];
  pendingApprovals: OrderIntent[];
  completed: boolean;
  totalTime: number;
  totalMemory: number;
  totalApiCalls: number;
  chatResponse?: string;
  chatReasoningResponse?: string;
  error?: string;
}

interface ChatOptions {
  sessionId?: string;
  templateName?: string;
  triggerDreamCycle?: boolean;
  allowTools?: boolean;
  maxTokens?: number;
}

// ---------------------------------------------------------------------------
// AgentCore
// ---------------------------------------------------------------------------
export class AgentCore {
  private stateMachine: AgentStateMachine;
  private conversation: ConversationManager;
  private contextEngine: ContextEngine;
  private budget: IterationBudget;
  private promptBuilder: PromptBuilder;
  private config: AgentCoreConfig;
  private currentContext?: ContextState;
  private conversationConfig?: Partial<ConversationConfig>;
  private conversationsBySession = new Map<string, ConversationManager>();
  private contextsBySession = new Map<string, ContextState>();
  private iterations: AgentIteration[] = [];
  private memoryWriter: MemoryWriter;
  private crossSessionRecall: CrossSessionRecall | null = null;
  private skillFactory: SkillFactory | null = null;
  private compactionEngine?: ContextCompactionEngine;
  private budgetTracker: BudgetTracker;
  private postCompactionGuard: PostCompactionGuard;
  private recoveryManager: RecoveryManager;
  private intentRouter: IntentRouter;
  private sessionManager: SessionManager;
  private slashCommands: SlashCommandRegistry;
  private hooksManager: HooksManager;
  private goalManager: GoalManager;
  private runCardManager: RunCardManager | null;
  private workspacePath: string;
  private providerDoctor: ProviderDoctor;
  private dreamEngine: DreamEngine | null;
  private postTurnHooks: typeof runPostTurnHooks | null;
  private skillManager: SkillManager | null;
  private sessionSearch: SessionSearch | null;
  private memoryConsolidation: MemoryConsolidation | null;
  private graduatedLoopDetector: GraduatedLoopDetector;
  private turnController: TurnController | null;
  private steeringInbox: SteeringInbox | null;
  private reflectionRunner: ReflectionRunner | null;
  private durableTasks: import('./durable-task-model').DurableTaskModel | null;
  private daemonSessions: import('./daemon-sessions').DaemonSessionManager | null;
  private agentMessaging: import('./agent-messaging').AgentMessaging | null;
  private continualHarness: import('./continual-harness').ContinualHarness | null;
  private memoryFabric: import('./memory-fabric-v25').MemoryFabric | null;
  private maxParallelToolCalls: number;
  private maxWaveSize: number | undefined;
  private toolResultCompressor: import('../../context/tool-result-compressor').ToolResultCompressor | null;
  private planningSessions = new Map<string, { goal?: string; enteredAt: Date }>();
  private toolPolicies = new Map<string, { allowed?: Set<string>; disallowed: Set<string> }>();
  private toolStartTimes: Map<string, number> = new Map();
  private personaCache = new Map<string, string>();
  private cancelRequested = false;
  private cancelTimeout: ReturnType<typeof setTimeout> | null = null;
  private toolResultCache = new Map<string, { tool: string; args: unknown; result: ToolResult }>();
  private activeMemoryRecall: ActiveMemoryRecall | null;

  private evictOldest<K, V>(map: Map<K, V>, maxSize: number): void {
    if (map.size > maxSize) {
      const firstKey = map.keys().next().value;
      if (firstKey !== undefined) map.delete(firstKey);
    }
  }
  private doomLoopHistory: Array<{ tool: string; argsHash: string }> = [];
  private static readonly DOOM_LOOP_THRESHOLD = 3;

  private async partitionApprovedToolCalls(calls: ToolCall[]): Promise<{
    approved: ToolCall[];
    denied: Array<{ call: ToolCall; result: ToolResult }>;
  }> {
    if (!this.config.requestToolApproval || !this.config.toolRegistry) return { approved: calls, denied: [] };
    const definitions = new Map(this.config.toolRegistry.list().map((handler) => [handler.definition.name, handler.definition]));
    const approved: ToolCall[] = [];
    const denied: Array<{ call: ToolCall; result: ToolResult }> = [];
    for (const call of calls) {
      const definition = definitions.get(call.tool);
      const requiresApproval = definition && definition.readOnly !== true &&
        (definition.riskLevel === 'medium' || definition.riskLevel === 'high' || (definition.sideEffects?.length ?? 0) > 0);
      if (!requiresApproval || await this.config.requestToolApproval(call, definition)) {
        approved.push(call);
      } else {
        denied.push({ call, result: { success: false, error: 'User denied this tool call.', durationMs: 0, truncated: false } });
      }
    }
    return { approved, denied };
  }

  private resolveTemplateName(kind: 'chat' | 'strategy', preferred?: string): string {
    const envVar =
      kind === 'chat' ? process.env.DYNATRADER_CHAT_TEMPLATE : process.env.DYNATRADER_STRATEGY_TEMPLATE;
    const configured = preferred?.trim() || this.config.templateNames?.[kind]?.trim() || envVar?.trim();
    if (configured && this.promptBuilder.hasTemplate(configured)) {
      return configured;
    }

    const templates = this.promptBuilder.listTemplateNames();
    if (templates.length === 0) {
      throw new Error(`No prompt templates registered for ${kind} mode`);
    }

    if (kind === 'chat') {
      const conversation = templates.find((name) => name.includes('conversation'));
      if (conversation) return conversation;
    } else {
      const strategy = templates.find((name) => name.includes('strategy'));
      if (strategy) return strategy;
    }

    return templates[0]!;
  }

  private resolveRoutingTaskName(kind: 'analysis' | 'chat'): string {
    const envVar =
      kind === 'chat' ? process.env.DYNATRADER_CHAT_ROUTING_TASK : process.env.DYNATRADER_ANALYSIS_ROUTING_TASK;
    const configured = this.config.routingTaskNames?.[kind]?.trim() || envVar?.trim();
    if (configured) return configured;
    return kind === 'chat' ? 'chat' : 'analysis';
  }

  constructor(config: AgentCoreConfig) {
    this.config = config;
    this.stateMachine = new AgentStateMachine();
    this.conversation = new ConversationManager(config.conversationConfig, config.db);
    this.conversationConfig = config.conversationConfig;
    this.contextEngine = new ContextEngine(config.memory, config.contextConfig);
    this.budget = new IterationBudget({
      maxIterations: config.budgetConfig?.maxIterations || 50,
      maxTimeMs: config.budgetConfig?.maxTimeMs || 300_000,
      maxMemoryUsage: config.budgetConfig?.maxMemoryUsage || 100 * 1024 * 1024,
      maxApiCalls: config.budgetConfig?.maxApiCalls || 200,
      warningThreshold: 0.8,
      inactivityTimeoutMs: 120_000,
    });
    this.promptBuilder = new PromptBuilder();
    this.memoryWriter = config.memoryWriter ?? new MemoryWriter(config.memory);
    this.crossSessionRecall = config.crossSessionRecall ?? null;
    this.skillFactory = config.skillFactory ?? null;
    this.compactionEngine = config.compactionEngine;
    this.budgetTracker = new BudgetTracker({ contextWindowTokens: 128000 });
    this.postCompactionGuard = new PostCompactionGuard();
    this.recoveryManager = new RecoveryManager(config.recoveryConfig);
    this.intentRouter = config.intentRouter ?? new IntentRouter();
    this.sessionManager = config.sessionManager ?? new SessionManager(config.db);
    this.slashCommands = config.slashCommandRegistry ?? new SlashCommandRegistry();
    this.hooksManager = config.hooksManager ?? new HooksManager();
    this.goalManager = config.goalManager ?? new GoalManager();
    this.runCardManager = config.runCardManager ?? null;
    this.workspacePath = config.workspacePath ?? process.cwd();
    this.providerDoctor = config.providerDoctor ?? new ProviderDoctor();
    this.dreamEngine = config.dreamEngine ?? null;
    this.postTurnHooks = config.postTurnHooks ?? null;
    this.skillManager = config.skillManager ?? null;
    this.sessionSearch = config.sessionSearch ?? null;
    this.memoryConsolidation = config.memoryConsolidation ?? null;
    this.graduatedLoopDetector = config.graduatedLoopDetector ?? new GraduatedLoopDetector();
    this.turnController = config.turnController ?? null;
    this.steeringInbox = config.steeringInbox ?? null;
    this.reflectionRunner = config.reflectionRunner ?? null;
    this.durableTasks = config.durableTasks ?? null;
    this.daemonSessions = config.daemonSessions ?? null;
    this.agentMessaging = config.agentMessaging ?? null;
    this.continualHarness = config.continualHarness ?? null;
    this.memoryFabric = config.memoryFabric ?? null;
    this.maxParallelToolCalls = Math.min(config.maxParallelToolCalls ?? 4, 16);
    this.maxWaveSize = config.maxWaveSize;
    this.toolResultCompressor = config.toolResultCompressor ?? null;
    this.activeMemoryRecall = config.activeMemoryRecall ?? null;
    registerDefaultCommands(this.slashCommands);
    this.registerDelegationTool();
    this.registerSkillManageTool();
    this.registerToolResultRetriever();
    this.syncModelContextWindow();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private resolveSessionKey(sessionId?: string): string {
    return sessionId?.trim() || this.sessionManager.getActiveSession()?.id || "default";
  }

  private makeAgentContext(sessionId?: string): AgentTurnContext {
    const resolvedSessionId = this.resolveSessionKey(sessionId);
    return {
      now: new Date(),
      mode: this.config.defaultMode ?? "paper",
      accountId: resolvedSessionId,
      portfolioId: resolvedSessionId,
      correlationId: `chat-${Date.now()}`,
      sessionId: resolvedSessionId,
    };
  }

  private getConversation(sessionId?: string): ConversationManager {
    const key = this.resolveSessionKey(sessionId);
    if (key === "default") {
      return this.conversation;
    }
    const existing = this.conversationsBySession.get(key);
    if (existing) {
      return existing;
    }
    const created = new ConversationManager(this.conversationConfig);
    created.updateContextWindowTokens(this.conversation.getContextWindowTokens());
    this.conversationsBySession.set(key, created);
    return created;
  }

  private recordSessionMessage(sessionId: string | undefined, message: ConversationMessage): void {
    const key = this.resolveSessionKey(sessionId);
    if (key === "default") {
      return;
    }
    this.sessionManager.addMessageToSession(key, message);
  }

  private registerDelegationTool(): void {
    if (!this.config.toolRegistry || !this.config.delegateTask) return;
    this.config.toolRegistry.register({
      definition: {
        name: "delegate_task",
        description: "Delegate a concrete, independent sub-task to a sub-agent and return its result.",
        category: "session",
        inputSchema: { task: "string", agent: "string?", context: "object?" },
        outputSchema: { result: "object" },
        permissionsRequired: ["session.spawn"],
        sideEffects: ["spawns_agent"],
        riskLevel: "medium",
        timeoutMs: 120_000,
        canRunInParallel: true,
      },
      execute: async (call) => {
        const started = Date.now();
        const task = call.args.task;
        if (typeof task !== "string" || !task.trim()) {
          return { success: false, error: "task must be a non-empty string", durationMs: Date.now() - started, truncated: false };
        }
        try {
          const result = await this.config.delegateTask!({
            task: task.trim(),
            agent: typeof call.args.agent === "string" ? call.args.agent : undefined,
            context: call.args.context && typeof call.args.context === "object" ? call.args.context as Record<string, unknown> : undefined,
            sessionId: call.correlationId,
          });
          return { success: true, data: result, durationMs: Date.now() - started, truncated: false };
        } catch (error) {
          return { success: false, error: errorMessage(error), durationMs: Date.now() - started, truncated: false };
        }
      },
    });
  }

  private registerSkillManageTool(): void {
    if (!this.config.toolRegistry || !this.skillManager) return;
    this.config.toolRegistry.register({
      definition: {
        name: "skill_manage",
        description: "Create, patch, edit, or delete SKILL.md files. The agent evolves by updating its own skills.",
        category: "memory",
        inputSchema: {
          action: "string",
          skill_name: "string",
          patches: "array?",
          content: "string?",
          category: "string?",
          description: "string?",
        },
        outputSchema: { result: "object" },
        permissionsRequired: ["skills.write"],
        sideEffects: ["writes_files"],
        riskLevel: "low",
        timeoutMs: 30_000,
        canRunInParallel: false,
      },
      execute: async (call) => {
        const started = Date.now();
        const action = call.args.action as string;
        const skillName = call.args.skill_name as string;
        if (!skillName) {
          return { success: false, error: "skill_name is required", durationMs: Date.now() - started, truncated: false };
        }
        try {
          let result;
          switch (action) {
            case "patch": {
              const patches = call.args.patches as Array<{ old_string: string; new_string: string }>;
              if (!patches?.length) {
                return { success: false, error: "patches array required for patch action", durationMs: Date.now() - started, truncated: false };
              }
              result = await this.skillManager!.patchSkill(skillName, patches);
              break;
            }
            case "edit": {
              const content = call.args.content as string;
              if (!content) {
                return { success: false, error: "content required for edit action", durationMs: Date.now() - started, truncated: false };
              }
              result = await this.skillManager!.editSkill(skillName, { content });
              break;
            }
            case "create": {
              const content = call.args.content as string;
              if (!content) {
                return { success: false, error: "content required for create action", durationMs: Date.now() - started, truncated: false };
              }
              result = await this.skillManager!.createSkill(skillName, content, {
                category: call.args.category as string | undefined,
                description: call.args.description as string | undefined,
              });
              break;
            }
            case "delete":
              result = await this.skillManager!.deleteSkill(skillName);
              break;
            case "view":
              const viewResult = await this.skillManager!.viewSkill(skillName);
              return { success: true, data: viewResult, durationMs: Date.now() - started, truncated: false };
            case "list":
              const skills = await this.skillManager!.listSkills();
              return { success: true, data: skills, durationMs: Date.now() - started, truncated: false };
            default:
              return { success: false, error: `Unknown action: ${action}. Use patch, edit, create, delete, view, or list.`, durationMs: Date.now() - started, truncated: false };
          }
          return { success: true, data: result, durationMs: Date.now() - started, truncated: false };
        } catch (error) {
          return { success: false, error: errorMessage(error), durationMs: Date.now() - started, truncated: false };
        }
      },
    });
  }

  private registerToolResultRetriever(): void {
    const registry = this.config.toolRegistry as (typeof this.config.toolRegistry & {
      registerTool?: (handler: ToolHandler) => void;
    }) | undefined;
    if (!registry) return;
    const register = registry.register ?? registry.registerTool;
    if (typeof register !== "function") return;
    register.call(registry, {
      definition: {
        name: "get_tool_result",
        description: "Retrieve the full result of a previous tool call by its ID. Tool results are compressed in context — use this to see full output when needed.",
        category: "memory",
        inputSchema: { tool_call_id: "string" },
        outputSchema: { result: "object" },
        permissionsRequired: [],
        sideEffects: [],
        riskLevel: "low",
        timeoutMs: 5_000,
        canRunInParallel: true,
        readOnly: true,
      },
      execute: async (call) => {
        const started = Date.now();
        const id = call.args.tool_call_id as string;
        if (!id) {
          return { success: false, error: "tool_call_id is required", durationMs: Date.now() - started, truncated: false };
        }
        const cached = this.toolResultCache.get(id);
        if (!cached) {
          return { success: false, error: `No cached result for tool call ${id}. It may have been evicted.`, durationMs: Date.now() - started, truncated: false };
        }
        return { success: true, data: { tool: cached.tool, args: cached.args, result: cached.result }, durationMs: Date.now() - started, truncated: false };
      },
    });
  }

  private activeGoal(sessionId?: string): ResearchGoal | undefined {
    const id = sessionId ?? "default";
    return this.goalManager.listGoals(id).find((goal) => goal.status === "active");
  }

  /**
   * The self-continuing goal loop (/goal). Created lazily per agent instance;
   * the post-turn hook evaluates it after each turn.
   */
  getGoalLoop(): GoalLoopManager {
    if (!this.goalLoop) this.goalLoop = new GoalLoopManager();
    return this.goalLoop;
  }

  private goalLoop?: GoalLoopManager;

  private async getPersonaPrompt(persona: string): Promise<string> {
    if (this.personaCache.has(persona)) {
      return this.personaCache.get(persona)!;
    }
    const personaPath = path.join(this.workspacePath, 'personas', `${persona}.md`);
    try {
      const content = await fs.readFile(personaPath, 'utf-8');
      this.personaCache.set(persona, content.trim());
      this.evictOldest(this.personaCache, 50);
      return content.trim();
    } catch {
      return '';
    }
  }

  private goalPrompt(sessionId?: string): string {
    const goal = this.activeGoal(sessionId);
    if (!goal) return "";
    const goalLines: string[] = [
      "",
      `ACTIVE GOAL: ${goal.title}`,
      goal.description,
    ];

    if (goal.claims.length > 0) {
      goalLines.push("Claims:");
      for (const claim of goal.claims) {
        goalLines.push(`- [${claim.status}] ${claim.statement}`);
      }
    }

    const steps = this.goalManager.listSteps(goal.id);
    if (steps.length > 0) {
      const progress = this.goalManager.getGoalProgress(goal.id);
      goalLines.push(`Steps: ${progress.completed}/${progress.total} completed (${progress.percentComplete}%)`);
      const nextSteps = this.goalManager.getNextSteps(goal.id);
      if (nextSteps.length > 0) {
        goalLines.push("Next available steps:");
        for (const step of nextSteps) {
          goalLines.push(`- [${step.status}] ${step.title}: ${step.description}`);
        }
      }
      const currentSteps = steps.filter((s) => s.status === "in_progress");
      if (currentSteps.length > 0) {
        goalLines.push("Currently in progress:");
        for (const step of currentSteps) {
          goalLines.push(`- ${step.title}: ${step.description}`);
        }
      }
    }

    goalLines.push("Keep work aligned with this goal and its remaining budget.");
    return `\n\n${goalLines.join("\n")}`;
  }

  private planningPrompt(sessionId?: string): string {
    const id = sessionId ?? this.sessionManager.getActiveSession()?.id ?? "default";
    const planning = this.planningSessions.get(id);
    if (!planning) return "";
    return `A READ-ONLY PLAN REQUEST IS ACTIVE${planning.goal ? ` for: ${planning.goal}` : ""}.
Explore the repository and design an implementation plan. You are strictly read-only: do not edit files, write memory, execute mutations, or change external state. Use only the read-only tools provided. Return a concrete Markdown plan with a title, short description, and ordered actionable steps including relevant file paths, dependencies, verification, and risks. Do not claim that implementation has occurred.`;
  }

  private recordGoalUsage(sessionId: string | undefined, usage: { totalTokens?: number }, toolCalls = 0): void {
    const goal = this.activeGoal(sessionId);
    if (!goal) return;
    this.goalManager.incrementBudget(goal.id, "currentTurns");
    if (toolCalls > 0) this.goalManager.incrementBudget(goal.id, "currentToolCalls", toolCalls);
    if (usage.totalTokens) this.goalManager.incrementBudget(goal.id, "currentTokens", usage.totalTokens);
  }

  private async createRunCard(
    context: AgentTurnContext,
    source: StrategySource,
    sessionId?: string,
  ): Promise<string | null> {
    if (!this.runCardManager) return null;

    const runCard = await this.runCardManager.createRunCard({
      mode: context.mode as "research" | "backtest" | "paper" | "shadow" | "micro_live" | "live",
      SkillManifestId: undefined,
      hypothesisId: source.kind === "llm-plan" ? source.body.slice(0, 64) : undefined,
      agentName: sessionId ?? context.accountId,
    });
    await this.runCardManager.startRun(runCard.runId);
    return runCard.runId;
  }

  private async finalizeRunCard(
    runId: string | null,
    params: {
      verdict: "reject" | "revise" | "retest" | "promote" | "hold";
      metrics: Record<string, unknown>;
      summary: string;
      artifact?: unknown;
      artifactType?: string;
    },
  ): Promise<void> {
    if (!runId || !this.runCardManager) return;

    const artifacts: string[] = [];
    if (params.artifact !== undefined) {
      const artifactPath = await this.runCardManager.addArtifact(runId, params.artifact, params.artifactType ?? "RunSnapshot");
      artifacts.push(artifactPath);
    }
    await this.runCardManager.completeRun(runId, {
      verdict: params.verdict,
      metrics: params.metrics,
      summary: params.summary,
      artifacts,
    });
  }

  private async rejectRunCard(runId: string | null, reason: string): Promise<void> {
    if (!runId || !this.runCardManager) return;
    await this.runCardManager.rejectRun(runId, reason);
  }

  private async writeLoopDiagnosticSnapshot(
    sessionId: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<string | null> {
    const diagnosticsDir = path.join(this.workspacePath, "workspace", "diagnostics");
    await fs.mkdir(diagnosticsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = path.join(diagnosticsDir, `loop-${sessionId ?? "default"}-${stamp}.json`);
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
    return filePath;
  }

  private async recordLoopEvidence(sessionId: string | undefined, content: string, severity: string): Promise<void> {
    const goal = this.activeGoal(sessionId);
    if (!goal || goal.claims.length === 0) return;
    const claim = goal.claims[0];
    if (!claim) return;
    try {
      this.goalManager.addEvidence(goal.id, claim.id, {
        claimId: claim.id,
        source: "agent-core",
        content,
        confidence: severity === "halt" ? 0.95 : severity === "critical" ? 0.8 : 0.65,
        toolUsed: "loop-engine",
      });
    } catch {
      // Ignore evidence failures; loop handling must not fail the turn.
    }
  }

  private async buildMemoryContext(message: string): Promise<string> {
    const memories = await this.contextEngine.getRelevantMemories(message, 10);
    const memoryContext = memories
      .map((m) => `[${m.type}] ${JSON.stringify(m.content).substring(0, 200)}...`)
      .join("\n");

    return memoryContext;
  }

  private async ensureContext(sessionId?: string): Promise<AgentTurnContext> {
    const key = this.resolveSessionKey(sessionId);
    const existing = this.contextsBySession.get(key);
    if (existing) {
      this.currentContext = existing;
      return existing.current;
    }

    const ctx = this.makeAgentContext(key);
    const created = await this.contextEngine.createContext(ctx);
    this.contextsBySession.set(key, created);
    this.currentContext = created;
    return created.current;
  }

  private syncModelContextWindow(): void {
    const modelRouter = this.config.modelRouter;
    if (!modelRouter?.getContextWindowTokens) {
      return;
    }

    const activeModel = modelRouter.getActiveModel?.();
    const contextWindowTokens = modelRouter.getContextWindowTokens(activeModel);
    if (!contextWindowTokens || contextWindowTokens <= 0) {
      return;
    }

    this.conversation.updateContextWindowTokens(contextWindowTokens);
    for (const conversation of this.conversationsBySession.values()) {
      conversation.updateContextWindowTokens(contextWindowTokens);
    }
    this.budgetTracker.updateContextWindowTokens(contextWindowTokens);
    this.contextEngine.updateContextWindowTokens(contextWindowTokens);
    this.compactionEngine?.updateConfig({ maxContextTokens: contextWindowTokens });
  }

  private buildToolDefinitions(sessionId?: string, allowTools = true): ToolDefinition[] {
    if (!allowTools) return [];
    if (!this.config.toolRegistry) return [];

    // Resolve active profiles (core profiles always included)
    const profiles = resolveProfiles(this.config.activeProfiles);
    const allowedToolNames = this.config.activeProfiles?.length
      ? new Set(getToolsForProfiles(profiles))
      : undefined;

    // Get all registered tools, then filter by profile + policy
    const definitions = this.config.toolRegistry.list()
      .filter((h) => !allowedToolNames || allowedToolNames.has(h.definition.name))
      .map((h) => h.definition);

    const id = sessionId ?? this.sessionManager.getActiveSession()?.id ?? "default";
    const policy = this.toolPolicies.get(id) ?? this.toolPolicies.get("default");
    let filtered = policy
      ? definitions.filter((definition) =>
          (!policy.allowed || policy.allowed.has(definition.name)) && !policy.disallowed.has(definition.name))
      : definitions;
    if (this.planningSessions.has(id)) {
      filtered = filtered.filter((definition) => definition.readOnly === true && definition.name !== 'get_tool_result');
    }
    return filtered;
  }

  private estimateRequestTokens(messages: ModelRequest["messages"]): number {
    try {
      const modelRouter = this.config.modelRouter;
      const activeModel = modelRouter?.getActiveModel?.() ?? "gpt-4";
      const enc = encoding_for_model(activeModel as any);
      let total = 0;
      for (const msg of messages) {
        total += enc.encode(msg.content ?? "").length;
        if ((msg as any).tool_calls) {
          total += enc.encode(JSON.stringify((msg as any).tool_calls)).length;
        }
      }
      enc.free();
      return total;
    } catch {
      const serialized = JSON.stringify(messages);
      return Math.max(0, Math.ceil(serialized.length / 4));
    }
  }

  private resolveChatMaxTokens(promptFootprintTokens: number, override?: number): number {
    if (Number.isFinite(override) && (override as number) > 0) {
      return Math.floor(override as number);
    }

    const contextWindow = this.getContextWindowTokens();
    if (!Number.isFinite(contextWindow) || (contextWindow ?? 0) <= 0) {
      return 4096;
    }

    const window = Math.floor(contextWindow ?? 0);
    const promptFootprint = Math.max(0, Math.floor(promptFootprintTokens));
    const reserve = Math.max(1024, Math.floor(window * 0.08));
    const available = Math.max(0, window - promptFootprint - reserve);
    const softCap = Math.max(1024, Math.floor(window * 0.5));
    const maxTokens = Math.min(available, softCap);
    return Math.max(512, Math.min(32768, maxTokens));
  }

  private async executeToolLoop(
    messages: ModelRequest["messages"],
    tools: ToolDefinition[],
    maxTokens?: number,
    sessionId?: string,
  ): Promise<{ content: string; reasoningContent?: string; toolCallResults: NonNullable<ChatResponse["toolCalls"]>; usage: ChatResponse["usage"] }> {
    const toolCallResults: NonNullable<ChatResponse["toolCalls"]> = [];
    const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let content = "";
    let reasoningContent: string | undefined;
    const modelRouter = this.config.modelRouter;
    if (!modelRouter) return { content: "Model router not configured.", reasoningContent, toolCallResults, usage };

    for (let turn = -1; turn < (this.config.maxToolTurns ?? 12); turn++) {
      this.syncModelContextWindow();
      if (this.cancelRequested) break;
      if (!this.budget.canStartIteration()) break;
      this.graduatedLoopDetector.resetForStep();
      // Drain mid-turn steering messages
      if (this.steeringInbox) {
        const steeringNotices = this.steeringInbox.drain();
        if (steeringNotices) {
          messages.push({ role: "system", content: steeringNotices });
        }
      }

      const promptFootprintTokens = this.estimateRequestTokens(messages);
      const request: ModelRequest = {
        messages, tools: tools.length > 0 ? tools : undefined,
        maxTokens: this.resolveChatMaxTokens(promptFootprintTokens, maxTokens),
        temperature: 0.3,
      };

      let response;
      try {
        // Pre-LLM-call hooks
        const preLlmResult = await this.hooksManager.run('pre-llm-call', { messages, tools });
        if (!preLlmResult.continue) {
          content = "(LLM call blocked by hook)";
          break;
        }
        response = await modelRouter.call(request, this.resolveRoutingTaskName('analysis'));
        this.recoveryManager.recordSuccess();
        reasoningContent = response.reasoningContent?.trim() || reasoningContent;
      } catch (error) {
        const action = this.recoveryManager.recordFailure((error as Error).message);
        // On-error hooks
        await this.hooksManager.run('on-error', { error: error instanceof Error ? error.message : "Unknown error" });
        if (action.action === 'fatal') {
          throw new Error(`Recovery exhausted: ${action.description}`);
        }
        // Apply recovery action
        if (action.action === 'fallback_model' || action.action === 'lightweight_model') {
          request.model = action.modelOverride;
        }
        if (action.action === 'strip_thinking') {
          // Remove thinking blocks from messages
          messages = messages.map(m => {
            if (m.role === 'assistant' && m.content) {
              return { ...m, content: m.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim() };
            }
            return m;
          });
          request.messages = messages;
        }
        if (action.action === 'soft_reset') {
          // Keep system message + last N messages
          const systemMsg = messages[0];
          const recentMsgs = messages.slice(-this.recoveryManager.getState().consecutiveFailures > 3 ? 20 : messages.length);
          messages = systemMsg ? [systemMsg, ...recentMsgs] : recentMsgs;
          request.messages = messages;
        }
        // Jittered backoff before retry
        this.syncModelContextWindow();
        const consecutiveFailures = this.recoveryManager.getState().consecutiveFailures;
        const backoffMs = Math.min(100 * Math.pow(2, consecutiveFailures) + Math.random() * 1000, 30000);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        // Retry with the same call
        response = await modelRouter.call(request, this.resolveRoutingTaskName('analysis'));
        this.recoveryManager.recordSuccess();
        reasoningContent = response.reasoningContent?.trim() || reasoningContent;
      }

      // Post-LLM-call hooks
      await this.hooksManager.run('post-llm-call', response);

      this.budget.recordApiCall();
      if (response.usage) {
        usage.promptTokens += response.usage.promptTokens;
        usage.completionTokens += response.usage.completionTokens;
        usage.totalTokens += response.usage.totalTokens;
      }

      // === RISK GATE ===
      // Programmatic enforcement of risk limits. The model may propose
      // leverage or position sizes that exceed configured limits. This
      // gate rejects such proposals before they reach tool execution.
      if (this.config.riskGate && response.content) {
        const rg = this.config.riskGate;
        const text = response.content;

        // Leverage check: reject proposals exceeding max leverage
        if (rg.maxLeverage != null) {
          const levMatch = text.match(/(\d+)x?\s*(?:leverage|lev)/i);
          if (levMatch) {
            const proposed = parseInt(levMatch[1]);
            if (proposed > rg.maxLeverage) {
              const rejection = `REJECTED: Your proposal of ${proposed}x leverage exceeds the configured limit of ${rg.maxLeverage}x. Resubmit with leverage capped at ${rg.maxLeverage}x.`;
              if (this.steeringInbox) {
                this.steeringInbox.deliver({ content: rejection, source: 'system', priority: 'high' });
              }
              response.toolCalls = undefined;
              content = rejection;
              break;
            }
          }
        }

        // Position size check: reject proposals exceeding max position %
        if (rg.maxPositionPct != null) {
          const sizeMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:%|percent)/);
          if (sizeMatch) {
            const proposed = parseFloat(sizeMatch[1]);
            if (proposed > rg.maxPositionPct) {
              const rejection = `REJECTED: Your proposed position of ${proposed}% exceeds the configured limit of ${rg.maxPositionPct}%. Resubmit with position capped at ${rg.maxPositionPct}%.`;
              if (this.steeringInbox) {
                this.steeringInbox.deliver({ content: rejection, source: 'system', priority: 'high' });
              }
              response.toolCalls = undefined;
              content = rejection;
              break;
            }
          }
        }
      }

      // Check if we should force tool use
      const intentRoute = this.intentRouter.getLastRoute();
      const shouldForceTools = tools.length > 0 && !response.toolCalls?.length && turn <= 0 &&
        (intentRoute?.useTools === true || !normalizeVisibleText(response.content));

      if (response.toolCalls?.length) {
        // Normal tool call path — continue
      } else if (response.content?.trim() && !shouldForceTools) {
        content = response.content.trim();
        break;
      } else if (shouldForceTools) {
        // Retry with forced tool use
        const retryRequest: ModelRequest = {
          ...request,
          messages: [
            ...request.messages,
            { role: "assistant", content: response.content ?? null, tool_calls: response.toolCalls },
            { role: "user", content: "[System] You MUST use a tool to answer this. Do not respond with plain text. Select and call the appropriate tool." },
          ],
        };
        const retryResponse = await modelRouter.call(retryRequest, this.resolveRoutingTaskName('analysis'));
        this.budget.recordApiCall();
        if (retryResponse.toolCalls?.length) {
          // Use retry response
          response.toolCalls = retryResponse.toolCalls;
          response.content = retryResponse.content;
          response.reasoningContent = retryResponse.reasoningContent ?? response.reasoningContent;
          if (retryResponse.usage) {
            usage.promptTokens += retryResponse.usage.promptTokens;
            usage.completionTokens += retryResponse.usage.completionTokens;
            usage.totalTokens += retryResponse.usage.totalTokens;
          }
        } else {
          // Still no tools — require a real visible response
          content = retryResponse.content?.trim() || response.content?.trim() || "";
          if (!normalizeVisibleText(content)) {
            throw new Error("Model returned no visible output.");
          }
          break;
        }
      } else {
        content = response.content?.trim() || "";
        if (!normalizeVisibleText(content)) {
          throw new Error("Model returned no visible output.");
        }
        break;
      }

      messages.push({ role: "assistant", content: null, tool_calls: response.toolCalls });
      this.stateMachine.transition("tool_executing");

      // Build tool calls
      const toolCalls: ToolCall[] = response.toolCalls.map(tc => ({
        tool: tc.function.name, args: JSON.parse(tc.function.arguments),
        id: tc.id, correlationId: `chat-${Date.now()}`,
      }));

      // Pre-tool-call hooks
      for (const toolCall of toolCalls) {
        const hookResult = await this.hooksManager.run('pre-tool-call', toolCall);
        if (!hookResult.continue) {
          if (!content) content = "(Tool call blocked by hook)";
          break;
        }
      }
      if (content) break;

      const authorization = await this.partitionApprovedToolCalls(toolCalls);
      for (const { call: toolCall, result } of authorization.denied) {
        toolCallResults.push({ tool: toolCall.tool, args: toolCall.args, result, durationMs: result.durationMs });
        messages.push({ role: "tool", tool_call_id: toolCall.id!, content: JSON.stringify(result) });
      }
      if (authorization.approved.length === 0) {
        this.stateMachine.transition("running");
        continue;
      }

      // Build resource-class-aware batch inputs
      const batchInputs: BatchCallInput[] = authorization.approved.map((call, batchIndex) => ({
        batchIndex,
        call,
            resourceClass: resourceClassFor(call.tool, this.config.toolRegistry!.get?.(call.tool)?.definition),
      }));

      // Execute with resource-class-aware parallelism + graduated loop detection
      this.graduatedLoopDetector.resetForStep();
      const batchResult = await executeBatch(batchInputs, this.config.toolRegistry!, {
        sessionId: sessionId ?? "default",
        stepIndex: turn,
        signal: AbortSignal.timeout(this.config.budgetConfig?.maxTimeMs ?? 300_000),
        tracker: this.graduatedLoopDetector,
        maxWaveSize: this.maxWaveSize,
      });
      this.budget.recordApiCall();

      // === COMPRESS STEP (Atomic Agent pattern) ===
      // Compress tool results before feeding back to LLM
      const validResults = batchResult.results
        .filter((slot): slot is typeof slot & { result: NonNullable<typeof slot.result> } =>
          !slot.cancelled && !!slot.result
        )
        .map((slot, i) => ({
          tool: authorization.approved[slot.batchIndex]!.tool,
          args: authorization.approved[slot.batchIndex]!.args,
          result: slot.result,
          durationMs: slot.durationMs,
          id: authorization.approved[slot.batchIndex]!.id,
        }));

      if (this.toolResultCompressor && validResults.length > 0) {
        // Use hybrid compressor (SmartCrusher + LLM)
        const llmCaller = this.config.modelRouter
          ? async (prompt: string) => {
              const resp = await this.config.modelRouter!.call(
                { messages: [{ role: "user", content: prompt }], maxTokens: 600 },
                this.resolveRoutingTaskName('analysis'),
              );
              return resp.content ?? "";
            }
          : undefined;
        const compressed = await this.toolResultCompressor.compressResults(validResults, llmCaller);
        const toolMessages = this.toolResultCompressor.buildPromptMessages(compressed);
        for (const msg of toolMessages) {
          messages.push(msg);
        }
        // Also store in cache for tool result retrieval
        for (const r of validResults) {
          if (r.id) {
            this.toolResultCache.set(r.id, { tool: r.tool, args: r.args, result: r.result });
            this.evictOldest(this.toolResultCache, 100);
          }
        }
      } else {
        // Fallback: Original truncation behavior (no compressor)
        for (const slot of batchResult.results) {
          if (slot.cancelled || !slot.result) continue;
          const toolCall = authorization.approved[slot.batchIndex]!;
          toolCallResults.push({ tool: toolCall.tool, args: toolCall.args, result: slot.result, durationMs: slot.durationMs });
          if (toolCall.id) {
            this.toolResultCache.set(toolCall.id, { tool: toolCall.tool, args: toolCall.args, result: slot.result });
            this.evictOldest(this.toolResultCache, 100);
          }
          const summary = slot.result.success
            ? (typeof slot.result.data === 'string' ? slot.result.data.slice(0, 200) : JSON.stringify(slot.result.data)?.slice(0, 200) ?? 'OK')
            : `ERROR: ${slot.result.error ?? 'unknown'}`;
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id!,
            content: `[${toolCall.tool}] ${summary}${slot.result.truncated ? ' (truncated)' : ''} | id:${toolCall.id}`,
          });
        }
      }

      // Post-tool-call hooks
      for (const slot of batchResult.results) {
        if (slot.cancelled || !slot.result) continue;
        const toolCall = authorization.approved[slot.batchIndex]!;
        await this.hooksManager.run('post-tool-call', { toolCall, result: slot.result });
      }

      // Doom loop detection: track consecutive identical tool+args combinations
      for (const tc of toolCalls) {
        const argsHash = stableStringify(tc.args);
        const last = this.doomLoopHistory[this.doomLoopHistory.length - 1];
        if (last && last.tool === tc.tool && last.argsHash === argsHash) {
          this.doomLoopHistory.push({ tool: tc.tool, argsHash });
        } else {
          this.doomLoopHistory = [{ tool: tc.tool, argsHash }];
        }
      }
      if (this.doomLoopHistory.length >= AgentCore.DOOM_LOOP_THRESHOLD) {
        const repeatTool = this.doomLoopHistory[0].tool;
        content = `(Doom loop detected: "${repeatTool}" called ${this.doomLoopHistory.length} times with identical arguments. Stopping to prevent infinite repetition.)`;
        this.doomLoopHistory = [];
        break;
      }

      // Broadcast tool results to other agents via AgentMessaging
      if (this.agentMessaging && sessionId) {
        for (const tc of toolCalls) {
          const result = batchResult.results.find((r) => !r.cancelled && r.result);
          if (result?.result) {
            this.agentMessaging.broadcast(sessionId, 'tool.result', {
              tool: tc.tool,
              args: tc.args,
              summary: result.result.success
                ? (typeof result.result.data === 'string' ? result.result.data.slice(0, 500) : JSON.stringify(result.result.data)?.slice(0, 500) ?? 'OK')
                : `ERROR: ${result.result.error ?? 'unknown'}`,
            });
          }
        }
      }

      // Handle loop signals
      let pendingLoopNotice: string | undefined;
      for (const signal of batchResult.loopSignals) {
        if (signal.level === "breaker") {
          const replyText = formatForcedLoopReply(signal.tool, signal.count);
          content = replyText;
          this.graduatedLoopDetector.reset();
          break;
        }
        if (signal.level === "warn" && this.graduatedLoopDetector.shouldEmitWarning(signal.warningKey, signal.count)) {
          pendingLoopNotice = signal.detector === "wandering"
            ? formatWanderingRedirect(signal.tool, signal.count)
            : formatRepeatNotice(signal);
        }
      }
      if (content) break;

      // Inject loop notice into next step if present
      if (pendingLoopNotice) {
        messages.push({ role: "system", content: pendingLoopNotice });
      }

      this.stateMachine.transition("running");

      // Loop detection (composite batch check — graduated detector handles per-tool in batch-executor)
      const batchVerdict = this.graduatedLoopDetector.observeBatchComposite(
        toolCalls.map(tc => ({ tool: tc.tool, args: tc.args })),
        batchResult.results.filter(r => r.result).map(r => r.result!),
      );
      if (batchVerdict.level === "critical" || batchVerdict.level === "breaker") {
        if (!content) content = `(Loop detected after ${turn + 1} turns. Stopped to prevent infinite tool calling.)`;
        break;
      }
    }

    if (!normalizeVisibleText(content)) {
      throw new Error("Model returned no visible output.");
    }
    return { content, reasoningContent, toolCallResults, usage };
  }

  private async runCompaction(sessionId?: string): Promise<boolean> {
    let compacted = false;
    const conversation = this.getConversation(sessionId);
    if (conversation.shouldCompact()) {
      this.stateMachine.transition("compacting");
      const summary = conversation.compact();
      compacted = summary.length > 0;
      const guard = this.postCompactionGuard.check(conversation.getMessages());
      if (guard.stuck) {
        conversation.addMessage({
          role: "system",
          content: guard.message,
          timestamp: new Date(),
        });
        await this.writeLoopDiagnosticSnapshot(sessionId, {
          reason: "post_compaction_guard",
          repeatedCount: guard.repeatedCount,
          pattern: guard.pattern,
          timestamp: new Date().toISOString(),
        });
      }
      this.stateMachine.transition("running");
    }
    if (this.compactionEngine) {
      const ctx = this.makeAgentContext(sessionId);
      const memoryContext = await this.buildMemoryContext("");
      const contextMessages = buildContextMessages(ctx, memoryContext);
      if (this.compactionEngine.shouldAutoCompact(contextMessages)) {
        const result = await this.compactionEngine.autoCompact(contextMessages);
        console.info(`Auto-compaction: ${result.tokensSaved} tokens saved (${(result.compressionRatio * 100).toFixed(1)}%, ${result.messagesRemoved} compressed)`);
        compacted = true;
      }
    }
    return compacted;
  }

  private safeTransition(state: AgentState): void {
    try {
      this.stateMachine.transition(state);
    } catch (error) {
      const message = errorMessage(error);
      throw new Error(`Agent state recovery failed while transitioning to ${state}: ${message}`);
    }
  }

  private markDreamLoopCompleted(triggerDreamCycle: boolean | undefined): void {
    if (triggerDreamCycle === false || !this.dreamEngine) {
      return;
    }
    const maybeMarker = this.dreamEngine as unknown as { markLoopCompleted?: () => void };
    maybeMarker.markLoopCompleted?.();
  }

  // -------------------------------------------------------------------------
  // Slash command handling
  // -------------------------------------------------------------------------

  /**
   * Process a slash command if the input starts with /
   * Returns the command result if it was a slash command, null otherwise.
   */
  async processSlashCommand(input: string): Promise<CommandResult | null> {
    if (!input.startsWith("/")) return null;

    const context: CommandContext = {
      agent: this,
      sessionManager: this.sessionManager,
      modelRouter: this.config.modelRouter,
      toolRegistry: this.config.toolRegistry,
      memory: this.config.memory,
      skillFactory: this.skillFactory,
      dreamEngine: this.dreamEngine,
      getConversationHistory: () => this.getConversationHistory(),
      clearConversation: () => this.clearConversation(),
    };

    return this.slashCommands.execute(input, context);
  }

  deliverSteering(message: Omit<SteeringMessage, "id" | "timestamp">): boolean {
    if (!this.steeringInbox) return false;
    return this.steeringInbox.deliver(message);
  }

  // -------------------------------------------------------------------------
  // Public API - chat (non-streaming)
  // -------------------------------------------------------------------------

  async chat(message: string, options?: ChatOptions): Promise<ChatResponse> {
    const sessionKey = this.resolveSessionKey(options?.sessionId);
    const runChat = async (): Promise<ChatResponse> => {
      return this.chatInternal(message, options, sessionKey);
    };

    if (this.turnController) {
      return this.turnController.enqueue({
        sessionId: sessionKey,
        origin: (options as Record<string, unknown>)?.origin as TurnOrigin ?? "cli",
        run: runChat,
      });
    }
    return runChat();
  }

  private async chatInternal(message: string, options: ChatOptions | undefined, sessionKey: string): Promise<ChatResponse> {
    const startTime = Date.now();
    const templateName = this.resolveTemplateName('chat', options?.templateName);
    const conversation = this.getConversation(options?.sessionId);
    if (sessionKey !== "default") {
      this.sessionManager.ensureSession(sessionKey);
    }
    this.safeTransition("starting");
    this.syncModelContextWindow();
    conversation.addMessage({ role: "user", content: message, timestamp: new Date() });
    this.recordSessionMessage(options?.sessionId, { role: "user", content: message, timestamp: new Date() });
    if (this.memoryFabric) this.memoryFabric.recordMessage("user", message);
    this.graduatedLoopDetector.reset();

    // Check for slash commands first — they bypass the LLM entirely
    const slashResult = await this.processSlashCommand(message);
    if (slashResult) {
      this.markDreamLoopCompleted(options?.triggerDreamCycle);
      this.safeTransition("stopping");
      this.safeTransition("idle");
      return {
        content: slashResult.content,
        state: "idle",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        durationMs: Date.now() - startTime,
        compacted: false,
        metadata: slashResult.metadata,
      };
    }

    this.stateMachine.transition("running");

    try {
      const agentCtx = await this.ensureContext(options?.sessionId);
      const memoryContext = await this.buildMemoryContext(message);
      const source: StrategySource = { kind: "llm-plan", body: message };

      // Classify intent and adjust prompt
      const intentRoute = this.intentRouter.classify(message);
      const routeGuidance = this.intentRouter.getRouteGuidance(intentRoute);

      const { system, user, constraints } = this.promptBuilder.buildPrompt(
        templateName, agentCtx, memoryContext, source, this.budget, 1, 1,
      );

      // Append intent guidance and anti-narration rules to system prompt
      // If the active session has a persona set, use it as the primary workspace prompt
      const activeSession = this.sessionManager.getSession(options?.sessionId);
      const sessionPersona = activeSession?.metadata?.persona;
      let workspaceGuidance: string;
      if (sessionPersona) {
        const personaContent = await this.getPersonaPrompt(sessionPersona);
        workspaceGuidance = personaContent
          ? `\n\n=== PERSONA: ${sessionPersona} ===\n${personaContent}\n\n=== WORKSPACE INSTRUCTIONS ===\n${this.config.workspacePrompt ?? ''}`
          : `\n\n=== WORKSPACE INSTRUCTIONS ===\n${this.config.workspacePrompt ?? ''}`;
      } else {
        workspaceGuidance = this.config.workspacePrompt
          ? `\n\n=== WORKSPACE INSTRUCTIONS ===\n${this.config.workspacePrompt}`
          : "";
      }
      const loopGuidance = this.graduatedLoopDetector.getOutputLoopGuidance();
      const toolLoopGuard = `\n\nTOOL LOOP GUARD:\n- Do not repeat identical tool calls with the same arguments.\n- If progress stalls, change the approach or stop and summarize the blocker.\n${loopGuidance ? `\n${loopGuidance}\n` : ""}`;

      // Drain pending inter-agent messages and inject into context
      let interAgentContext = '';
      if (this.agentMessaging && options?.sessionId) {
        const pending = this.agentMessaging.drainPending(options.sessionId);
        if (pending.length > 0) {
          const msgLines = pending.map((m) => `[${m.fromSessionId} → ${m.toSessionId}] ${m.topic}: ${JSON.stringify(m.payload).slice(0, 300)}`);
          interAgentContext = `\n\nINTER-AGENT MESSAGES (from other agents):\n${msgLines.join('\n')}`;
        }
      }

      // ContinualHarness: inject supplemental prompts from past lessons
      let supplementalPrompts = '';
      if (this.continualHarness) {
        const prompts = this.continualHarness.getSupplementalPrompts({
          sessionId: options?.sessionId,
        });
        if (prompts.length > 0) {
          supplementalPrompts = `\n\nLESSONS FROM PAST SESSIONS:\n${prompts.join('\n')}`;
        }
      }

      // Pre-reply memory recall (OpenClaw active memory pattern)
      // Search memory BEFORE the model generates a reply, not after
      let activeRecallContext = '';
      if (this.activeMemoryRecall) {
        const recallResult = await this.activeMemoryRecall.recallBeforeReply(message);
        if (recallResult.count > 0) {
          activeRecallContext = recallResult.context;
        }
      }

      const promptLayers = promptAssembly.assemble({
        stable: [system, workspaceGuidance, routeGuidance, ANTI_NARRATION_RULES],
        context: [this.goalPrompt(options?.sessionId), this.planningPrompt(options?.sessionId)],
        volatile: [toolLoopGuard, interAgentContext, supplementalPrompts, activeRecallContext],
        currentContext: agentCtx,
      });
      this.budgetTracker.update("stable", promptLayers.tiers.find((tier) => tier.name === "stable")?.tokens ?? 0);
      this.budgetTracker.update("context", promptLayers.tiers.find((tier) => tier.name === "context")?.tokens ?? 0);
      this.budgetTracker.update("volatile", promptLayers.tiers.find((tier) => tier.name === "volatile")?.tokens ?? 0);
      if (this.budgetTracker.shouldWarn()) {
        console.warn("Prompt budget warning", this.budgetTracker.getSnapshot());
      }
      const systemWithGuidance = promptLayers.systemPrompt;

      const convMessages = conversation.getMessagesForRequest();
      const messages: ModelRequest["messages"] = [
        { role: "system", content: systemWithGuidance + "\n\n" + (constraints?.join("\n") ?? "") },
      ];
      for (const msg of convMessages.slice(0, -1)) {
        messages.push({ role: msg.role as any, content: msg.content, tool_calls: msg.tool_calls, tool_call_id: msg.tool_call_id });
      }
      messages.push({ role: "user", content: user });

      let { content, reasoningContent, toolCallResults, usage } = await this.executeToolLoop(
        messages,
        this.buildToolDefinitions(options?.sessionId, options?.allowTools ?? true),
        options?.maxTokens,
        sessionKey,
      );
      this.recordGoalUsage(options?.sessionId, usage, toolCallResults.length);

      // Auto-advance step-based goals
      const active = this.activeGoal(options?.sessionId);
      if (active) {
        const advance = this.goalManager.autoAdvance(active.id);
        if (advance.advanced && advance.nextSteps.length > 0) {
          const nextStepTitles = advance.nextSteps.map((s) => `"${s.title}"`).join(", ");
          const advanceNote = `[Goal auto-advanced. Next step(s) ready: ${nextStepTitles}]`;
          conversation.addMessage({ role: "system", content: advanceNote, timestamp: new Date() });
        }
      }

      conversation.addMessage({ role: "assistant", content, timestamp: new Date() });
      this.recordSessionMessage(options?.sessionId, { role: "assistant", content, timestamp: new Date() });
      if (this.memoryFabric) this.memoryFabric.recordMessage("assistant", content);
      const loopSeverity = this.graduatedLoopDetector.recordOutput(content);
      if (loopSeverity === "halt") {
        await this.writeLoopDiagnosticSnapshot(options?.sessionId, {
          reason: "halt",
          content,
          usage,
          toolCalls: toolCallResults,
          timestamp: new Date().toISOString(),
        });
        await this.recordLoopEvidence(options?.sessionId, content, loopSeverity);
        content = "(Loop detected and circuit breaker engaged. The agent repeated the same output too many times.)";
      }
      const compacted = await this.runCompaction(options?.sessionId);

      this.markDreamLoopCompleted(options?.triggerDreamCycle);
      this.safeTransition("stopping");
      this.safeTransition("idle");

      // Goal loop: if active, evaluate the response and feed the continuation
      // prompt back into the conversation as the next user turn.
      const goalLoop = this.getGoalLoop();
      if (goalLoop.isActive()) {
        const decision = goalLoop.evaluateAfterTurn(content);
        if (decision.continuationPrompt) {
          conversation.addMessage({ role: "user", content: decision.continuationPrompt, timestamp: new Date() });
          this.recordSessionMessage(options?.sessionId, { role: "user", content: decision.continuationPrompt, timestamp: new Date() });
        }
        content = `${content}\n\n[${decision.message}]`;
      }

      // Fire reflection runner — lightweight end-of-turn memory extraction
      if (this.reflectionRunner) {
        const reflection = this.reflectionRunner.addPair(message, content);
        if (reflection && reflection.notes.length > 0) {
          for (const note of reflection.notes) {
            try {
              if (this.memoryFabric) {
                await this.memoryFabric.writeNote(
                  note.type,
                  note.content,
                  { confidence: note.confidence, turnNumber: note.sourceTurn, tags: note.tags },
                );
              } else if (this.config.memory) {
                await this.config.memory.put({
                  scope: "reflection",
                  kind: note.type,
                  payload: {
                    content: note.content,
                    confidence: note.confidence,
                    turnNumber: note.sourceTurn,
                    context: note.context,
                    tags: note.tags,
                  },
                  ts: new Date(),
                });
              }
            } catch {
              // Reflection writes are best-effort; never block the user
            }
          }
        }
      }

      const chatResponse = {
        content,
        reasoningContent,
        toolCalls: toolCallResults.length > 0 ? toolCallResults : undefined,
        state: "idle" as const,
        usage,
        durationMs: Date.now() - startTime,
        compacted,
      };

      // Fire post-turn hooks (memory sync, background review) — non-blocking
      if (this.postTurnHooks) {
        this.postTurnHooks({
          memory: this.config.memory,
          sessionId: sessionKey,
          userMessage: message,
          assistantResponse: content,
          turnCount: this.iterations.length,
          toolCalls: toolCallResults,
        }).catch(() => {});
      }

      // ContinualHarness: review trajectory after turn completion
      if (this.continualHarness) {
        try {
          const trajectorySteps = this.iterations.map((iter, idx) => ({
            turnNumber: idx + 1,
            userMessage: iter.input.source.body,
            assistantResponse: iter.output.analysis,
            toolCalls: [],
            durationMs: iter.metrics.timeTaken,
          }));
          const allToolsSucceeded = toolCallResults.every((r) => r.result?.success);
          const assessment = allToolsSucceeded ? "good" : "acceptable";
          this.continualHarness.reviewTrajectory(
            `turn-${Date.now()}`,
            sessionKey,
            trajectorySteps,
            assessment,
          );
        } catch {
          // Review failures should not block the agent
        }
      }

      return chatResponse;
    } catch (error) {
      this.safeTransition("error");
      return {
        content: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
        state: "error", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        durationMs: Date.now() - startTime, compacted: false,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Public API - chatStream (streaming)
  // -------------------------------------------------------------------------

  async chatStream(message: string, options?: ChatOptions): Promise<AsyncIterable<ModelStreamChunk>> {
    const sessionKey = this.resolveSessionKey(options?.sessionId);
    const runStream = async (): Promise<AsyncIterable<ModelStreamChunk>> => {
      return this.chatStreamInternal(message, options, sessionKey);
    };

    if (this.turnController) {
      return this.turnController.enqueue({
        sessionId: sessionKey,
        origin: (options as Record<string, unknown>)?.origin as TurnOrigin ?? "cli",
        run: runStream,
      });
    }
    return runStream();
  }

  private async chatStreamInternal(message: string, options: ChatOptions | undefined, sessionKey: string): Promise<AsyncIterable<ModelStreamChunk>> {
    const startTime = Date.now();
    const templateName = this.resolveTemplateName('chat', options?.templateName);
    const conversation = this.getConversation(options?.sessionId);
    if (sessionKey !== "default") {
      this.sessionManager.ensureSession(sessionKey);
    }
    this.safeTransition("starting");
    this.syncModelContextWindow();
    conversation.addMessage({ role: "user", content: message, timestamp: new Date() });
    this.recordSessionMessage(options?.sessionId, { role: "user", content: message, timestamp: new Date() });
    this.graduatedLoopDetector.reset();
    this.stateMachine.transition("running");

    const self = this;
    return (async function* () {
      let goalTokens = 0;
      let goalToolCalls = 0;
      try {
        const agentCtx = await self.ensureContext(options?.sessionId);
        const memoryContext = await self.buildMemoryContext(message);
        const source: StrategySource = { kind: "llm-plan", body: message };

        // Classify intent and adjust prompt
        const intentRoute = self.intentRouter.classify(message);
        const routeGuidance = self.intentRouter.getRouteGuidance(intentRoute);

        const { system, user, constraints } = self.promptBuilder.buildPrompt(
          templateName, agentCtx, memoryContext, source, self.budget, 1, 1,
        );

        // Append intent guidance and anti-narration rules to system prompt
        // If the active session has a persona set, use it as the primary workspace prompt
        const activeSession = self.sessionManager.getSession(options?.sessionId);
        const sessionPersona = activeSession?.metadata?.persona;
        let workspaceGuidance: string;
        if (sessionPersona) {
          const personaContent = await self.getPersonaPrompt(sessionPersona);
          workspaceGuidance = personaContent
            ? `\n\n=== PERSONA: ${sessionPersona} ===\n${personaContent}\n\n=== WORKSPACE INSTRUCTIONS ===\n${self.config.workspacePrompt ?? ''}`
            : `\n\n=== WORKSPACE INSTRUCTIONS ===\n${self.config.workspacePrompt ?? ''}`;
        } else {
          workspaceGuidance = self.config.workspacePrompt
            ? `\n\n=== WORKSPACE INSTRUCTIONS ===\n${self.config.workspacePrompt}`
            : "";
        }
        const loopGuidance = self.graduatedLoopDetector.getOutputLoopGuidance();
        const toolLoopGuard = `\n\nTOOL LOOP GUARD:\n- Do not repeat identical tool calls with the same arguments.\n- If progress stalls, change the approach or stop and summarize the blocker.\n${loopGuidance ? `\n${loopGuidance}\n` : ""}`;
        const promptLayers = promptAssembly.assemble({
          stable: [system, workspaceGuidance, routeGuidance, ANTI_NARRATION_RULES],
          context: [self.goalPrompt(options?.sessionId), self.planningPrompt(options?.sessionId)],
          volatile: [toolLoopGuard],
          currentContext: agentCtx,
        });
        self.budgetTracker.update("stable", promptLayers.tiers.find((tier) => tier.name === "stable")?.tokens ?? 0);
        self.budgetTracker.update("context", promptLayers.tiers.find((tier) => tier.name === "context")?.tokens ?? 0);
        self.budgetTracker.update("volatile", promptLayers.tiers.find((tier) => tier.name === "volatile")?.tokens ?? 0);
        if (self.budgetTracker.shouldWarn()) {
          console.warn("Prompt budget warning", self.budgetTracker.getSnapshot());
        }
        const systemWithGuidance = promptLayers.systemPrompt;

        const convMessages = conversation.getMessagesForRequest();
        let messages: ModelRequest["messages"] = [
          { role: "system", content: systemWithGuidance + "\n\n" + (constraints?.join("\n") ?? "") },
        ];
        for (const msg of convMessages.slice(0, -1)) {
          messages.push({ role: msg.role as any, content: msg.content, tool_calls: msg.tool_calls, tool_call_id: msg.tool_call_id });
        }
        messages.push({ role: "user", content: user });

        const tools = self.buildToolDefinitions(options?.sessionId, options?.allowTools ?? true);
        const modelRouter = self.config.modelRouter;
        if (!modelRouter) {
          yield { type: "error" as const, error: "Model router not configured." };
          return;
        }

        // Stream through tool loop (max 4 turns)
        for (let turn = -1; turn < (self.config.maxToolTurns ?? 12); turn++) {
          if (self.cancelRequested) {
            yield { type: "content" as const, content: "(Cancelled)" };
            yield { type: "done" as const };
            return;
          }
        if (!self.budget.canStartIteration()) break;

        const promptFootprintTokens = self.estimateRequestTokens(messages);
        const request: ModelRequest = {
          messages, tools: tools.length > 0 ? tools : undefined,
            maxTokens: self.resolveChatMaxTokens(promptFootprintTokens, options?.maxTokens),
            temperature: 0.3,
        };

        const analysisTaskName = self.resolveRoutingTaskName('analysis');

        // Stream from the model with recovery
          let contentBuffer = "";
          let toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
          let finalUsage: ModelStreamChunk["usage"] = undefined;

          let streamSuccess = false;
          while (!streamSuccess) {
            try {
              // Pre-LLM-call hooks
              const preLlmResult = await self.hooksManager.run('pre-llm-call', { messages, tools });
              if (!preLlmResult.continue) {
                yield { type: "content" as const, content: "(LLM call blocked by hook)" };
                yield { type: "done" as const };
                return;
              }
              for await (const chunk of modelRouter.stream(request, analysisTaskName)) {
                if (chunk.type === "content") {
                  contentBuffer += chunk.content ?? "";
                  yield chunk; // Forward content chunks to caller
                } else if (chunk.type === "tool_call") {
                  toolCalls.push(chunk.toolCall!);
                  yield chunk; // Forward tool_call chunks
                } else if (chunk.type === "done") {
                  finalUsage = chunk.usage;
                  goalTokens += chunk.usage?.totalTokens ?? 0;
                } else if (chunk.type === "error") {
                  yield chunk;
                  return;
      }
    }

              self.recoveryManager.recordSuccess();
              streamSuccess = true;
            } catch (error) {
              const action = self.recoveryManager.recordFailure((error as Error).message);
              // On-error hooks
              await self.hooksManager.run('on-error', { error: error instanceof Error ? error.message : "Unknown error" });
              if (action.action === 'fatal') {
                yield { type: "error" as const, error: `Recovery exhausted: ${action.description}` };
                return;
              }
              // Apply recovery action
              if (action.action === 'fallback_model' || action.action === 'lightweight_model') {
                request.model = action.modelOverride;
              }
              if (action.action === 'strip_thinking') {
                messages = messages.map(m => {
                  if (m.role === 'assistant' && m.content) {
                    return { ...m, content: m.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim() };
                  }
                  return m;
                });
                request.messages = messages;
              }
              if (action.action === 'soft_reset') {
                const systemMsg = messages[0];
                const recentMsgs = messages.slice(-self.recoveryManager.getState().consecutiveFailures > 3 ? 20 : messages.length);
                messages = systemMsg ? [systemMsg, ...recentMsgs] : recentMsgs;
                request.messages = messages;
              }
              // Reset buffers and retry
              contentBuffer = "";
              toolCalls = [];
              finalUsage = undefined;
            }
          }

          // Post-LLM-call hooks
          await self.hooksManager.run('post-llm-call', { contentBuffer, toolCalls, usage: finalUsage });

          self.budget.recordApiCall();

          // If we got content and no tool calls, we're done
          if (contentBuffer.trim() && toolCalls.length === 0) {
            const loopSeverity = self.graduatedLoopDetector.recordOutput(contentBuffer);
            conversation.addMessage({ role: "assistant", content: contentBuffer, timestamp: new Date() });
            self.recordSessionMessage(options?.sessionId, { role: "assistant", content: contentBuffer, timestamp: new Date() });
            if (loopSeverity === "halt") {
              await self.writeLoopDiagnosticSnapshot(options?.sessionId, {
                reason: "halt",
                content: contentBuffer,
                usage: finalUsage,
                toolCalls,
                timestamp: new Date().toISOString(),
              });
              await self.recordLoopEvidence(options?.sessionId, contentBuffer, loopSeverity);
              yield { type: "content" as const, content: "(Loop detected and circuit breaker engaged.)" };
            }
            yield { type: "done" as const, usage: finalUsage };
            break;
          }

          // If no content and no tool calls, done
          if (!contentBuffer.trim() && toolCalls.length === 0) {
            yield { type: "error" as const, error: "Model returned no visible output." };
            return;
          }

          // Execute tool calls
          messages.push({ role: "assistant", content: contentBuffer || null, tool_calls: toolCalls });
          self.stateMachine.transition("tool_executing");

          // Build tool calls and execute in parallel where possible
          const toolCallInputs: ToolCall[] = toolCalls.map(tc => ({
            tool: tc.function.name, args: JSON.parse(tc.function.arguments),
            id: tc.id, correlationId: `chat-${Date.now()}`,
          }));
          goalToolCalls += toolCallInputs.length;

          // Pre-tool-call hooks
          let toolBlocked = false;
          for (const toolCall of toolCallInputs) {
            const hookResult = await self.hooksManager.run('pre-tool-call', toolCall);
            if (!hookResult.continue) {
              yield { type: "content" as const, content: "(Tool call blocked by hook)" };
              toolBlocked = true;
              break;
            }
          }
          if (toolBlocked) break;

          const authorization = await self.partitionApprovedToolCalls(toolCallInputs);
          for (const { call: toolCall, result } of authorization.denied) {
            yield { type: "tool_result" as const, toolResult: { toolCallId: toolCall.id!, result } };
            messages.push({ role: "tool", tool_call_id: toolCall.id!, content: JSON.stringify(result) });
          }
          if (authorization.approved.length === 0) {
            self.stateMachine.transition("running");
            continue;
          }

          // Track tool start times and emit running progress
          for (const tc of authorization.approved) {
            if (tc.id) self.toolStartTimes.set(tc.id, Date.now());
            if (tc.id) {
              yield {
                type: 'tool_progress',
                toolProgress: { toolCallId: tc.id, toolName: tc.tool, status: 'running', elapsedMs: 0 },
              };
            }
          }
          
          self.graduatedLoopDetector.resetForStep();
          const batchInputs: BatchCallInput[] = authorization.approved.map((call, batchIndex) => ({
            batchIndex,
            call,
            resourceClass: resourceClassFor(call.tool, self.config.toolRegistry!.get?.(call.tool)?.definition),
          }));
          const batchResult = await executeBatch(
            batchInputs,
            self.config.toolRegistry!,
            {
              sessionId: sessionKey,
              stepIndex: turn,
              signal: AbortSignal.timeout(self.config.budgetConfig?.maxTimeMs ?? 300_000),
              tracker: self.graduatedLoopDetector,
              maxWaveSize: self.maxWaveSize,
            }
          );
          
          for (const { call: toolCall, result } of batchResult.results) {
            if (!result) continue;
            const elapsed = toolCall.id ? Date.now() - (self.toolStartTimes.get(toolCall.id) ?? Date.now()) : 0;
            if (toolCall.id) {
              yield {
                type: 'tool_progress',
                toolProgress: {
                  toolCallId: toolCall.id,
                  toolName: toolCall.tool,
                  status: result.success ? 'completed' : 'error',
                  elapsedMs: elapsed,
                },
              };
            }
            yield { type: "tool_result" as const, toolResult: { toolCallId: toolCall.id!, result } };
            messages.push({ role: "tool", tool_call_id: toolCall.id!, content: JSON.stringify(result) });
          }

          // Clean up tool start times
          for (const { call: toolCall } of batchResult.results) {
            if (toolCall.id) self.toolStartTimes.delete(toolCall.id);
          }

          // Post-tool-call hooks
          for (const { call: toolCall, result } of batchResult.results) {
            if (!result) continue;
            await self.hooksManager.run('post-tool-call', { toolCall, result });
          }

          self.stateMachine.transition("running");

          // Loop detection (composite batch check)
          const streamBatchVerdict = self.graduatedLoopDetector.observeBatchComposite(
            toolCallInputs.map(tc => ({ tool: tc.tool, args: tc.args })),
            batchResult.results.filter(r => r.result).map(r => r.result!),
          );
          if (streamBatchVerdict.level === "critical" || streamBatchVerdict.level === "breaker") {
            yield { type: "content" as const, content: "(Loop detected — stopping to prevent infinite tool calling.)" };
            break;
          }

          toolCalls = [];
          contentBuffer = "";
        }

        await self.runCompaction(options?.sessionId);
        self.markDreamLoopCompleted(options?.triggerDreamCycle);
        self.recordGoalUsage(options?.sessionId, { totalTokens: goalTokens }, goalToolCalls);

        // Auto-advance step-based goals
        const activeGoal = self.activeGoal(options?.sessionId);
        if (activeGoal) {
          const advance = self.goalManager.autoAdvance(activeGoal.id);
          if (advance.advanced && advance.nextSteps.length > 0) {
            const nextStepTitles = advance.nextSteps.map((s) => `"${s.title}"`).join(", ");
            const advanceNote = `[Goal auto-advanced. Next step(s) ready: ${nextStepTitles}]`;
            yield { type: "content" as const, content: advanceNote };
          }
        }

        self.safeTransition("stopping");
        self.safeTransition("idle");

        yield { type: "done" as const };
      } catch (error) {
        self.safeTransition("error");
        yield { type: "error" as const, error: error instanceof Error ? error.message : "Unknown error" };
      }
    })();
  }

  // -------------------------------------------------------------------------
  // State & conversation accessors
  // -------------------------------------------------------------------------

  getState(): AgentState { return this.stateMachine.getState(); }
  onStateChange(listener: (state: AgentState) => void): () => void {
    return this.stateMachine.onStateChange((state) => listener(state));
  }
  getConversationHistory(): ConversationMessage[] { return this.getConversation().getMessages(); }
  forkConversation(): ConversationMessage[] { return this.getConversation().fork(); }
  restoreConversation(messages: ConversationMessage[]): void { this.getConversation().restore(messages); }
  clearConversation(): void { this.getConversation().clear(); }

  // -------------------------------------------------------------------------
  // Session management
  // -------------------------------------------------------------------------

  createSession(name?: string): Session {
    return this.sessionManager.createSession(name);
  }

  forkSession(sessionId: string, fromMessageId: string): Session {
    return this.sessionManager.forkSession(sessionId, fromMessageId);
  }

  switchSession(sessionId: string): Session {
    const session = this.sessionManager.switchSession(sessionId);
    this.getConversation(sessionId).restore(session.messages);
    const existingContext = this.contextsBySession.get(sessionId);
    if (existingContext) {
      this.currentContext = existingContext;
    }
    return session;
  }

  listSessions(): SessionInfo[] {
    return this.sessionManager.listSessions();
  }

  getActiveSession(): Session | null {
    return this.sessionManager.getActiveSession();
  }

  deleteSession(sessionId: string): boolean {
    return this.sessionManager.deleteSession(sessionId);
  }

  // -------------------------------------------------------------------------
  // Legacy API - executeTurn (backward compat)
  // -------------------------------------------------------------------------

  async executeTurn(context: AgentTurnContext, source: StrategySource, templateName?: string): Promise<AgentTurnResult> {
    const startTime = Date.now();
    this.iterations = [];
    this.budget.reset();
    const runId = await this.createRunCard(context, source, context.accountId).catch(() => null);
    const sessionKey = this.resolveSessionKey(context.sessionId ?? context.portfolioId ?? context.accountId);
    if (sessionKey !== "default") {
      this.sessionManager.ensureSession(sessionKey);
    }

    try {
      this.currentContext = await this.contextEngine.createContext({ ...context, sessionId: sessionKey });
      this.contextsBySession.set(sessionKey, this.currentContext);
      const memoryContext = await this.buildMemoryContext(source.body);

      await this.memoryWriter.writeDecision({
        type: "decision", agentId: "agent-core",
        content: `Starting turn: ${source.kind} strategy for ${context.mode} mode`,
        context: { strategy: source.body, confidence: undefined },
        importance: 0.7, tags: ["turn_start", source.kind, context.mode],
      });
      await this.contextEngine.addMemoryChunk({
        type: "strategy", content: { source, context }, timestamp: new Date(),
        importance: 0.9, tags: ["strategy", context.mode],
      });

      this.budget.startIteration();

      const chatResult = await this.chat(source.body, {
        sessionId: sessionKey,
        templateName: this.resolveTemplateName('strategy', templateName),
        triggerDreamCycle: false,
      });

      const strategy: SkillManifest = {
        id: `strategy-${Date.now()}`,
        venue: (source.params as Record<string, unknown>)?.venue as string ?? "unknown",
        symbol: (source.params as Record<string, unknown>)?.symbol as string ?? "UNKNOWN",
        executionMode: context.mode,
        entry: (source.params as Record<string, unknown>)?.entry ?? {},
        exits: (source.params as Record<string, unknown>)?.exits ?? {},
        sizing: (source.params as Record<string, unknown>)?.sizing ?? { amount: 1 },
        risk: (source.params as Record<string, unknown>)?.risk as SkillManifest["risk"] ?? {
          maxPositionNotional: 5000,
          maxDailyLoss: 500,
          maxOpenOrders: 3,
        },
      };

      let orderIntents: ReturnType<typeof generateOrderIntentsFromStrategy> = [];
      try {
        orderIntents = generateOrderIntentsFromStrategy(strategy, context);
      } catch {
        orderIntents = [];
      }
      this.budget.completeIteration();
      const confidence = calculateConfidence([], { decision: 'approved', reasons: [] }, []);

      const iteration: AgentIteration = {
        id: `iteration-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        iteration: 1, timestamp: new Date(),
        input: { context, source, memoryContext, budgetState: this.budget.getUsage() },
        output: {
          strategies: [strategy], orderIntents,
          analysis: generateAnalysis(
            strategy,
            { decision: 'approved', reasons: ['risk assessment is agent-driven'] },
            orderIntents,
            chatResult.content,
          ), confidence,
        },
        metrics: { timeTaken: chatResult.durationMs, memoryUsed: this.budget.getUsage().memoryUsed, apiCalls: this.budget.getUsage().apiCalls },
      };
      this.iterations.push(iteration);

      const result: AgentTurnResult = {
        iterations: this.iterations, finalStrategies: [strategy],
        pendingApprovals: orderIntents,
        completed: !this.budget.isExhausted(), totalTime: Date.now() - startTime,
        totalMemory: this.budget.getUsage().memoryUsed, totalApiCalls: this.budget.getUsage().apiCalls,
        chatResponse: chatResult.content,
        chatReasoningResponse: chatResult.reasoningContent,
      };
      await this.contextEngine.updateContext(context, ["agent_turn_completed"], [result]);
      const loopBroken = typeof chatResult.content === "string" && chatResult.content.includes("Loop detected");
      await this.finalizeRunCard(runId, {
        verdict: loopBroken ? "retest" : "hold",
        metrics: {
          totalTime: result.totalTime,
          totalMemory: result.totalMemory,
          totalApiCalls: result.totalApiCalls,
          iterations: result.iterations.length,
        },
        summary: result.chatResponse ?? result.chatReasoningResponse ?? "Turn completed",
        artifact: result,
        artifactType: "AgentTurnResult",
      }).catch(() => {});
      this.markDreamLoopCompleted(true);
      return result;
    } catch (error) {
      await this.rejectRunCard(runId, error instanceof Error ? error.message : "Unknown error").catch(() => {});
      return {
        iterations: this.iterations, finalStrategies: [], pendingApprovals: [],
        completed: false, totalTime: Date.now() - startTime,
        totalMemory: this.budget.getUsage().memoryUsed, totalApiCalls: this.budget.getUsage().apiCalls,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  // -------------------------------------------------------------------------
  // Public accessors (preserved)
  // -------------------------------------------------------------------------

  getCurrentContext(): ContextState | undefined { return this.currentContext; }
  getIterationHistory(): AgentIteration[] { return [...this.iterations]; }

  async addFeedback(iterationId: string, feedback: string): Promise<void> {
    const iteration = this.iterations.find((i) => i.id === iterationId);
    if (!iteration) throw new Error(`Iteration not found: ${iterationId}`);
    await this.config.memory.put({
      scope: "agent_memory", kind: "feedback",
      payload: { iterationId, feedback, timestamp: new Date() }, ts: new Date(),
    });
  }

  getMemoryWriter(): MemoryWriter { return this.memoryWriter; }
  getRecoveryState() { return this.recoveryManager.getState(); }
  getRecoveryHistory() { return this.recoveryManager.getHistory(); }
  getLastIntent() { return this.intentRouter.getLastRoute(); }
  getHooksManager(): HooksManager { return this.hooksManager; }
  getGoalManager(): GoalManager { return this.goalManager; }
  getProviderDoctor(): ProviderDoctor { return this.providerDoctor; }
  getSkillFactory(): SkillFactory | null { return this.skillFactory; }
  getDreamEngine(): DreamEngine | null { return this.dreamEngine; }
  getContextWindowTokens(): number { return this.budgetTracker.getContextWindowTokens(); }
  setDreamEngine(engine: DreamEngine): void { this.dreamEngine = engine; }

  enterPlanMode(sessionId?: string, goal?: string): void {
    const id = sessionId ?? this.sessionManager.getActiveSession()?.id ?? "default";
    this.planningSessions.set(id, { goal: goal?.trim() || undefined, enteredAt: new Date() });
  }

  exitPlanMode(sessionId?: string): void {
    const id = sessionId ?? this.sessionManager.getActiveSession()?.id ?? "default";
    this.planningSessions.delete(id);
  }

  isPlanMode(sessionId?: string): boolean {
    const id = sessionId ?? this.sessionManager.getActiveSession()?.id ?? "default";
    return this.planningSessions.has(id);
  }

  compactConversation(): { compacted: boolean; message: string; messageCount: number } {
    const conversation = this.getConversation();
    if (!conversation.shouldCompact()) {
      return { compacted: false, message: "Compaction not needed yet.", messageCount: conversation.getMessages().length };
    }
    const summary = conversation.compact();
    return { compacted: true, message: summary, messageCount: conversation.getMessages().length };
  }

  listAvailableTools(sessionId?: string): ToolDefinition[] {
    return this.buildToolDefinitions(sessionId);
  }

  async delegate(request: DelegationRequest): Promise<unknown> {
    if (!this.config.delegateTask) {
      throw new Error("Subagent delegation is not configured in this DynaTrader runtime.");
    }
    if (!request.task?.trim()) throw new Error("Delegated task must not be empty.");
    return this.config.delegateTask({ ...request, task: request.task.trim() });
  }

  setDelegateTask(delegateTask: (request: DelegationRequest) => Promise<unknown>): void {
    this.config.delegateTask = delegateTask;
    this.registerDelegationTool();
  }

  setToolPolicy(sessionId: string | undefined, allowedTools?: string[], disallowedTools?: string[]): void {
    const id = sessionId ?? "default";
    this.toolPolicies.set(id, {
      allowed: allowedTools?.length ? new Set(allowedTools) : undefined,
      disallowed: new Set(disallowedTools ?? []),
    });
  }

  setToolApprovalHandler(handler?: (call: ToolCall, definition: ToolDefinition) => Promise<boolean>): void {
    this.config.requestToolApproval = handler;
  }

  // -------------------------------------------------------------------------
  // Tool registration (SDK public API)
  // -------------------------------------------------------------------------

  /**
   * Register a single tool with the agent's tool registry.
   * Allows SDK consumers to add tools after AgentCore is created.
   */
  registerTool(tool: ToolHandler): void {
    this.config.toolRegistry!.register(tool);
  }

  /**
   * Register multiple tools with the agent's tool registry.
   */
  registerTools(tools: ToolHandler[]): void {
    for (const tool of tools) {
      this.config.toolRegistry!.register(tool);
    }
  }

  /**
   * Get the underlying tool registry for direct manipulation.
   */
  getToolRegistry(): ToolRegistry {
    return this.config.toolRegistry!;
  }

  // -------------------------------------------------------------------------
  // Tool progress tracking (Task 1.13)
  // -------------------------------------------------------------------------

  getToolProgress(toolCallId: string): { toolName: string; elapsedMs: number } | null {
    const startTime = this.toolStartTimes.get(toolCallId);
    if (!startTime) return null;
    return { toolName: toolCallId, elapsedMs: Date.now() - startTime };
  }

  getAllToolProgress(): Array<{ toolCallId: string; elapsedMs: number }> {
    const now = Date.now();
    return Array.from(this.toolStartTimes.entries()).map(([id, start]) => ({
      toolCallId: id, elapsedMs: now - start,
    }));
  }

  // -------------------------------------------------------------------------
  // Graceful cancel (Task 1.14)
  // -------------------------------------------------------------------------

  cancel(): void {
    if (this.cancelRequested) {
      // Second cancel within 2s = force quit
      this.cancelRequested = false;
      if (this.cancelTimeout) clearTimeout(this.cancelTimeout);
      this.cancelTimeout = null;
      this.safeTransition("stopping");
      this.safeTransition("idle");
      return;
    }

    this.cancelRequested = true;

    // Reset after 2s window
    this.cancelTimeout = setTimeout(() => {
      this.cancelRequested = false;
      this.cancelTimeout = null;
    }, 2000);
  }

  isCancelled(): boolean { return this.cancelRequested; }

  // -------------------------------------------------------------------------
  // Trade outcome processing
  // -------------------------------------------------------------------------

  async processTradeOutcome(outcome: TradeOutcome): Promise<void> {
    await this.memoryWriter.writeOutcome(outcome);
    await this.memoryWriter.writeEvaluation(outcome.strategy, {
      analysis: `Trade ${outcome.tradeId}: ${outcome.side} ${outcome.symbol} PnL ${outcome.pnlPercent.toFixed(2)}%`,
      confidence: Math.min(1, Math.abs(outcome.pnlPercent) * 5 + 0.3),
      riskScore: Math.abs(outcome.pnlPercent) > 5 ? 8 : Math.abs(outcome.pnlPercent) > 2 ? 5 : 3,
      recommendations: [],
    });
  }

  async processExecution(params: {
    intent: OrderIntent;
    trade: TradeRecord;
    executionMode: "backtest" | "paper" | "micro_live" | "live";
  }): Promise<void> {
    const trade = params.trade;

    await this.memoryWriter.writeObservation({
      content: [
        `${params.executionMode} execution ${trade.status}`,
        `${trade.side} ${trade.symbol}`,
        `qty=${trade.quantity}`,
        `price=${trade.price.toFixed(2)}`,
        trade.realizedPnL !== undefined ? `realizedPnL=${trade.realizedPnL.toFixed(2)}` : null,
      ]
        .filter((part): part is string => part !== null)
        .join(" | "),
      symbol: trade.symbol,
      importance: trade.status === "filled" ? 0.7 : 0.45,
      tags: [
        "execution",
        params.executionMode,
        trade.status,
        trade.side,
        trade.symbol.toLowerCase(),
      ],
    });
    this.markDreamLoopCompleted(true);
  }

  async processPaperExecution(params: {
    intent: OrderIntent;
    trade: TradeRecord;
    executionMode: "paper" | "backtest";
  }): Promise<void> {
    return this.processExecution(params);
  }

  async getPerformanceSummary(): Promise<PerformanceSummary> { return this.memoryWriter.getPerformanceSummary(); }

  async reset(): Promise<void> {
    await this.contextEngine.resetContext();
    this.currentContext = undefined;
    this.contextsBySession.clear();
    this.conversationsBySession.clear();
    this.iterations = [];
    this.budget.reset();
    this.conversation.clear();
  }

  private buildExecutionTradeOutcome(
    strategy: SkillManifest,
    trade: TradeRecord,
    executionMode: ExecutionMode,
  ): TradeOutcome | null {
    if (trade.quantity <= 0 || trade.price <= 0) {
      return null;
    }

    const realizedPnl = trade.realizedPnL ?? 0;
    const pnl = realizedPnl - trade.fees;
    const entryPrice = trade.price - realizedPnl / trade.quantity;
    const pnlPercent = entryPrice > 0
      ? (pnl / (entryPrice * trade.quantity)) * 100
      : 0;

    return {
      tradeId: trade.id,
      symbol: trade.symbol,
      side: trade.side,
      entryPrice: entryPrice > 0 ? entryPrice : trade.price,
      exitPrice: trade.price,
      quantity: trade.quantity,
      pnl,
      pnlPercent,
      holdingTimeMs: this.estimatePaperHoldingTime(strategy, executionMode),
      strategy,
      marketConditions: this.inferPaperMarketConditions(strategy),
      timestamp: trade.timestamp.getTime(),
    };
  }

  private estimatePaperHoldingTime(strategy: SkillManifest, executionMode: "backtest" | "paper" | "micro_live" | "live" | "shadow"): number {
    const timeframe = typeof strategy.timeframe === "string" ? strategy.timeframe.trim().toLowerCase() : "";
    const parsed = timeframe.match(/^(\d+)([mhdw])$/);
    if (!parsed) {
      return executionMode === "backtest" ? 4 * 60 * 60 * 1000 : 60 * 60 * 1000;
    }

    const value = Number.parseInt(parsed[1]!, 10);
    switch (parsed[2]) {
      case "m":
        return value * 60 * 1000;
      case "h":
        return value * 60 * 60 * 1000;
      case "d":
        return value * 24 * 60 * 60 * 1000;
      case "w":
        return value * 7 * 24 * 60 * 60 * 1000;
      default:
        return 60 * 60 * 1000;
    }
  }

  private inferPaperMarketConditions(strategy: SkillManifest): MarketConditions {
    const entry = (strategy.entry ?? {}) as Record<string, unknown>;
    const regime = this.asMarketRegime(
      entry.regime,
      entry.preferredRegime,
      entry.marketRegime,
    );
    const trend = this.asMarketTrend(
      entry.trend,
      entry.preferTrend,
      entry.direction,
    );
    const volume = this.asVolumeLevel(entry.volume, entry.volumeLevel);
    const volatility = typeof entry.volatility === "number" && Number.isFinite(entry.volatility)
      ? entry.volatility
      : 0.02;

    return {
      regime,
      trend,
      volume,
      volatility,
    };
  }

  private asMarketRegime(...values: Array<unknown>): MarketConditions["regime"] {
    for (const value of values) {
      if (value === "trending" || value === "ranging" || value === "volatile" || value === "calm") {
        return value;
      }
    }
    return "trending";
  }

  private asMarketTrend(...values: Array<unknown>): MarketConditions["trend"] {
    for (const value of values) {
      if (value === "bullish" || value === "bearish" || value === "neutral") {
        return value;
      }
    }
    return "neutral";
  }

  private asVolumeLevel(...values: Array<unknown>): MarketConditions["volume"] {
    for (const value of values) {
      if (value === "high" || value === "normal" || value === "low") {
        return value;
      }
    }
    return "normal";
  }

}
