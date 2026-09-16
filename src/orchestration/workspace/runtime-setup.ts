/**
 * Runtime Component Initialization
 *
 * Extracted from DynaTraderRuntime to reduce the size of index.ts.
 * Handles initialization of all runtime components, model providers,
 * built-in tools, exchange adapters, event bus wiring, and pipeline handlers.
 */

import { mkdirSync, existsSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { join, basename } from 'path';

import type { RuntimeConfig, WorkspaceManifest } from './types';
import type { AgentTurnContext, OrderIntent, SkillManifest, TradeMode } from '../../types';
import type { CronJob, CronJobState, CronTradeRecord } from '@dyna/agent-cron';
import { Logger } from './logger';
import { normalizeMarketRecord } from '../../market/utils';
import { errorMessage } from '../../utils/errors';

// Component imports
import { MemoryStoreImpl } from '@dyna/memory-core';
import { ModelRouterImpl, OpenAIProvider, AnthropicProvider, OllamaProvider, LMStudioProvider, OpenRouterProvider, DeepSeekProvider, GoogleProvider } from '@dyna/model-router';
import type { ModelProvider } from '@dyna/contracts';
import { ToolRegistryImpl, ReadTool, GlobTool, GrepTool, WriteTool, EditTool, ExecTool, WebFetchTool, BrowserTool, VisionTool, InboxDeliverTool, TelegramSendTool, VoiceTranscriptionTool, TtsTool, MemorySearchTool, MemoryWriteTool, MarketDataTool, SpawnSubagentTool, SessionsListTool, SessionsHistoryTool, SessionsSendTool, SessionSearchTool, SessionStatusTool, AgentBusTool, FleetTool } from '@dyna/tools-runtime';
import { AgentCore, GoalManager, SkillFactory, CrossSessionRecall, runPostTurnHooks } from '@dyna/agent-core';
import { TurnController } from '@dyna/agent-core';
import { SteeringInbox } from '@dyna/agent-core';
import { ReflectionRunner } from '@dyna/agent-core';
import { DurableTaskModel } from '@dyna/agent-core';
import { DaemonSessionManager } from '@dyna/agent-core';
import { AgentMessaging } from '@dyna/agent-core';
import { ContinualHarness } from '@dyna/agent-core';
import { MemoryFabric } from '@dyna/agent-core';
import { SkillLoader } from '../../agent/skills/skill-loader';
import { HaltState } from '../../runtime/halt/halt-state';
import { HaltTradingTool, ResumeTradingTool, TradingHaltStatusTool, CheckCircuitBreakersTool } from '../../agent/tools/risk-tools';
import { CronEngine } from '@dyna/agent-cron';
import { PluginRuntime } from '../../runtime/plugins/plugin-runtime';
import type { ToolProfile } from '../../runtime/tools/tool-profiles';
import { requireVisibleResponse } from '../../runtime/visible-response';

// Cron tools for self-modifying scheduling
import { CronTool } from '../../agent/tools/cron-tools';

// Goal tools for step-based goal management
import { GoalTool } from '../../agent/tools/goal-tools';

// SQLite State Database for unified persistence
import { StateDb } from '../../state-db';

// Read-only SQL query tool for state.db introspection
import { SqliteQueryTool } from '../../agent/tools/sqlite-query-tool';

// Wallet and DEX trading infrastructure
import { WalletManager } from '../../wallet/wallet-manager';
import { ApprovalManager } from '../../wallet/approval-manager';
import { TxPipeline } from '../../wallet/tx-pipeline';
import { UniswapAdapter } from '../../wallet/dex-adapters/uniswap-adapter';
import { ZeroXAdapter } from '../../wallet/dex-adapters/zerox-adapter';
import { SupportedChainId } from '../../wallet/types';
import { WalletBalanceTool, WalletSwapTool, WalletApproveTool, WalletHistoryTool, WalletQuoteTool } from '../../agent/tools/wallet-tools';

import { CCXTAdapter } from '@dyna/exchange-ccxt';
import { AlpacaAdapter } from '../../market/exchange/alpaca-adapter';
import { IBKRAdapter } from '../../market/exchange/ibkr-adapter';
import { LongbridgeAdapter } from '../../market/exchange/longbridge-adapter';
import { HyperliquidAdapter } from '../../market/exchange/hyperliquid-adapter';
import { EventBus } from '@dyna/event-bus';
import type { TradeEvent, RiskEvent, ExchangeAdapter, ToolHandler, ToolCall, ToolResult, ToolDefinition } from '@dyna/contracts';
import { AuditTrail } from '@dyna/audit';
import { PaperEngine } from '@dyna/backtest';
import { ExecutionRouterImpl } from '@dyna/execution';
import { MCPRuntime } from '../../runtime/mcp/mcp-runtime';
import type { MCPServerConfig, MCPToolDefinition } from '../../runtime/mcp/mcp-types';

// Dreaming cycle
import { DreamEngine, DreamScheduler, DEFAULT_DREAM_CONFIG } from '../../agent/dream/index';

// Persistent memory and context compaction
import { MemoryBridge } from '../../memory/core/memory-bridge';
import { ContextCompactionEngine } from '../../context/context-compaction-engine';
import { ToolResultCompressor } from '../../context/tool-result-compressor';
import { loadWorkspaceIdentity } from '../../runtime/workspace-identity';

// Channel and session management
import { SessionManager } from '../../gateway/channels/sessions';
import { ChannelManager } from '../../gateway/channels/channels';
import { buildGatewayRuntimeStatus } from '../../gateway/runtime-gateway';

// Trading pipeline
import { TradingPipeline } from './trading-pipeline';
import type { TradingPipelineConfig } from './trading-pipeline';
import { LoopScheduler } from './loop-scheduler';

// A2A and subagent components
import { A2ARuntime } from '@dyna/a2a-runtime';
import { AgentRegistry } from '../../runtime/subagents/agent-registry';
import type { ResolvedManifest } from '../../runtime/subagents/agent-registry';
import { SubagentRuntime } from '../../runtime/subagents/index';
import { IssueBoard, IssueScheduler } from '../../issue-board';
import { RunCardManager } from '../../governance/run-cards';

// Agent-to-agent communication
import { AgentBus } from '../../agent/messaging/agent-bus';
import { FleetManager } from '../../runtime/fleet/fleet-manager';

function resolveAgentDefaultMode(mode: RuntimeConfig['mode']): TradeMode {
  if (mode === 'backtest') {
    return 'backtest';
  }
  if (mode === 'live' || mode === 'micro_live') {
    return 'live';
  }
  return 'paper';
}

// ---------------------------------------------------------------------------
// Mutable component state container
// ---------------------------------------------------------------------------

export interface RuntimeComponents {
  memoryStore: MemoryStoreImpl | null;
  modelRouter: ModelRouterImpl | null;
  toolRegistry: ToolRegistryImpl | null;
  pluginRuntime: PluginRuntime | null;
  agentCore: AgentCore | null;
  loopSync: boolean;
  exchange: ExchangeAdapter | null;
  paperEngine: PaperEngine | null;
  executionRouter: ExecutionRouterImpl | null;
  eventBus: EventBus | null;
  auditTrail: AuditTrail | null;
  pipeline: TradingPipeline | null;
  a2aRuntime: A2ARuntime | null;
  agentRegistry: AgentRegistry | null;
  subagentRuntime: SubagentRuntime | null;
  cronEngine: CronEngine | null;
  skillFactory: SkillFactory | null;
  crossSessionRecall: CrossSessionRecall | null;
  skillLoader: SkillLoader | null;
  dreamEngine: DreamEngine | null;
  dreamScheduler: DreamScheduler | null;
  memoryBridge: MemoryBridge | null;
  compactionEngine: ContextCompactionEngine | null;
  sessionManager: SessionManager | null;
  channelManager: ChannelManager | null;
  walletManager: WalletManager | null;
  approvalManager: ApprovalManager | null;
  txPipeline: TxPipeline | null;
  dexAdapters: Map<string, import('../../wallet/dex-adapters/adapter.interface').DEXAdapter> | null;
  runCardManager: RunCardManager | null;
  mcpRuntime: MCPRuntime | null;
  stateDb: StateDb | null;
  agentBus: AgentBus | null;
  fleetManager: FleetManager | null;
  skillManager: import('../../agent/core/skill-manager').SkillManager | null;
  sessionSearch: import('../../agent/core/session-search').SessionSearch | null;
  memoryConsolidation: import('../../agent/core/memory-consolidation').MemoryConsolidation | null;
  turnController: TurnController | null;
  steeringInbox: SteeringInbox | null;
  reflectionRunner: ReflectionRunner | null;
  durableTasks: import('../../agent/core/durable-task-model').DurableTaskModel | null;
  daemonSessions: import('../../agent/core/daemon-sessions').DaemonSessionManager | null;
  agentMessaging: import('../../agent/core/agent-messaging').AgentMessaging | null;
  continualHarness: import('../../agent/core/continual-harness').ContinualHarness | null;
  memoryFabric: import('../../agent/core/memory-fabric-v25').MemoryFabric | null;
  toolResultCompressor: ToolResultCompressor | null;
  /** True if StateDb failed to initialize — persistence is degraded */
  degraded: boolean;
}

// ---------------------------------------------------------------------------
// Main initialization
// ---------------------------------------------------------------------------

export async function initializeComponents(
  components: RuntimeComponents,
  workspacePath: string,
  config: RuntimeConfig,
  workspace: WorkspaceManifest,
  logger: Logger,
): Promise<void> {
  const envShowThinking = process.env['DYNA_SHOW_THINKING']?.toLowerCase();
  const configShowThinking = (workspace.config as Record<string, unknown>)?.runtime;
  const showThinking = envShowThinking !== undefined
    ? envShowThinking !== 'false'
    : typeof configShowThinking === 'object' && configShowThinking !== null
      ? (configShowThinking as Record<string, unknown>).showThinking !== false
      : true;

  // --- 0. Bootstrap detection ---
  const bootstrapPath = join(workspacePath, 'BOOTSTRAP.md');
  if (existsSync(bootstrapPath)) {
    logger.debug('BOOTSTRAP.md detected - setup ritual is available if the user needs it.');
    logger.debug('Paper mode startup stays non-blocking and does not surface bootstrap noise.');
  }

  // --- 1. Audit Trail (created first, shared by other components) ---
  logger.debug('Initializing AuditTrail');
  components.auditTrail = new AuditTrail(workspacePath);

  // --- 2. Event Bus ---
  logger.debug('Initializing EventBus');
  components.eventBus = new EventBus({ maxListeners: 200 });

  // --- 3. Memory Store (SQLite-backed, persistent) ---
  const resolvedMemoryBackend = config.memoryBackend ?? 'sqlite';
  logger.debug(`Initializing MemoryStore (${resolvedMemoryBackend})`);
  const memoryDir = join(workspacePath, 'memory');
  mkdirSync(memoryDir, { recursive: true });
  if (resolvedMemoryBackend === 'in-memory') {
    logger.warn('In-memory backend selected — data will NOT persist across restarts');
    components.memoryStore = new MemoryStoreImpl();
  } else {
    components.memoryStore = await MemoryStoreImpl.withSqlite({ kind: 'sqlite', dbPath: join(workspacePath, 'state.db') });
  }

  // --- 3b. Memory Bridge (MEMORY.md <-> SQLite sync) ---
  logger.debug('Initializing MemoryBridge');
  const memoryBackend = components.memoryStore.getBackend();
  components.memoryBridge = new MemoryBridge(memoryBackend, {
    memoryMdPath: join(workspacePath, 'MEMORY.md'),
  });
  await components.memoryBridge.syncToSqlite();
  logger.info('MemoryBridge synced MEMORY.md to SQLite');

  // --- 3c. Context Compaction Engine (auto-compact at 75%) ---
  logger.debug('Initializing ContextCompactionEngine');
  const compactionSink = {
    write: (entry: { scope: string; kind: string; payload: unknown; timestamp: Date }) =>
      components.memoryStore!.put({ scope: entry.scope, kind: entry.kind, payload: entry.payload, ts: entry.timestamp }),
  };
  components.compactionEngine = new ContextCompactionEngine(compactionSink, {
    autoCompactThreshold: 0.75,
    maxContextTokens: 80000,
    recentTailTokens: 20000,
  }, components.stateDb ?? undefined);

  // --- 3c2. Tool Result Compressor (Atomic Agent Compress step) ---
  logger.debug('Initializing ToolResultCompressor');
  const compressToolResults = (workspace.config as Record<string, unknown>)?.runtime
    ? !!(workspace.config as Record<string, unknown>).compressToolResults
    : true;
  components.toolResultCompressor = new ToolResultCompressor({
    enabled: compressToolResults,
    contextWindow: 128000,
    maxToolResultTokens: 500,
    llmSummarizeThreshold: 1000,
    useLlmSummarization: !!components.modelRouter,
  });

  // --- 3d. Session Manager (per-chat conversation state) ---
  logger.debug('Initializing SessionManager');
  components.sessionManager = new SessionManager(components.memoryStore);

  // --- 3e. Channel Manager (multi-channel routing) ---
  logger.debug('Initializing ChannelManager');
  components.channelManager = new ChannelManager(components.memoryStore, components.sessionManager);
  // Create default channels
  const adminSessionId = await components.sessionManager.createSession('system', 'admin', {
    permissions: ['*'],
    riskLevel: 'low',
  });
  await components.sessionManager.connectSession(adminSessionId);
  await components.channelManager.createDefaultChannels(adminSessionId);
  logger.info('SessionManager and ChannelManager initialized with default channels');

  // --- 3f. State Database (SQLite state.db for unified persistence) ---
  logger.debug('Initializing StateDb');
  try {
    const stateDbPath = join(workspacePath, 'state.db');
    components.stateDb = new StateDb(stateDbPath);
    logger.info(`StateDb initialized at ${stateDbPath}`);
  } catch (error) {
    components.degraded = true;
    logger.error('StateDb initialization FAILED — persistence is DEGRADED. Goals, sessions, conversations, and compaction records will NOT survive restarts.', error);
    components.stateDb = null;
  }

  // --- 5. Model Router with auto-detected providers ---
  logger.debug('Initializing ModelRouter');
  components.modelRouter = new ModelRouterImpl({
    auditTrail: components.auditTrail,
    workspacePath,
  });
  registerModelProviders(components, logger, workspace.config ?? null);

  // --- 6. Tool Registry with built-in tools ---
  logger.debug('Initializing ToolRegistry and registering tools');
  components.toolRegistry = new ToolRegistryImpl({
    auditTrail: components.auditTrail,
    cacheEnabled: true,
    defaultMaxOutputLength: 24 * 1024,
    cacheTtlMs: 120_000,
  });
  registerBuiltInTools(components, workspacePath, workspace.config ?? null, logger);

  // --- 6a. MCP Runtime (external tools and market capabilities) ---
  logger.debug('Initializing MCPRuntime');
  const mcpServers = getConfiguredMcpServers(workspace);
  if (mcpServers.length > 0) {
    components.mcpRuntime = new MCPRuntime({
      mode: 'client',
      workspacePath,
      servers: mcpServers,
    });
    await registerMcpTools(components, config, logger, mcpServers);
  } else {
    components.mcpRuntime = null;
    logger.info('No MCP servers configured');
  }

  // --- 6b. Plugin Runtime (workspace extensions) ---
  logger.debug('Initializing PluginRuntime');
  components.pluginRuntime = new PluginRuntime({
    workspacePath,
    strictMode: config.strictMode ?? false,
    auditTrail: components.auditTrail ?? undefined,
    toolRegistry: components.toolRegistry ?? undefined,
  });
  const loadedPlugins = await components.pluginRuntime.loadPlugins();
  logger.info(`PluginRuntime loaded ${loadedPlugins.length} plugin(s)`);

  // Derive plugin profiles from loaded plugin tool declarations
  const loadedPluginProfiles: ToolProfile[] = loadedPlugins
    .flatMap(p => p.manifest.tools?.flatMap(t => (t.profiles as ToolProfile[]) ?? ['trading'] as ToolProfile[]) ?? [])
    .filter((p): p is ToolProfile => ['trading', 'risk'].includes(p as string));

  // --- 7. Exchange Adapter (paper mode by default) ---
  logger.debug('Initializing CCXTAdapter (paper mode)');
  components.exchange = createExchangeAdapter(config, workspace);

  // --- 8. Paper Engine ---
  logger.debug('Initializing PaperEngine');
  if (components.exchange) {
    components.paperEngine = new PaperEngine(
      {
        initialBalance: 10000,
        commissionRate: 0.001,
        slippageRate: 0.001,
        feeCurrency: 'USD',
      },
      components.exchange,
    );
  } else {
    logger.warn('No exchange configured; market data, paper execution, and live execution are unavailable until a workspace adapter is added.');
  }

  // --- 9. Execution Router ---
  logger.debug('Initializing ExecutionRouter');
  components.executionRouter = new ExecutionRouterImpl({
    liveTradingEnabled: config.liveTradingEnabled ?? false,
    microLiveEnabled: config.enableMicroLiveMode ?? false,
    requireApprovalForLive: config.strictMode ?? true,
    maxMicroLiveOrderValue: 1000,
    audit: components.auditTrail,
    paperEngine: components.paperEngine ?? undefined,
    exchangeAdapters: new Map(components.exchange ? [[components.exchange.id, components.exchange]] : []),
    haltState: createHaltState(workspacePath),
  });

  // --- 9b. Skill Loader ---
  logger.debug('Initializing SkillLoader');
  components.skillLoader = new SkillLoader();
  components.skillLoader.registerPath('workspace', workspacePath);
  // Also register bundled skills from the package skills directory
  const bundledSkillsPath = join(workspacePath, '..');
  components.skillLoader.registerPath('bundled', bundledSkillsPath);
  await components.skillLoader.loadAll();
  const loadedSkills = components.skillLoader.getAllSkills();
  logger.info(`Loaded ${loadedSkills.length} skills: ${loadedSkills.map(s => s.metadata.name).join(', ') || 'none'}`);

  // --- 10. Learning Loop Components ---
  initializeLearningLoopComponents(components, workspace, workspacePath, logger);

  // --- 10b. New Architecture Components (skill manager, session search, memory consolidation) ---
  if (components.memoryStore) {
    logger.debug('Initializing SkillManager, SessionSearch, MemoryConsolidation');
    const { SkillManager } = await import('../../agent/core/skill-manager');
    const { SessionSearch } = await import('../../agent/core/session-search');
    const { MemoryConsolidation } = await import('../../memory/consolidation/memory-consolidation');

    const skillsDir = join(workspacePath, 'skills');
    components.skillManager = new SkillManager(skillsDir);
    components.sessionSearch = new SessionSearch(components.memoryStore);
    components.memoryConsolidation = new MemoryConsolidation(
      components.memoryStore,
      {},
      components.modelRouter ?? undefined,
    );
    logger.info('SkillManager, SessionSearch, MemoryConsolidation initialized');
  }

  // --- 10c. Turn orchestration components (TurnController, SteeringInbox, ReflectionRunner) ---
  logger.debug('Initializing TurnController, SteeringInbox, ReflectionRunner');
  components.turnController = new TurnController();
  components.steeringInbox = new SteeringInbox();
  components.reflectionRunner = new ReflectionRunner();

  // --- 10d. Durable Task Model, Daemon Sessions, Agent Messaging, Continual Harness, Memory Fabric ---
  logger.debug('Initializing DurableTaskModel, DaemonSessionManager, AgentMessaging, ContinualHarness, MemoryFabric');
  components.durableTasks = new DurableTaskModel();
  components.daemonSessions = new DaemonSessionManager();
  components.agentMessaging = new AgentMessaging();
  components.continualHarness = new ContinualHarness();
  if (components.memoryStore) {
    components.memoryFabric = new MemoryFabric({ memory: components.memoryStore });
  }
  components.durableTasks.start();
  logger.info('DurableTaskModel, DaemonSessionManager, AgentMessaging, ContinualHarness, MemoryFabric initialized');

  // --- 11. Agent Core (wires everything together) ---
  initializeAgentCore(components, workspacePath, config, workspace, logger);

  // --- 12. Wire event bus listeners ---
  setupEventBusListeners(components, logger);

  // --- 12b. Agent Registry & Agent Router (for subagent delegation) ---
  logger.debug('Initializing AgentRegistry and AgentRouter');
  components.agentRegistry = new AgentRegistry(workspacePath);
  await components.agentRegistry.load();
  const allAgents = await components.agentRegistry.getAll();
  logger.info(`Loaded ${allAgents.length} agents into registry`);

  // --- 12c. Subagent Runtime (agent execution engine) ---
  logger.debug('Initializing SubagentRuntime');
  components.subagentRuntime = new SubagentRuntime(workspacePath);
  await components.subagentRuntime.initialize(workspacePath);
  logger.info('SubagentRuntime initialized');

  // Register SpawnSubagentTool after subagentRuntime is available
  if (components.subagentRuntime && components.toolRegistry) {
    components.toolRegistry.register(new SpawnSubagentTool(
      components.subagentRuntime,
      components.toolRegistry,
      components.agentRegistry ?? undefined,
      loadedPluginProfiles.length > 0 ? loadedPluginProfiles : undefined,
    ));
    logger.info('Registered SpawnSubagentTool');
  }

  // --- 12d. AgentBus (inter-agent messaging) ---
  logger.debug('Initializing AgentBus');
  components.agentBus = new AgentBus({ maxHistorySize: 2000 });
  logger.info('AgentBus initialized');

  // --- 12f. FleetManager (parallel agent orchestration) ---
  logger.debug('Initializing FleetManager');
  components.fleetManager = new FleetManager(components.subagentRuntime, { maxConcurrent: 4 });
  logger.info('FleetManager initialized');

  // Register AgentBus and Fleet tools
  if (components.agentBus && components.toolRegistry) {
    components.toolRegistry.register(new AgentBusTool(components.agentBus));
    logger.info('Registered AgentBusTool');
  }
  if (components.fleetManager && components.toolRegistry) {
    components.toolRegistry.register(new FleetTool(components.fleetManager));
    logger.info('Registered FleetTool');
  }

  await setupAgentDelegation(components, logger, showThinking);

  await setupA2ARuntime(components, workspacePath, allAgents, logger);

  // --- 14. Trading Pipeline (multi-agent coordination) ---
  logger.debug('Initializing TradingPipeline');
  const inferredPipelineAgents = inferPipelineAgents(allAgents);
  components.pipeline = new TradingPipeline({
    workspacePath,
    mode: config.mode as TradingPipelineConfig['mode'],
    researchAgents: inferredPipelineAgents.research,
    analysisAgents: inferredPipelineAgents.analysis,
    riskAgents: inferredPipelineAgents.risk,
    marketContextResolver: async () => resolvePipelineMarketContext(components.exchange, logger),
  });
  registerDefaultPipelineHandlers(components, config, logger, allAgents);

  // --- 15. Cron Engine (wired through full agent loop) ---
  logger.debug('Initializing CronEngine');
  components.cronEngine = new CronEngine(workspacePath, (prompt, job) =>
    executeCronJob(components, prompt, job, showThinking, logger));
  await components.cronEngine.initialize();
  const loopScheduler = new LoopScheduler();
  const loopSync = await loopScheduler.sync(components.cronEngine, workspace.loops ?? []);
  logger.info(`Synchronized loop definitions: created=${loopSync.created.length}, updated=${loopSync.updated.length}, paused=${loopSync.paused.length}, removed=${loopSync.removed.length}`);
  components.loopSync = true;
  const issueScheduleSync = await new IssueScheduler(new IssueBoard(workspacePath)).sync(components.cronEngine);
  logger.info(`Synchronized scheduled issues: created=${issueScheduleSync.created.length}, updated=${issueScheduleSync.updated.length}, removed=${issueScheduleSync.removed.length}`);
  components.cronEngine.start();
  logger.info('CronEngine started (wired to full agent loop)');

  // Heartbeat auto-tick (OpenClaw/hermes style): when DYNA_HEARTBEAT=true,
  // register a forever interval job that runs the heartbeat check.
  if (process.env['DYNA_HEARTBEAT'] === 'true' && components.cronEngine) {
    const intervalMinutes = parseInt(process.env['DYNA_HEARTBEAT_INTERVAL_MINUTES'] ?? '90', 10);
    try {
      await components.cronEngine.createJob({
        name: 'workspace-heartbeat',
        prompt: `Run the workspace heartbeat: read HEARTBEAT.md, check task status, and report HEARTBEAT_OK or what needs attention.`,
        schedule: `every ${intervalMinutes}m`,
        repeatCount: null,
        enabled: true,
      });
      logger.info(`Heartbeat cron registered (every ${intervalMinutes} min)`);
    } catch (err) {
      logger.warn('Heartbeat cron registration failed (may already exist)', err);
    }
  }

  await ensureTelegramCronPulseJob(
    components,
    workspace.config?.gateway?.telegram?.defaultChatId ?? process.env['TELEGRAM_DEFAULT_CHAT_ID'],
    logger,
  );

  registerCronRelatedTools(components, logger);

  // --- 15d. Wallet & DEX Trading Infrastructure ---
  await initializeWalletInfrastructure(components, config, logger);

  // --- 16. Dreaming Cycle (background reflection) ---
  await initializeDreamCycle(components, workspacePath, logger);
}

// ---------------------------------------------------------------------------
// Model provider registration
// ---------------------------------------------------------------------------

function registerModelProviders(components: RuntimeComponents, logger: Logger, workspaceConfig?: Record<string, unknown> | null): void {
  const tryReg = (factory: () => ModelProvider, name: string, envVars?: string[]) => {
    if (envVars && !envVars.some((v) => process.env[v])) {
      logger.debug(`${name} requires ${envVars.join(' or ')}, skipping`);
      return;
    }
    try {
      components.modelRouter!.registerProvider(factory());
      logger.info(`Registered ${name}`);
    } catch (error) {
      logger.warn(`Failed to register ${name}`, error);
    }
  };

  tryReg(() => new OpenAIProvider(), 'OpenAI provider', ['OPENAI_API_KEY']);
  tryReg(() => new AnthropicProvider(), 'Anthropic provider', ['ANTHROPIC_API_KEY']);
  tryReg(() => new OpenRouterProvider(), 'OpenRouter provider', ['OPENROUTER_API_KEY']);
  tryReg(() => new DeepSeekProvider(), 'DeepSeek provider', ['DEEPSEEK_API_KEY']);
  tryReg(() => new GoogleProvider(), 'Google Gemini provider', ['GOOGLE_API_KEY', 'GEMINI_API_KEY']);
  tryReg(() => new OllamaProvider(), 'Ollama provider');
  const cfgModels = (workspaceConfig?.models ?? {}) as Record<string, unknown>;
  const lmBaseUrl = (process.env['LM_STUDIO_BASE_URL'] as string) || 'http://127.0.0.1:1234';
  const lmModel = (process.env['LM_STUDIO_MODEL'] as string) || (typeof cfgModels.model === 'string' ? cfgModels.model.trim() : undefined);
  tryReg(() => new LMStudioProvider({
    baseUrl: lmBaseUrl,
    model: lmModel,
  }), 'LM Studio provider');
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

function registerBuiltInTools(
  components: RuntimeComponents,
  workspacePath: string,
  workspaceConfig: WorkspaceManifest['config'] | null,
  logger: Logger,
): void {
  const registry = components.toolRegistry!;

  // Trading-only default: general-purpose tools (web, browser, exec, voice)
  // are opt-in via config (tools.general.enabled) so the out-of-box agent
  // behaves as a dedicated trading assistant. Workspace file tools stay on —
  // the agent needs them to read its own skills/memory.
  const generalToolsEnabled =
    (workspaceConfig as Record<string, unknown> | null | undefined)?.tools !== undefined &&
    ((workspaceConfig as Record<string, unknown>).tools as Record<string, unknown> | undefined)?.general !== undefined
      ? (((workspaceConfig as Record<string, unknown>).tools as Record<string, unknown>).general as Record<string, unknown> | undefined)?.enabled === true
      : process.env['DYNA_GENERAL_TOOLS'] === 'true';

  registry.register(new ReadTool({ allowedDirectories: [workspacePath], workspaceRoot: workspacePath }));
  registry.register(new GlobTool([workspacePath], workspacePath));
  registry.register(new GrepTool([workspacePath], workspacePath));
  registry.register(new WriteTool({ allowedDirectories: [workspacePath], workspaceRoot: workspacePath }));
  registry.register(new EditTool({ allowedDirectories: [workspacePath], workspaceRoot: workspacePath }));

  if (generalToolsEnabled) {
    registry.register(new ExecTool({ defaultCwd: workspacePath }));
    registry.register(new WebFetchTool());
    registry.register(new BrowserTool({ userDataDir: join(workspacePath, 'browser-sessions') }));
    if (process.env['OPENAI_API_KEY']) registry.register(new VisionTool());
    registry.register(new VoiceTranscriptionTool());
    registry.register(new TtsTool());
    logger.info('General-purpose tools enabled via tools.general.enabled');
  } else {
    logger.info('Trading-only default toolset (general tools disabled; set tools.general.enabled=true or DYNA_GENERAL_TOOLS=true to enable)');
  }

  if (components.memoryStore) {
    registry.register(new MemorySearchTool(components.memoryStore));
    const backend = components.memoryStore.getBackend();
    if (backend) {
      registry.register(new MemoryWriteTool(backend));
    }
  }

  if (components.sessionManager && components.memoryStore) {
    registry.register(new SessionsListTool(components.sessionManager));
    registry.register(new SessionsHistoryTool(components.sessionManager, components.memoryStore));
    registry.register(new SessionsSendTool(components.sessionManager));
    registry.register(new SessionStatusTool(components.sessionManager));
    registry.register(new SessionSearchTool(components.memoryStore, components.sessionManager, components.crossSessionRecall ?? undefined));
  }

  if (components.exchange) {
    registry.register(new MarketDataTool({ exchange: components.exchange }));
  }

  // Risk tools — the agent's own kill switch surface
  registry.register(new HaltTradingTool({ workspacePath }));
  registry.register(new ResumeTradingTool({ workspacePath }));
  registry.register(new TradingHaltStatusTool({ workspacePath }));
  registry.register(new CheckCircuitBreakersTool({ workspacePath }));

  logger.info(`Registered ${registry.list().length} built-in tools`);
}

/**
 * Shared halt-state instance factory. All consumers (execution router, risk
 * tools, CLI, Telegram) must use the same {workspace}/state/halt.json file so
 * a halt triggered anywhere is enforced everywhere.
 */
export function createHaltState(workspacePath: string): HaltState {
  return new HaltState(join(workspacePath, 'state'));
}

// ---------------------------------------------------------------------------
// Exchange adapter factory
// ---------------------------------------------------------------------------

function createExchangeAdapter(
  config: RuntimeConfig,
  workspace: WorkspaceManifest,
): ExchangeAdapter | null {
  const adapterManifest = workspace.adapters.find(
    (a) => a.type === 'broker' || a.type === 'execution' || a.type === 'market_data',
  );

  const configuredExchangeId = (
    workspace.config?.exchange?.id ??
    adapterManifest?.name ??
    ''
  ).toString().trim();

  // Require an explicit configured venue. The runtime should not silently
  // invent a default exchange when the workspace has not chosen one.
  const exchangeId = configuredExchangeId;
  if (!exchangeId) return null;

  const authConfig = workspace.auth as Record<string, unknown> | undefined;
  const apiKey =
    (authConfig?.apiKey as string | undefined) ??
    process.env[`${exchangeId.toUpperCase()}_API_KEY`] ??
    undefined;
  const secret =
    (authConfig?.secret as string | undefined) ??
    process.env[`${exchangeId.toUpperCase()}_SECRET`] ??
    undefined;

  const isPaper = config.mode === 'paper' || config.mode === 'backtest';

  if (exchangeId.toLowerCase() === 'alpaca') {
    return new AlpacaAdapter({
      apiKey: process.env['ALPACA_API_KEY'] ?? (authConfig?.apiKey as string | undefined),
      secretKey: process.env['ALPACA_SECRET_KEY'] ?? (authConfig?.secret as string | undefined),
      paper: isPaper,
    });
  }

  if (exchangeId.toLowerCase() === 'ibkr') {
    return new IBKRAdapter({
      accountId: process.env['IBKR_ACCOUNT_ID'] ?? (authConfig?.accountId as string | undefined),
      baseUrl: process.env['IBKR_BASE_URL'],
      sessionToken: process.env['IBKR_SESSION_TOKEN'],
    });
  }

  if (exchangeId.toLowerCase() === 'longbridge') {
    return new LongbridgeAdapter({
      accessToken: process.env['LONGBRIDGE_ACCESS_TOKEN'] ?? process.env['LONGBRIDGE_TOKEN'],
      baseUrl: process.env['LONGBRIDGE_HTTP_URL'],
    });
  }

  // Hyperliquid: native adapter (launch venue). Read-only until a signing
  // key is provided; testnet supported via HYPERLIQUID_REST_URL override.
  if (exchangeId.toLowerCase() === 'hyperliquid') {
    return new HyperliquidAdapter({
      walletAddress:
        (authConfig?.walletAddress as string | undefined) ??
        process.env['HYPERLIQUID_WALLET_ADDRESS'] ??
        process.env['HYPERLIQUID_PUBLIC_KEY'] ??
        '',
      privateKey:
        (authConfig?.privateKey as string | undefined) ??
        process.env['HYPERLIQUID_PRIVATE_KEY'],
      restUrl: process.env['HYPERLIQUID_REST_URL'],
    });
  }

  return new CCXTAdapter({ exchangeId, apiKey, secret, sandbox: isPaper });
}

async function seedPaperMarketFeed(
  paperEngine: PaperEngine,
  exchange: ExchangeAdapter,
  symbol: string,
  timeframe: string,
  logger: Logger,
): Promise<void> {
  const candles = await exchange.fetchOHLCV({ symbol, timeframe, limit: 120 });
  if (candles.length === 0) {
    throw new Error(`No OHLCV data returned for ${symbol} on ${timeframe}`);
  }

  const ohlcv = candles.map(([timestamp, open, high, low, close, volume]) => ({
    timestamp,
    open,
    high,
    low,
    close,
    volume,
  }));

  const startDate = new Date(ohlcv[0]!.timestamp);
  const endDate = new Date(ohlcv[ohlcv.length - 1]!.timestamp);
  await paperEngine.initialize(symbol, ohlcv, startDate, endDate);
  logger.info(`Seeded paper feed for ${symbol} on ${timeframe} with ${ohlcv.length} candles`);
}

async function buildFallbackPaperStrategy(
  exchange: ExchangeAdapter,
  logger: Logger,
): Promise<SkillManifest | null> {
  const marketsResponse = await exchange.fetchMarkets().catch((error: unknown) => {
    logger.warn(`Fallback strategy scan could not fetch markets: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });

  const rawMarkets = marketsResponse && typeof marketsResponse === 'object'
    ? (marketsResponse as { markets?: unknown }).markets
    : null;
  const markets = Array.isArray(rawMarkets) ? rawMarkets : [];
  if (markets.length === 0) {
    return null;
  }

  const capabilities = await exchange.capabilities().catch(() => ({}));
  const supportedTimeframes = normalizeSupportedTimeframes(capabilities);
  const candidates = markets
    .map((market) => normalizeMarketCandidate(market))
    .filter((market): market is NormalizedMarketCandidate => market !== null)
    .slice(0, 12);

  let best: FallbackStrategyCandidate | null = null;
  for (const market of candidates) {
    for (const timeframe of supportedTimeframes) {
      try {
        const candles = await exchange.fetchOHLCV({ symbol: market.symbol, timeframe, limit: 120 });
        const scored = scoreFallbackCandles(candles);
        if (!scored) continue;
        if (!best || scored.score > best.score) {
          best = {
            symbol: market.symbol,
            timeframe,
            ...scored,
          };
        }
      } catch (error) {
        logger.debug(
          `Fallback strategy scan skipped ${market.symbol} @ ${timeframe}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  if (!best) {
    return null;
  }

  const notional = 100;
  const quantity = Math.max(0.0001, notional / best.close);
  const stopDistance = Math.min(0.03, Math.max(0.01, best.volatility));
  const takeDistance = Math.max(stopDistance * 1.8, 0.02);
  const longSide = best.bias === 'bullish';
  const entryPrice = best.close;

  return {
    id: `fallback-${exchange.id}-${best.symbol.replace(/\W+/g, '-')}-${best.timeframe}-${Date.now()}`,
    venue: exchange.id,
    symbol: best.symbol,
    timeframe: best.timeframe,
    entry: {
      type: 'market',
      bias: best.bias,
      momentumScore: Number(best.score.toFixed(4)),
      rationale: 'Exchange-fallback market scan selected this instrument because the planner returned no usable strategy.',
    },
    exits: longSide
      ? {
          stopLoss: Number((entryPrice * (1 - stopDistance)).toFixed(8)),
          takeProfit: Number((entryPrice * (1 + takeDistance)).toFixed(8)),
        }
      : {
          stopLoss: Number((entryPrice * (1 + stopDistance)).toFixed(8)),
          takeProfit: Number((entryPrice * (1 - takeDistance)).toFixed(8)),
        },
    sizing: { amount: Number(quantity.toFixed(8)) },
    risk: {
      maxPositionNotional: notional,
      maxDailyLoss: notional * 0.02,
      maxOpenOrders: 1,
    },
    executionMode: 'paper',
  } satisfies SkillManifest;
}

type NormalizedMarketCandidate = {
  symbol: string;
};

type FallbackStrategyCandidate = {
  symbol: string;
  timeframe: string;
  score: number;
  bias: 'bullish' | 'bearish';
  close: number;
  volatility: number;
};

function normalizeSupportedTimeframes(capabilities: Record<string, unknown>): string[] {
  const preferred = ['5m', '15m', '1h', '4h'];
  const raw = Array.isArray(capabilities.timeframes) ? capabilities.timeframes : [];
  const supported = raw
    .map((value) => String(value))
    .filter((value) => preferred.includes(value));
  return supported.length > 0 ? supported : preferred;
}

function normalizeMarketCandidate(market: unknown): NormalizedMarketCandidate | null {
  if (!market || typeof market !== 'object') return null;
  const symbol = (market as { symbol?: unknown }).symbol;
  const status = (market as { status?: unknown }).status;
  const quoteCurrency = (market as { quoteCurrency?: unknown }).quoteCurrency;
  if (typeof symbol !== 'string' || symbol.trim().length === 0) return null;
  if (status !== 'active' && status !== 'open' && status !== undefined) return null;
  if (typeof quoteCurrency === 'string' && !['USD', 'USDT', 'USDC', 'USDⓈ'].includes(quoteCurrency)) {
    return null;
  }
  return { symbol };
}

function scoreFallbackCandles(
  candles: Array<[number, number, number, number, number, number]>,
): { score: number; bias: 'bullish' | 'bearish'; close: number; volatility: number } | null {
  if (candles.length < 30) {
    return null;
  }

  const closes = candles.map((candle) => candle[4]);
  const lastClose = closes[closes.length - 1]!;
  const firstClose = closes[0]!;
  const lookback = Math.min(20, closes.length - 1);
  const recentClose = closes[closes.length - 1 - lookback]!;
  const fastSlice = closes.slice(-8);
  const slowSlice = closes.slice(-24);

  const fastAverage = fastSlice.reduce((sum, close) => sum + close, 0) / fastSlice.length;
  const slowAverage = slowSlice.reduce((sum, close) => sum + close, 0) / slowSlice.length;
  const momentum = (lastClose - recentClose) / recentClose;
  const trend = (fastAverage - slowAverage) / lastClose;
  const range = candles.slice(-20).reduce((sum, candle) => sum + ((candle[2] - candle[3]) / candle[4]), 0) / 20;
  const realized = Math.abs((lastClose - firstClose) / firstClose);

  const score = Math.abs(momentum) * 0.45 + Math.abs(trend) * 0.35 + realized * 0.2 + range * 0.1;
  const bias = momentum + trend >= 0 ? 'bullish' : 'bearish';

  return {
    score,
    bias,
    close: lastClose,
    volatility: Math.max(0.01, Math.min(0.05, range || realized || Math.abs(momentum) || 0.02)),
  };
}

function summarizePaperPortfolio(paperEngine: PaperEngine, initialBalance = 10000): string {
  const portfolio = paperEngine.getPortfolio();
  const roi = initialBalance > 0 ? ((portfolio.equity - initialBalance) / initialBalance) * 100 : 0;
  return `Paper portfolio: equity=${portfolio.equity.toFixed(2)}, balance=${portfolio.balance.toFixed(2)}, pnl=${portfolio.totalPnL.toFixed(2)}, roi=${roi.toFixed(2)}%`;
}

/**
 * Build per-job tool policy. Merges job-level scoping with pipeline defaults.
 * Per-job allowedTools/disallowedTools OVERRIDE pipeline defaults.
 */
export function buildCronToolPolicy(
  components: RuntimeComponents,
  job: CronJob,
  logger: Logger,
): { allowTools: boolean; allowed?: string[]; disallowed?: string[] } {
  if (!components.toolRegistry) {
    return { allowTools: true };
  }

  const allToolNames = components.toolRegistry.list().map((h) => h.definition.name);
  let baseAllowed = [...allToolNames];
  let baseDisallowed: string[] = [];

  // Apply per-job overrides
  if (job.allowedTools && job.allowedTools.length > 0) {
    baseAllowed = job.allowedTools.filter((name) => allToolNames.includes(name));
  }
  if (job.disallowedTools && job.disallowedTools.length > 0) {
    baseDisallowed = job.disallowedTools;
  }

  return {
    allowTools: true,
    allowed: baseAllowed,
    disallowed: baseDisallowed,
  };
}

/**
 * Apply tool policy for a specific cron job session.
 * Always applies recursion guard: cron create/delete/update are disallowed for ALL cron sessions.
 * Sets the policy on the exact session key so it's picked up by buildToolDefinitions().
 */
function applyCronToolPolicyForSession(
  components: RuntimeComponents,
  sessionKey: string,
  job: CronJob,
  logger: Logger,
): void {
  if (!components.agentCore || !components.toolRegistry) return;

  const policy = buildCronToolPolicy(components, job, logger);

  // ALWAYS apply recursion guard for ALL cron sessions
  const guardedDisallowed = new Set([
    ...(policy.disallowed ?? []),
    'session.send',   // prevent cron from sending messages through inbox
    'inbox.write',    // prevent cron from writing to inbox
  ]);

  // For ALL cron sessions, only allow the base 'cron' tool (not create/delete/update sub-actions)
  // This prevents cron jobs from creating more cron jobs
  const guardedAllowed = policy.allowed?.filter((name) => {
    if (name.startsWith('cron_')) return false; // block cron_create, cron_list, etc.
    return true;
  });

  // Set policy on the exact session key (which has timestamp for fresh history)
  components.agentCore.setToolPolicy(
    sessionKey,
    guardedAllowed,
    [...guardedDisallowed],
  );

  logger.info(
    `Applied cron tool policy for job ${job.id}: session=${sessionKey}, allowed=${guardedAllowed?.length ?? 'all'}, disallowed=${guardedDisallowed.size}`,
  );
}

export async function ensureTelegramCronPulseJob(
  components: RuntimeComponents,
  telegramChatId: string | undefined,
  logger: Logger,
): Promise<void> {
  if (!components.cronEngine || !telegramChatId?.trim()) {
    return;
  }

  const jobId = 'telegram-cron-pulse';
  const existing = await components.cronEngine.getJob(jobId);

  if (!existing) {
    logger.warn(`Telegram cron pulse job is missing from jobs.json; seed it there instead of runtime code.`);
    return;
  }

  const needsUpdate =
    existing.name !== 'Telegram Cron Pulse' ||
    existing.deliver?.target !== 'telegram' ||
    existing.deliver?.chatId !== telegramChatId ||
    !existing.enabled;

  if (!needsUpdate) {
    return;
  }

  await components.cronEngine.updateJob(jobId, {
    name: 'Telegram Cron Pulse',
    deliver: { target: 'telegram', chatId: telegramChatId },
    enabled: true,
  });
  logger.info(`Updated Telegram cron pulse job for chat ${telegramChatId}`);
}

// NOTE: applyCronExecutionPolicyFromPrompt has been replaced by
// buildCronToolPolicy() and applyCronToolPolicyForSession() which apply
// per-job tool scoping with recursion guard for ALL cron sessions.

export function assertExplicitMarketContext(
  strategy: SkillManifest | null | undefined,
  sourceParams: Record<string, unknown> | undefined,
  executionPolicy?: string | undefined,
): { symbol: string; timeframe: string } | null {
  if (executionPolicy === 'close-only') {
    return null;
  }

  const symbol = firstNonEmptyString(
    strategy?.symbol,
    sourceParams?.symbol,
  );
  const timeframe = firstNonEmptyString(
    strategy?.timeframe,
    sourceParams?.timeframe,
    '1h',
  );

  if (!symbol) {
    throw new Error(
      'Opening trades require a resolved symbol. Use a close-only execution policy to unwind existing positions without proposing a new entry.',
    );
  }

  return { symbol, timeframe: timeframe ?? '1h' };
}

export function buildCloseOnlyOrderIntents(
  paperEngine: PaperEngine | null | undefined,
  input: {
    mode: TradeMode;
    venue: string;
    strategyId: string;
  },
): OrderIntent[] {
  if (!paperEngine) {
    return [];
  }

  const positions = paperEngine.getPortfolio().positions;
  return positions
    .filter((position) => position.quantity > 0)
    .map((position) => ({
      venue: input.venue,
      symbol: position.symbol,
      side: 'sell' as const,
      type: 'market' as const,
      quantity: position.quantity,
      strategyId: input.strategyId,
      mode: input.mode,
    }));
}

export function extractPromptField(prompt: string, pattern: RegExp): string | undefined {
  const match = prompt.match(pattern);
  return match?.[1]?.trim() || undefined;
}

function buildWorkspacePrompt(
  workspace: WorkspaceManifest,
  components: Pick<RuntimeComponents, 'modelRouter' | 'sessionManager' | 'channelManager'>,
  config: RuntimeConfig,
): string | undefined {
  const sections = [
    formatWorkspaceSection('SOUL.md', workspace.soul),
    formatWorkspaceSection('IDENTITY.md', workspace.identity),
    formatWorkspaceSection('USER.md', workspace.user),
    formatWorkspaceSection('MEMORY.md', workspace.memory),
    formatLiveRuntimeSection(workspace, components, config),
  ].filter((section): section is string => Boolean(section));

  if (sections.length === 0) {
    return undefined;
  }

  return [
    'Workspace-authored instructions follow. Prefer them over generic defaults.',
    ...sections,
  ].join('\n\n');
}

function formatLiveRuntimeSection(
  workspace: WorkspaceManifest,
  components: Pick<RuntimeComponents, 'modelRouter' | 'sessionManager' | 'channelManager'>,
  config: RuntimeConfig,
): string | undefined {
  const gatewayStatus = buildGatewayRuntimeStatus(workspace.config ?? null);
  const activeModel = components.modelRouter?.getActiveModel?.()?.trim();
  const configuredModel = typeof workspace.config?.models?.model === 'string'
    ? workspace.config.models.model.trim()
    : '';
  const configuredProvider = typeof workspace.config?.models?.provider === 'string'
    ? workspace.config.models.provider.trim()
    : '';
  const sessions = components.sessionManager?.getAllSessions?.() ?? [];
  const activeSessions = components.sessionManager?.getActiveSessions?.() ?? [];
  const channels = components.channelManager?.getAllChannels?.() ?? [];
  const sessionIds = sessions.slice(0, 3).map((session) => session.id);

  const lines = [
    '## Live runtime capsule',
    `- Mode: ${config.mode}`,
    `- Active model: ${activeModel || configuredModel || 'unknown'}`,
    configuredProvider ? `- Configured provider: ${configuredProvider}` : null,
    configuredModel ? `- Configured model: ${configuredModel}` : null,
    `- Sessions: ${activeSessions.length} active / ${sessions.length} total`,
    sessionIds.length > 0 ? `- Session ids: ${sessionIds.join(', ')}` : null,
    `- Channels: ${channels.length} loaded`,
    `- Telegram: ${gatewayStatus.telegram.detail}`,
    `- Discord: ${gatewayStatus.discord.detail}`,
    `- Agent chat: ${gatewayStatus.agentChat.detail}`,
    '- Use `session_search` to recover earlier turns or cross-session context before guessing.',
    '- Use `sessions_history` for exact transcript windows and `memory_search` for curated memory.',
    '- Do not create or promote skills at startup; only write durable skills after a loop/review proves they are warranted.',
  ].filter((line): line is string => Boolean(line));

  if (lines.length <= 1) {
    return undefined;
  }

  return lines.join('\n');
}

function fingerprintCronPrompt(prompt: string): string {
  return createHash('sha256').update(prompt.trim()).digest('hex').slice(0, 16);
}

function buildCronResumeContext(
  job: CronJob,
  state: CronJobState | null,
  promptFingerprint: string,
): string {
  if (!state) {
    return '';
  }

  if (state.promptFingerprint && state.promptFingerprint !== promptFingerprint) {
    return [
      'Persistent cron state from an earlier prompt was ignored because the prompt changed.',
      `Job: ${job.name} (${job.id})`,
      `Previous fingerprint: ${state.promptFingerprint}`,
      `Current fingerprint: ${promptFingerprint}`,
    ].join('\n');
  }

  const sections: string[] = [];
  sections.push(`Detached session: ${state.sessionId ?? `cron:${job.id}`}`);
  if (state.lastRunAt) {
    sections.push(`Last run: ${new Date(state.lastRunAt).toISOString()}`);
  }
  if (state.summary) {
    sections.push(`Last run summary:\n${truncateForPrompt(state.summary, 1200)}`);
  }
  if (state.lastOutput && state.lastOutput !== state.summary) {
    sections.push(`Last raw output:\n${truncateForPrompt(state.lastOutput, 1200)}`);
  }
  if (state.lastTrade) {
    sections.push(`Last trade:\n${JSON.stringify(state.lastTrade, null, 2)}`);
  }
  if (state.tradeHistory && state.tradeHistory.length > 0) {
    sections.push(`Recent trades:\n${JSON.stringify(state.tradeHistory.slice(-5), null, 2)}`);
  }
  if (state.lastVenue || state.lastSymbol || state.lastTimeframe) {
    sections.push([
      'Last market selection:',
      state.lastVenue ? `- Venue: ${state.lastVenue}` : null,
      state.lastSymbol ? `- Symbol: ${state.lastSymbol}` : null,
      state.lastTimeframe ? `- Timeframe: ${state.lastTimeframe}` : null,
    ].filter((value): value is string => Boolean(value)).join('\n'));
  }

  if (sections.length === 0) {
    return '';
  }

  return [
    'Persistent cron state from the previous run:',
    ...sections,
  ].join('\n\n');
}

async function persistCronJobState(
  cronEngine: CronEngine | null | undefined,
  job: CronJob,
  state: {
    promptFingerprint: string;
    prompt: string;
    sessionId: string;
    summary: string;
    lastOutput: string;
    lastStatus: 'ok' | 'error' | null;
    lastError?: string;
    lastRunAt: number;
    lastTrade?: CronTradeRecord | null;
    tradeHistory?: CronTradeRecord[] | null;
    lastVenue?: string;
    lastSymbol?: string;
    lastTimeframe?: string;
  },
): Promise<void> {
  if (!cronEngine) {
    return;
  }

  try {
    await cronEngine.updateJobState(job.id, {
      promptFingerprint: state.promptFingerprint,
      prompt: state.prompt,
      sessionId: state.sessionId,
      summary: state.summary,
      lastOutput: state.lastOutput,
      lastStatus: state.lastStatus,
      lastError: state.lastError,
      lastRunAt: state.lastRunAt,
      lastTrade: state.lastTrade ?? undefined,
      tradeHistory: state.tradeHistory ?? undefined,
      lastVenue: state.lastVenue,
      lastSymbol: state.lastSymbol,
      lastTimeframe: state.lastTimeframe,
      updatedAt: state.lastRunAt,
    });
  } catch {
    // Best effort only; runtime execution should not fail if state persistence does.
  }
}

/**
 * Execute a cron job through the full agent loop with resume context and tool policy.
 * When job.agentId or job.subagent is set, loads full agent context from registry:
 * - SOUL.md instructions
 * - Agent-level tools, memory namespaces, MCPs
 * Job-level overrides take precedence over agent-level config.
 */
async function executeCronJob(
  components: RuntimeComponents,
  prompt: string,
  job: CronJob,
  showThinking: boolean,
  logger: Logger,
): Promise<string> {
  try {
    const basePrompt = (job.prompt?.trim() || prompt).trim();
    const promptFingerprint = fingerprintCronPrompt(basePrompt);
    const cronState = components.cronEngine?.getJobState(job.id) ?? null;
    const resumeContext = buildCronResumeContext(job, cronState, promptFingerprint);

    // --- Build agent context from registry if agentId or subagent is set ---
    const agentName = job.agentId ?? job.subagent;
    let agentContextPrefix = '';

    if (agentName && components.agentRegistry) {
      const manifest = await components.agentRegistry.find(agentName);
      if (manifest) {
        // Build SOUL.md instructions prefix
        if (manifest.instructions) {
          agentContextPrefix += `# Agent: ${manifest.name}\n\n${manifest.instructions}\n\n---\n\n`;
        }

        // Merge agent-level tools with job-level overrides
        const agentTools = manifest.permissions?.allow ?? [];
        if (agentTools.length > 0 && !job.allowedTools) {
          job.allowedTools = agentTools;
        }
        if (job.disallowedTools) {
          // Agent disallowed tools are additive with job disallowed
          const agentDisallowed = manifest.permissions?.deny ?? [];
          job.disallowedTools = [...new Set([...job.disallowedTools, ...agentDisallowed])];
        }

        // Merge agent-level MCPs with job-level MCPs
        const agentMcps = (manifest as any).mcps ?? [];
        if (agentMcps.length > 0 && !job.mcps) {
          job.mcps = agentMcps;
        }

        logger.info(`Loaded agent context for ${manifest.name}: tools=${agentTools.length}, mcps=${agentMcps.length}`);
      } else {
        logger.warn(`Agent not found in registry: ${agentName}, running with job-level config only`);
      }
    }

    const effectivePrompt = agentContextPrefix + basePrompt + (resumeContext ? `\n\n${resumeContext}` : '');

    const sessionKey = `cron:${job.id}:${Date.now()}`;
    applyCronToolPolicyForSession(components, sessionKey, job, logger);

    const modelOverride = job.model ?? undefined;

    const response = await components.agentCore!.chat(
      effectivePrompt,
      {
        sessionId: sessionKey,
        templateName: 'chat',
        triggerDreamCycle: false,
        allowTools: true,
        ...(modelOverride ? { model: modelOverride } as any : {}),
      },
    );

    if (response.state === 'error') {
      throw new Error(response.content || `Cron job ${job.id} (${job.name}) failed.`);
    }

    const output = requireVisibleResponse(
      response.content,
      response.reasoningContent,
      `Cron job ${job.id} (${job.name})`,
      showThinking,
    );

    await persistCronJobState(components.cronEngine, job, {
      promptFingerprint,
      prompt: basePrompt,
      sessionId: sessionKey,
      summary: truncateForPrompt(output, 1500),
      lastOutput: output,
      lastStatus: 'ok',
      lastRunAt: Date.now(),
      lastTrade: job.lastTrade,
      tradeHistory: job.tradeHistory?.slice(-10),
      lastVenue: cronState?.lastVenue ?? components.exchange?.id,
      lastSymbol: job.lastTrade?.symbol ?? cronState?.lastSymbol,
      lastTimeframe: cronState?.lastTimeframe,
    });

    return output;
  } catch (err: any) {
    throw new Error(`Cron execution error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Wire AgentCore delegation through the AgentRegistry + ModelRouter,
 * keeping all subagent execution inside DynaTrader rather than the Terminal client.
 */
async function setupAgentDelegation(
  components: RuntimeComponents,
  logger: Logger,
  showThinking: boolean,
): Promise<void> {
  const registry = components.agentRegistry;
  const modelRouter = components.modelRouter;
  if (!registry || !modelRouter) {
    throw new Error('Cannot wire delegation without AgentRegistry and ModelRouter');
  }

  components.agentCore!.setDelegateTask(async (request) => {
    try {
      const agentName = request.agent?.trim();
      if (!agentName) {
        throw new Error('Delegation requires an explicit agent name.');
      }

      const manifest = await registry.get(agentName);
      const instructions = manifest.instructions?.trim();
      if (!instructions) {
        throw new Error(`Agent ${manifest.name} has no instructions configured`);
      }

      const response = await modelRouter.call({
        messages: [
          { role: 'system', content: instructions },
          {
            role: 'user',
            content: request.context
              ? `${request.task}\n\nContext:\n${JSON.stringify(request.context)}`
              : request.task,
          },
        ],
        maxTokens: 8192,
        temperature: 0.2,
        signal: request.signal,
      }, 'research');

      return {
        agent: manifest.name,
        content: requireVisibleResponse(response.content, response.reasoningContent, `Delegation to ${manifest.name}`, showThinking),
        reasoningContent: response.reasoningContent,
        usage: response.usage,
      };
    } catch (error) {
      const agentLabel = request.agent?.trim() || 'explicit-agent-required';
      const message = errorMessage(error);
      throw new Error(`Delegation failed for ${agentLabel}: ${message}`);
    }
  });
  logger.info('AgentCore delegation wired to isolated DynaTrader model calls');
}

/**
 * Set up A2A Runtime for agent-to-agent communication and register workspace agents as cards.
 */
async function setupA2ARuntime(
  components: RuntimeComponents,
  workspacePath: string,
  allAgents: ResolvedManifest[],
  logger: Logger,
): Promise<void> {
  logger.debug('Initializing A2ARuntime with in-process SubagentRuntime');
  const identity = await loadWorkspaceIdentity(workspacePath);
  const runtimeAgentId = identity?.name?.trim() || basename(workspacePath);
  components.a2aRuntime = new A2ARuntime({
    agentId: runtimeAgentId,
    policy: {
      enabled: true,
      allow: ['*'],
      maxPingPongTurns: 5,
      announceTimeoutMs: 300000,
      visibility: 'tree',
    },
    subagentRuntime: components.subagentRuntime ?? undefined,
  });

  for (const agent of allAgents) {
    components.a2aRuntime.registerCard({
      name: agent.name,
      version: agent.version ?? '1.0.0',
      description: agent.description ?? '',
      capabilities: {
        streaming: false,
        pushNotifications: false,
        stateTransitionHistory: false,
      },
      defaultInputModes: ['text'],
      defaultOutputModes: ['text'],
      skills: [],
    });
  }
  logger.info(`Registered ${allAgents.length} agents for A2A cross-agent communication`);
}

/**
 * Register cron-related tools: CronTool, SqliteQueryTool, GoalTool, and strategy execution template.
 */
function registerCronRelatedTools(components: RuntimeComponents, logger: Logger): void {
  if (components.toolRegistry && components.cronEngine) {
    components.toolRegistry.register(new CronTool(components.cronEngine));
    logger.info('Registered unified cron tool (cron: create/list/update/delete/pause/resume/trigger/inspect)');
  }

  if (components.toolRegistry && components.stateDb) {
    components.toolRegistry.register(new SqliteQueryTool(components.stateDb));
    logger.info('Registered sqlite_query tool for state.db introspection');
  }

  if (components.toolRegistry && components.agentCore) {
    const goalManager = components.agentCore.getGoalManager();
    if (goalManager) {
      components.toolRegistry.register(new GoalTool(goalManager));
      logger.info('Registered goal tool (goal: create/add_step/complete_step/status/list/update_step)');
    }
  }
}

function formatWorkspaceSection(name: string, content: string | undefined, maxChars = 1200): string {
  const trimmed = content?.trim();
  if (!trimmed) {
    return `## ${name}\n- unavailable`;
  }

  return `## ${name}\n\n${truncateForPrompt(trimmed, maxChars)}`;
}

function truncateForPrompt(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars).trimEnd()}\n... [truncated ${text.length - maxChars} chars]`;
}

function firstNonEmptyString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return undefined;
}

async function runWorkspaceBootChecklist(
  components: RuntimeComponents,
  workspacePath: string,
  logger: Logger,
): Promise<void> {
  if (!components.agentCore) {
    return;
  }

  const bootPath = join(workspacePath, 'BOOT.md');
  if (!existsSync(bootPath)) {
    return;
  }

  let bootChecklist: string;
  try {
    bootChecklist = readFileSync(bootPath, 'utf-8').trim();
  } catch (error) {
    logger.warn('BOOT.md detected but could not be read', error);
    return;
  }

  if (!bootChecklist) {
    logger.info('BOOT.md exists but is empty; skipping startup checklist');
    return;
  }

  try {
    const response = await components.agentCore.chat(
      [
        'You are running a startup checklist from BOOT.md.',
        'Follow the instructions exactly.',
        'If there is nothing to report, reply with exactly [SILENT].',
        '',
        bootChecklist,
      ].join('\n'),
      { sessionId: 'gateway-startup', templateName: 'chat', triggerDreamCycle: false },
    );

    const content = response.content?.trim();
    if (content && content !== '[SILENT]') {
      logger.info(`BOOT.md startup checklist result: ${content}`);
    } else {
      logger.info('BOOT.md startup checklist completed silently');
    }
  } catch (error) {
    logger.warn('BOOT.md startup checklist failed', error);
  }
}

/**
 * Initialize the Dreaming Cycle (background reflection engine + scheduler)
 * and run the BOOT.md workspace startup checklist.
 */
async function initializeDreamCycle(
  components: RuntimeComponents,
  workspacePath: string,
  logger: Logger,
): Promise<void> {
  if (!components.memoryStore || !components.skillFactory || !components.crossSessionRecall) {
    logger.warn('DreamEngine skipped: memoryStore/skillFactory/crossSessionRecall not initialized');
    return;
  }
  logger.debug('Initializing DreamEngine and DreamScheduler');
  components.dreamEngine = new DreamEngine(
    components.memoryStore,
    components.skillFactory,
    components.crossSessionRecall,
    { ...DEFAULT_DREAM_CONFIG, enabled: true, intervalMs: 5 * 60 * 1000 },
    components.memoryConsolidation ?? undefined,
  );
  components.dreamScheduler = new DreamScheduler(components.dreamEngine, {
    ...DEFAULT_DREAM_CONFIG,
    intervalMs: 5 * 60 * 1000,
  });
  components.dreamScheduler.start();
  components.agentCore?.setDreamEngine(components.dreamEngine);

  // Wire DreamEngine into the pipeline
  if (components.pipeline) {
    components.pipeline.setDreamEngine(components.dreamEngine);
    logger.debug('DreamEngine wired into TradingPipeline');
  }

  // Tool policy is now applied per-job in the executeCallback via applyCronToolPolicyForSession()
  await runWorkspaceBootChecklist(components, workspacePath, logger);

  logger.info('DreamEngine and DreamScheduler initialized and started');
}

/**
 * Construct the AgentCore and wire the execution learning observer.
 */
function initializeAgentCore(
  components: RuntimeComponents,
  workspacePath: string,
  config: RuntimeConfig,
  workspace: WorkspaceManifest,
  logger: Logger,
): void {
  const goalManager = components.stateDb
    ? new GoalManager(components.stateDb)
    : undefined;

  const memoryStore = components.memoryStore;
  const modelRouter = components.modelRouter;
  const toolRegistry = components.toolRegistry;
  if (!memoryStore || !modelRouter || !toolRegistry) {
    throw new Error('AgentCore initialization requires memoryStore, modelRouter, and toolRegistry');
  }

  components.agentCore = new AgentCore({
    memory: memoryStore,
    modelRouter,
    toolRegistry,
    defaultMode: resolveAgentDefaultMode(config.mode),
    skillFactory: components.skillFactory ?? undefined,
    crossSessionRecall: components.crossSessionRecall ?? undefined,
    skillLoader: components.skillLoader ?? undefined,
    compactionEngine: components.compactionEngine ?? undefined,
    runCardManager: components.runCardManager ?? undefined,
    goalManager,
    db: components.stateDb ?? undefined,
    workspacePath,
    workspacePrompt: buildWorkspacePrompt(workspace, components, config),
    skillManager: components.skillManager ?? undefined,
    sessionSearch: components.sessionSearch ?? undefined,
    memoryConsolidation: components.memoryConsolidation ?? undefined,
    postTurnHooks: runPostTurnHooks,
    turnController: components.turnController ?? undefined,
    steeringInbox: components.steeringInbox ?? undefined,
    reflectionRunner: components.reflectionRunner ?? undefined,
    durableTasks: components.durableTasks ?? undefined,
    daemonSessions: components.daemonSessions ?? undefined,
    agentMessaging: components.agentMessaging ?? undefined,
    continualHarness: components.continualHarness ?? undefined,
    memoryFabric: components.memoryFabric ?? undefined,
    toolResultCompressor: components.toolResultCompressor ?? undefined,
    riskGate: {
      maxLeverage: 10,
      maxPositionPct: 25,
      maxDailyLossPct: 5,
    },
  });

  if (components.executionRouter && components.agentCore) {
    const circuitForOutcomes = CheckCircuitBreakersTool.getFor(workspacePath);
    components.executionRouter.setExecutionObserver(async ({ intent, trade, executionMode }) => {
      if (!components.agentCore) {
        return;
      }

      // Feed realized PnL into the circuit breaker BEFORE the learning loop so
      // check_circuit_breakers reflects the freshest equity.
      if (typeof trade.realizedPnL === "number" && trade.realizedPnL !== 0) {
        circuitForOutcomes.recordOutcome(trade.realizedPnL);
      }

      await components.agentCore.processExecution({
        intent,
        trade,
        executionMode,
      });
    });
    logger.info('Execution learning observer wired into AgentCore learning loop + circuit breaker');
  }
}

async function buildTradingMarketContext(
  exchange: ExchangeAdapter | null,
  logger: Logger,
): Promise<{ summary: string; items: Array<Record<string, unknown>> }> {
  if (!exchange) {
    return {
      summary: 'No exchange is configured. Use connected tools and workspace context to choose a tradable market.',
      items: [],
    };
  }

  const marketsResponse = await exchange.fetchMarkets().catch((error: unknown) => {
    logger.warn(`Market universe fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });

  const rawMarkets = marketsResponse && typeof marketsResponse === 'object'
    ? ((marketsResponse as { markets?: unknown }).markets ?? marketsResponse)
    : null;
  const markets = Array.isArray(rawMarkets) ? rawMarkets : [];
  const items = markets
    .map((market) => normalizeMarketRecord(market))
    .filter((market): market is Record<string, unknown> => market !== null)
    .slice(0, 12);

  if (items.length === 0) {
    return {
      summary: 'No tradable market catalogue was returned. Choose a symbol only if the connected tools reveal one.',
      items: [],
    };
  }

  const summary = items
    .map((market, index) => {
      const symbol = String(market.symbol ?? 'unknown');
      const status = market.status ? `, status=${String(market.status)}` : '';
      const tradable = market.tradable !== undefined ? `, tradable=${String(market.tradable)}` : '';
      const type = market.type ? `, type=${String(market.type)}` : '';
      return `${index + 1}. ${symbol}${type}${status}${tradable}`;
    })
    .join('\n');

  return { summary, items };
}

async function resolvePipelineMarketContext(
  exchange: ExchangeAdapter | null,
  logger: Logger,
): Promise<{ symbol: string; timeframe: string }> {
  if (!exchange) {
    throw new Error('Cannot resolve a pipeline market context without an exchange adapter');
  }

  const fallbackStrategy = await buildFallbackPaperStrategy(exchange, logger).catch((error: unknown) => {
    logger.warn(`Pipeline market fallback failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });

  if (fallbackStrategy) {
    return {
      symbol: fallbackStrategy.symbol,
      timeframe: fallbackStrategy.timeframe ?? '1h',
    };
  }

  const marketContext = await buildTradingMarketContext(exchange, logger);
  const symbol = String(marketContext.items[0]?.symbol ?? '').trim();
  if (!symbol) {
    throw new Error('Unable to resolve a tradable symbol for the pipeline');
  }

  return { symbol, timeframe: '1h' };
}

// normalizeMarketRecord imported from ../../market/utils

// ---------------------------------------------------------------------------
// Event bus wiring
// ---------------------------------------------------------------------------

function setupEventBusListeners(components: RuntimeComponents, logger: Logger): void {
  const bus = components.eventBus!;

  bus.on('trade', async (event: TradeEvent) => {
    if (components.auditTrail) {
      await components.auditTrail.record({
        type: 'execution',
        actor: 'exchange',
        actorType: 'system',
        action: `trade:${event.type}`,
        resource: event.type,
        result: 'success',
        details: event.data,
      });
    }
  });

  bus.on('risk', async (event: RiskEvent) => {
    if (components.auditTrail) {
      await components.auditTrail.record({
        type: 'decision',
        actor: 'risk-engine',
        actorType: 'system',
        action: `risk:${event.type}`,
        resource: event.type,
        result: event.type === 'risk_check_failed' ? 'failure' : 'success',
        details: event.data,
      });
    }
  });

  logger.debug('Event bus listeners wired');
}

// ---------------------------------------------------------------------------
// Default pipeline agent handlers
// ---------------------------------------------------------------------------

function registerDefaultPipelineHandlers(
  components: RuntimeComponents,
  config: RuntimeConfig,
  logger: Logger,
  agents: ResolvedManifest[],
): void {
  if (!components.pipeline) return;

  const bindings = inferPipelineAgents(agents);
  const bound = new Set<string>();

  for (const agent of agents) {
    const phase = classifyPipelineAgent(agent);
    if (!phase || bound.has(agent.name)) continue;
    if (!bindings[phase].includes(agent.name)) continue;

    components.pipeline.on(agent.name, async (input: any) =>
      executeDelegatedPipelineAgent(components, config, agent.name, input)
    );

    bound.add(agent.name);
  }

  logger.info(
    `Pipeline handlers registered from workspace agents: ` +
      `research=${bindings.research.join(', ') || 'none'}, ` +
      `analysis=${bindings.analysis.join(', ') || 'none'}, ` +
      `risk=${bindings.risk.join(', ') || 'none'}`,
  );
}

function inferPipelineAgents(agents: ResolvedManifest[]): {
  research: string[];
  analysis: string[];
  risk: string[];
} {
  const phases = {
    research: [] as string[],
    analysis: [] as string[],
    risk: [] as string[],
  };

  for (const agent of agents) {
    const phase = classifyPipelineAgent(agent);
    if (!phase) continue;
    phases[phase].push(agent.name);
  }

  return phases;
}

function classifyPipelineAgent(agent: ResolvedManifest): 'research' | 'analysis' | 'risk' | null {
  const text = [
    agent.name,
    agent.description,
    agent.instructions,
    ...agent.outputs,
    agent.team,
    agent.reportsTo,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const researchSignals = ['research', 'discover', 'scout', 'explore', 'hypothesis', 'market data'];
  const analysisSignals = ['analysis', 'analyst', 'sentiment', 'technical', 'pattern', 'SkillManifest', 'validation'];
  const riskSignals = ['risk', 'safety', 'compliance', 'guard', 'review', 'policy'];

  const hasRisk = agent.riskLevel === 'high' || agent.riskLevel === 'critical' || riskSignals.some((signal) => text.includes(signal));
  if (hasRisk) return 'risk';

  const hasResearch =
    agent.outputs.includes('Hypothesis') ||
    agent.outputs.includes('Observation') ||
    researchSignals.some((signal) => text.includes(signal));
  if (hasResearch) return 'research';

  const hasAnalysis =
    agent.outputs.includes('SkillManifest') ||
    agent.outputs.includes('ValidationResult') ||
    analysisSignals.some((signal) => text.includes(signal));
  if (hasAnalysis) return 'analysis';

  return null;
}

async function executeDelegatedPipelineAgent(
  components: RuntimeComponents,
  config: RuntimeConfig,
  agentName: string,
  input: any,
): Promise<unknown> {
  if (!components.subagentRuntime) {
    throw new Error(`SubagentRuntime not initialized - cannot execute ${agentName}`);
  }
  const context = await components.subagentRuntime.executeAgent(agentName, config.mode, input);
  if (!context) {
    throw new Error(`${agentName} returned no result${input?.symbol ? ` for ${input.symbol}` : ''}`);
  }
  return context;
}

function getConfiguredMcpServers(workspace: WorkspaceManifest): MCPServerConfig[] {
  const config = workspace.config as Record<string, unknown> | undefined;
  const mcpConfig = (config?.mcp as Record<string, unknown> | undefined) ?? {};
  const direct = Array.isArray(mcpConfig.servers)
    ? (mcpConfig.servers as Array<Record<string, unknown>>)
    : [];
  const legacy = Array.isArray(config?.["mcpServers"])
    ? (config?.["mcpServers"] as Array<Record<string, unknown>>)
    : [];
  const raw = direct.length > 0 ? direct : legacy;

  return raw
    .map((server): MCPServerConfig => ({
      name: String(server.name ?? '').trim(),
      transport: server.transport === 'http' ? 'http' : 'stdio',
      command: typeof server.command === 'string' ? server.command : undefined,
      args: Array.isArray(server.args) ? (server.args as unknown[]).map(String) : undefined,
      url: typeof server.url === 'string' ? server.url : undefined,
      env: server.env && typeof server.env === 'object' ? (server.env as Record<string, string>) : undefined,
      envFilter: Array.isArray(server.envFilter) ? (server.envFilter as unknown[]).map(String) : undefined,
      includeTools: Array.isArray(server.includeTools) ? (server.includeTools as unknown[]).map(String) : undefined,
      excludeTools: Array.isArray(server.excludeTools) ? (server.excludeTools as unknown[]).map(String) : undefined,
      enabled: typeof server.enabled === 'boolean' ? server.enabled : undefined,
    }))
    .filter((server) => server.name.length > 0 && server.enabled !== false);
}

async function registerMcpTools(
  components: RuntimeComponents,
  config: RuntimeConfig,
  logger: Logger,
  servers: MCPServerConfig[],
): Promise<void> {
  const mcpRuntime = components.mcpRuntime;
  if (!mcpRuntime) return;

  const registry = components.toolRegistry!;
  for (const server of servers) {
    await mcpRuntime.registerServer(server);
  }

  const connected = await mcpRuntime.connectServers();
  const failures: string[] = [];
  let registeredCount = 0;

  for (const server of servers) {
    try {
      if (!connected.includes(server.name)) {
        throw new Error(`MCP server '${server.name}' did not connect`);
      }
      const tools = await mcpRuntime.discoverTools(server.name);
      if (tools.length === 0) {
        throw new Error(`MCP server '${server.name}' exposed no usable tools`);
      }
      for (const tool of tools) {
        registry.register(createMcpToolHandler(mcpRuntime, tool, config.mode));
        registeredCount += 1;
      }
      logger.info(`Registered ${tools.length} MCP tool(s) from ${server.name}`);
    } catch (error) {
      const message = errorMessage(error);
      failures.push(`${server.name}: ${message}`);
      logger.error(`Failed to register MCP server ${server.name}`, error);
    }
  }

  if (failures.length > 0 && registeredCount === 0) {
    throw new Error(`No MCP servers are usable: ${failures.join('; ')}`);
  }

  if (failures.length > 0) {
    logger.warn(`Some MCP servers were not usable: ${failures.join('; ')}`);
  }
}

async function initializeWalletInfrastructure(
  components: RuntimeComponents,
  config: RuntimeConfig,
  logger: Logger,
): Promise<void> {
  logger.debug('Initializing Wallet & DEX infrastructure');
  try {
    const walletEnvVar = config.walletPrivateKeyEnvVar ?? 'WALLET_PRIVATE_KEY';
    const walletChains: SupportedChainId[] = config.walletChains ?? [
      SupportedChainId.ETHEREUM,
      SupportedChainId.POLYGON,
      SupportedChainId.ARBITRUM,
      SupportedChainId.BASE,
    ];

    components.walletManager = new WalletManager({
      privateKeyEnvVar: walletEnvVar,
      chains: walletChains,
    });

    if (process.env[walletEnvVar]) {
      await components.walletManager.initialize();
      logger.info(`Wallet initialized for address ${components.walletManager.getAddress()}`);
    } else {
      const missingWalletMessage = `Wallet private key not found in ${walletEnvVar} - wallet tools will be unavailable`;
      if (config.mode === 'paper') {
        logger.info(`${missingWalletMessage} (paper mode)`);
      } else {
        logger.warn(missingWalletMessage);
      }
    }

    components.approvalManager = new ApprovalManager(components.walletManager);
    components.txPipeline = new TxPipeline(
      components.walletManager,
      components.approvalManager,
      {
        logger: (stage, message) => logger.debug(`[tx-pipeline:${stage}] ${message}`),
      },
    );

    components.dexAdapters = new Map();
    components.dexAdapters.set('uniswap', new UniswapAdapter());
    components.dexAdapters.set('0x', new ZeroXAdapter());

    if (components.toolRegistry && components.walletManager) {
      components.toolRegistry.register(new WalletBalanceTool(components.walletManager));
      components.toolRegistry.register(new WalletSwapTool(
        components.walletManager,
        components.txPipeline,
        components.dexAdapters,
        components.stateDb ?? undefined,
      ));
      components.toolRegistry.register(new WalletApproveTool(components.approvalManager));
      components.toolRegistry.register(new WalletHistoryTool(components.walletManager));
      components.toolRegistry.register(new WalletQuoteTool(components.dexAdapters));
      logger.info('Registered wallet tools (wallet_balance, wallet_swap, wallet_approve, wallet_history, wallet_quote)');
    }
  } catch (error) {
    logger.warn('Wallet infrastructure initialization failed (non-fatal)', error);
  }
}

function initializeLearningLoopComponents(
  components: RuntimeComponents,
  workspace: WorkspaceManifest,
  workspacePath: string,
  logger: Logger,
): void {
  if (!components.memoryStore) {
    throw new Error('Learning loop initialization requires memoryStore');
  }
  logger.debug('Initializing Learning Loop components');
  components.skillFactory = new SkillFactory({
    workspacePath,
    defaultVenue:
      workspace.config?.exchange?.id ??
      workspace.adapters.find((a) => a.type === 'broker' || a.type === 'execution' || a.type === 'market_data')?.name ??
      '',
    defaultRisk: workspace.config?.risk
      ? {
          maxPositionNotional: workspace.config.risk.maxPositionNotional,
          maxDailyLoss: workspace.config.risk.maxDailyLoss,
          maxOpenOrders: workspace.config.risk.maxOpenOrders,
        }
      : undefined,
  });
  components.crossSessionRecall = new CrossSessionRecall(components.memoryStore);
  components.runCardManager = new RunCardManager(workspacePath);
  logger.info('Learning Loop components initialized');
}

function createMcpToolHandler(
  mcpRuntime: MCPRuntime,
  tool: MCPToolDefinition,
  mode: RuntimeConfig['mode'],
): ToolHandler {
  return {
    definition: {
      name: tool.name,
      description: tool.description,
      category: tool.category === 'execution' ? 'execution' : 'market',
      inputSchema: tool.inputSchema,
      outputSchema: {},
      permissionsRequired: [],
      sideEffects: [],
      riskLevel: tool.riskLevel,
      timeoutMs: 120_000,
      canRunInParallel: tool.riskLevel === 'low',
      readOnly: tool.riskLevel === 'low',
    } as ToolDefinition,
    async execute(call: ToolCall): Promise<ToolResult> {
      const result = await mcpRuntime.callTool(tool.name, {
        caller: 'agent-core',
        callerType: 'tool',
        args: call.args,
        mode,
      });

      return {
        success: result.success,
        data: result.data,
        error: result.error,
        durationMs: result.durationMs,
        truncated: false,
      };
    },
  };
}
