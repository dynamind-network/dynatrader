import { WorkspaceLoader } from './workspace-loader';
import { WorkspaceValidator } from './validation';
import type { RuntimeConfig, WorkspaceManifest, RuntimeStatus } from './types';
import { Logger } from './logger';
import type { StateDb } from '../../state-db/state-db';

// Component types for accessors
import type { MemoryStoreImpl } from '@dyna/memory-core';
import type { ModelRouterImpl } from '@dyna/model-router';
import type { ToolRegistryImpl } from '@dyna/tools-runtime';
import type { AgentCore, SkillFactory, CrossSessionRecall } from '@dyna/agent-core';
import type { SkillLoader } from '../../agent/skills/skill-loader';
import type { CronEngine } from '@dyna/agent-cron';
import type { PluginRuntime } from '../../runtime/plugins/plugin-runtime';
import type { PluginRegistry } from '../../plugins/registry';
import type { EventBus } from '@dyna/event-bus';
import type { OrderIntent, ExecutionResult, ExchangeAdapter } from '@dyna/contracts';
import type { ExecutionMode } from '@dyna/contracts';
import type { AuditTrail } from '@dyna/audit';
import type { PaperEngine } from '@dyna/backtest';
import type { ExecutionRouterImpl } from '@dyna/execution';
import type { DreamEngine, DreamScheduler } from '../../agent/dream/index';
import type { MemoryBridge } from '../../memory/core/memory-bridge';
import type { ContextCompactionEngine } from '../../context/context-compaction-engine';
import type { TradingPipeline, PipelineResult } from './trading-pipeline';
import type { A2ARuntime } from '@dyna/a2a-runtime';
import type { AgentRegistry } from '../../runtime/subagents/agent-registry';
import type { SubagentRuntime } from '../../runtime/subagents/index';
import type { SessionManager } from '../../gateway/channels/sessions';
import type { ChannelManager } from '../../gateway/channels/channels';
import { validateGatewayLaunchRequirements } from '../../gateway/runtime-gateway';

// Initialization logic (extracted)
import {
  initializeComponents,
  type RuntimeComponents,
} from './runtime-setup';

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------
export type { RuntimeConfig, WorkspaceManifest, RuntimeStatus } from './types';
export type {
  AgentManifest,
  SkillManifest,
  ToolManifest,
  AdapterManifest,
  PolicyManifest,
  RuntimeMode,
  RiskLevel,
  SkillStatus,
  RunStatus,
  RunVerdict,
  PermissionSet,
  ToolPermissions,
  SkillPermissions,
  MemoryPermissions,
  ArtifactType,
  SkillSecurity,
  SkillReview,
  HealthcheckConfig,
} from './types';
export { WorkspaceLoader } from './workspace-loader';
export { WorkspaceValidator } from './validation';
export { TradingPipeline } from './trading-pipeline';
export type {
  TradingPipelineConfig,
  PipelineResult,
  PipelineDecision,
} from './trading-pipeline';

// Dreaming cycle exports
export { DreamEngine, DreamScheduler, DEFAULT_DREAM_CONFIG } from '../../agent/dream/index';
export type { DreamConfig, DreamReport, DreamAction, DreamMetrics, DreamPattern } from '../../agent/dream/index';

// ---------------------------------------------------------------------------
// DynaTraderRuntime
// ---------------------------------------------------------------------------

export class DynaTraderRuntime {
  private workspaceLoader: WorkspaceLoader;
  private logger: Logger;
  private loadedWorkspace: WorkspaceManifest | null = null;

  // Component container (populated during init)
  private comp: RuntimeComponents = {
    memoryStore: null,
    modelRouter: null,
    toolRegistry: null,
    pluginRuntime: null,
    pluginRegistry: null,
    agentCore: null,
    dynaSdkInvoker: null,
    replRuntime: null,
    loopSync: false,
    exchange: null,
    paperEngine: null,
    executionRouter: null,
    eventBus: null,
    auditTrail: null,
    pipeline: null,
    a2aRuntime: null,
    agentRegistry: null,
    subagentRuntime: null,
    cronEngine: null,
    skillFactory: null,
    crossSessionRecall: null,
    skillLoader: null,
    dreamEngine: null,
    dreamScheduler: null,
    memoryBridge: null,
    compactionEngine: null,
    sessionManager: null,
    channelManager: null,
    walletManager: null,
    approvalManager: null,
    txPipeline: null,
    dexAdapters: null,
    runCardManager: null,
    mcpRuntime: null,
    mcpToolNames: [],
    stateDb: null,
    agentBus: null,
    fleetManager: null,
    skillManager: null,
    sessionSearch: null,
    memoryConsolidation: null,
    turnController: null,
    steeringInbox: null,
    reflectionRunner: null,
    daemonSessions: null,
    agentMessaging: null,
    continualHarness: null,
    memoryFabric: null,
    toolResultCompressor: null,
    degraded: false,
  };

  // Lifecycle state
  private status: RuntimeStatus['state'] = 'idle';
  private startedAt: Date | null = null;

  constructor(
    private workspacePath: string,
    private config: RuntimeConfig,
  ) {
    this.workspaceLoader = new WorkspaceLoader(workspacePath, config.statePath ?? workspacePath);
    this.logger = new Logger('DynaTraderRuntime');
  }

  // -------------------------------------------------------------------------
  // Public accessors (Runtime API)
  // -------------------------------------------------------------------------

  getAgent(): AgentCore {
    this.ensureRunning();
    return this.comp.agentCore!;
  }

  getExchange(): ExchangeAdapter {
    this.ensureRunning();
    return this.comp.exchange!;
  }

  getPaperEngine(): PaperEngine {
    this.ensureRunning();
    return this.comp.paperEngine!;
  }

  getExecutionRouter(): ExecutionRouterImpl {
    this.ensureRunning();
    return this.comp.executionRouter!;
  }

  async executeOrderIntents(
    intents: OrderIntent[],
    executionMode?: ExecutionMode,
  ): Promise<ExecutionResult[]> {
    this.ensureRunning();
    if (!this.comp.executionRouter) {
      throw new Error('ExecutionRouter not initialized');
    }
    const mode = executionMode ?? (this.config.mode as ExecutionMode);
    const results: ExecutionResult[] = [];
    for (const intent of intents) {
      const result = await this.comp.executionRouter.execute(intent, mode);
      results.push(result);
      this.logger.info(
        `Order ${result.orderId}: ${intent.side} ${intent.quantity} ${intent.symbol} -> ${result.status}`,
      );
      if (this.comp.stateDb && result.trade) {
        try {
          const now = result.timestamp.getTime();
          this.comp.stateDb.saveTrade({
            id: `order-${result.orderId}`,
            session_id: 'runtime',
            symbol: result.trade.symbol,
            side: result.trade.side === 'buy' ? 'long' : 'short',
            entry_price: result.trade.price,
            exit_price: null,
            quantity: result.trade.quantity,
            pnl: null,
            pnl_percent: null,
            status: result.status === 'filled' ? 'open' : 'cancelled',
            chain_id: null,
            tx_hash: result.orderId,
            dex: intent.venue,
            metadata: JSON.stringify({ strategyId: intent.strategyId, mode, fees: result.trade.fees }),
            opened_at: now,
            closed_at: result.status === 'filled' ? null : now,
          });
        } catch (error) {
          this.logger.warn(`Could not persist order ${result.orderId}`, error);
        }
      }
    }
    return results;
  }

  getTradeHistory(filters?: { symbol?: string; status?: string; limit?: number }) {
    this.ensureRunning();
    return this.comp.stateDb?.listTrades(filters) ?? [];
  }

  getMemory(): MemoryStoreImpl {
    this.ensureRunning();
    return this.comp.memoryStore!;
  }

  getModelRouter(): ModelRouterImpl {
    this.ensureRunning();
    return this.comp.modelRouter!;
  }

  getToolRegistry(): ToolRegistryImpl {
    this.ensureRunning();
    return this.comp.toolRegistry!;
  }

  getPluginRuntime(): PluginRuntime {
    this.ensureRunning();
    return this.comp.pluginRuntime!;
  }

  getPluginRegistry(): PluginRegistry {
    this.ensureRunning();
    return this.comp.pluginRegistry!;
  }

  getEventBus(): EventBus {
    this.ensureRunning();
    return this.comp.eventBus!;
  }

  getAuditTrail(): AuditTrail {
    this.ensureRunning();
    return this.comp.auditTrail!;
  }

  getPipeline(): TradingPipeline {
    this.ensureRunning();
    return this.comp.pipeline!;
  }

  getA2ARuntime(): A2ARuntime {
    this.ensureRunning();
    return this.comp.a2aRuntime!;
  }

  getAgentRegistry(): AgentRegistry {
    this.ensureRunning();
    return this.comp.agentRegistry!;
  }

  getStateDb(): StateDb | null {
    this.ensureRunning();
    return this.comp.stateDb;
  }

  getSubagentRuntime(): SubagentRuntime {
    this.ensureRunning();
    return this.comp.subagentRuntime!;
  }

  getCronEngine(): CronEngine {
    this.ensureRunning();
    return this.comp.cronEngine!;
  }

  getSkillFactory(): SkillFactory {
    this.ensureRunning();
    return this.comp.skillFactory!;
  }

  getCrossSessionRecall(): CrossSessionRecall {
    this.ensureRunning();
    return this.comp.crossSessionRecall!;
  }

  getSkillLoader(): SkillLoader {
    this.ensureRunning();
    return this.comp.skillLoader!;
  }

  getSessionManager(): SessionManager {
    this.ensureRunning();
    return this.comp.sessionManager!;
  }

  getChannelManager(): ChannelManager {
    this.ensureRunning();
    return this.comp.channelManager!;
  }

  getWalletManager() {
    this.ensureRunning();
    return this.comp.walletManager;
  }

  getDreamEngine(): DreamEngine {
    this.ensureRunning();
    return this.comp.dreamEngine!;
  }

  getDreamScheduler(): DreamScheduler {
    this.ensureRunning();
    return this.comp.dreamScheduler!;
  }

  getStatus(): RuntimeStatus {
    return {
      state: this.status,
      startedAt: this.startedAt ?? undefined,
      workspacePath: this.workspacePath,
      mode: this.config.mode,
      components: {
        memory: this.comp.memoryStore !== null,
        modelRouter: this.comp.modelRouter !== null,
        toolRegistry: this.comp.toolRegistry !== null,
        pluginRuntime: this.comp.pluginRuntime !== null,
        agentCore: this.comp.agentCore !== null,
        loopSync: this.comp.loopSync,
        exchange: this.comp.exchange !== null,
        eventBus: this.comp.eventBus !== null,
        auditTrail: this.comp.auditTrail !== null,
        pipeline: this.comp.pipeline !== null,
        cronEngine: this.comp.cronEngine !== null,
        skillFactory: this.comp.skillFactory !== null,
        skillReviewer: this.comp.skillLoader !== null,
        crossSessionRecall: this.comp.crossSessionRecall !== null,
        skillLoader: this.comp.skillLoader !== null,
        dreamEngine: this.comp.dreamEngine !== null,
        dreamScheduler: this.comp.dreamScheduler !== null,
        paperEngine: this.comp.paperEngine !== null,
        executionRouter: this.comp.executionRouter !== null,
        a2aRuntime: this.comp.a2aRuntime !== null,
        agentRegistry: this.comp.agentRegistry !== null,
        subagentRuntime: this.comp.subagentRuntime !== null,
        memoryBridge: this.comp.memoryBridge !== null,
        compactionEngine: this.comp.compactionEngine !== null,
        walletManager: this.comp.walletManager !== null,
        approvalManager: this.comp.approvalManager !== null,
        txPipeline: this.comp.txPipeline !== null,
        dexAdapters: this.comp.dexAdapters !== null,
        mcpRuntime: this.comp.mcpRuntime !== null,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    try {
      this.status = 'starting';
      this.logger.info('Starting DynaTrader runtime');

      await this.workspaceLoader.validateWorkspace();
      this.loadedWorkspace = await this.workspaceLoader.load();
      const workspaceValidator = new WorkspaceValidator();
      const manifestValidation = workspaceValidator.validateManifest(this.loadedWorkspace);
      if (!manifestValidation.valid) {
        throw new Error(`Workspace manifest is invalid: ${manifestValidation.errors.join('; ')}`);
      }

      if (this.loadedWorkspace.agents.length > 0) {
        const hasAgentForMode = this.loadedWorkspace.agents.some((agent) => agent.allowedModes.includes(this.config.mode));
        if (!hasAgentForMode) {
          throw new Error(`No agents support mode: ${this.config.mode}`);
        }
      }

      const modeValidationErrors: string[] = [];
      if ((this.config.requireRiskProfile || this.config.requireTradingPolicy) && !this.loadedWorkspace.user?.trim()) {
        modeValidationErrors.push(`USER.md is required for ${this.config.mode} mode`);
      }
      if (this.config.requireAuthConfig) {
        const authConfig = this.loadedWorkspace.auth;
        if (!authConfig || !authConfig.owner) {
          modeValidationErrors.push(`Auth configuration with owner is required for ${this.config.mode} mode`);
        }
        if (!authConfig || !authConfig.approval_required_for) {
          modeValidationErrors.push(`Approval configuration is required for ${this.config.mode} mode`);
        }
      }
      if (modeValidationErrors.length > 0) {
        throw new Error(`Workspace permission requirements not met: ${modeValidationErrors.join('; ')}`);
      }

      if (this.config.strictMode) {
        assertStrictMcpConfiguration(this.loadedWorkspace.config);
      }
      assertModelConfiguration(this.loadedWorkspace.config);
      const gatewayValidationErrors = validateGatewayLaunchRequirements(
        this.loadedWorkspace.config,
        process.env,
        {
          mode: this.config.mode,
          liveTradingEnabled: this.config.liveTradingEnabled,
          enableMicroLiveMode: this.config.enableMicroLiveMode,
        },
      );
      if (gatewayValidationErrors.length > 0) {
        throw new Error(`Gateway/runtime requirements not met: ${gatewayValidationErrors.join('; ')}`);
      }
      this.logger.info(
        `Workspace loaded: ${this.loadedWorkspace.agents.length} agents, ` +
        `${this.loadedWorkspace.skills.length} skills, ` +
        `${this.loadedWorkspace.loops.length} loops, ` +
        `${this.loadedWorkspace.plugins.length} plugins, ` +
        `${this.loadedWorkspace.tools.length} tools, ` +
        `${this.loadedWorkspace.adapters.length} adapters, ` +
        `${this.loadedWorkspace.policies.length} policies`,
      );

      await initializeComponents(
        this.comp,
        this.workspacePath,
        this.config,
        this.loadedWorkspace,
        this.logger,
      );

      this.startedAt = new Date();
      this.status = 'running';
      this.logger.info('Runtime started successfully');
    } catch (error) {
      this.status = 'error';
      this.logger.error('Failed to start runtime', error);
      throw error;
    }
  }

  async validateWorkspace(): Promise<void> {
    return this.workspaceLoader.validateWorkspace();
  }

  async loadWorkspace(): Promise<WorkspaceManifest> {
    if (!this.loadedWorkspace) {
      this.loadedWorkspace = await this.workspaceLoader.load();
    }
    return this.loadedWorkspace;
  }

  async shutdown(): Promise<void> {
    if (this.status !== 'running' && this.status !== 'starting') {
      return;
    }

    this.logger.info('Shutting down DynaTrader runtime');
    this.status = 'shutting-down';

    try {
      if (this.comp.replRuntime) {
        await this.comp.replRuntime.closeAll();
        this.comp.replRuntime = null;
      }

      if (this.comp.memoryStore) {
        await this.comp.memoryStore.close();
        this.logger.debug('Memory store closed');
      }

      if (this.comp.eventBus) {
        this.comp.eventBus.emit('agent', {
          type: 'strategy_proposed',
          timestamp: new Date(),
          data: { action: 'runtime_shutdown' },
        });
      }

      if (this.comp.dreamScheduler) {
        this.comp.dreamScheduler.stop();
        this.logger.debug('DreamScheduler stopped');
      }

      if (this.comp.cronEngine) {
        this.comp.cronEngine.stop();
        this.logger.debug('CronEngine stopped');
      }

      if (this.comp.stateDb) {
        try {
          this.comp.stateDb.close();
          this.logger.debug('StateDb closed');
        } catch (closeError) {
          this.logger.warn('StateDb close failed (may already be closed)', closeError);
        }
        this.comp.stateDb = null;
      }

      this.comp.pipeline = null;
      this.status = 'stopped';
      this.logger.info('Runtime shut down successfully');
    } catch (error) {
      this.logger.error('Error during shutdown', error);
      this.status = 'error';
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private ensureRunning(): void {
    if (this.status !== 'running') {
      throw new Error(
        `Runtime is not running (current state: ${this.status}). Call start() first.`,
      );
    }
  }
}

export default DynaTraderRuntime;

function assertStrictMcpConfiguration(config: unknown): void {
  const mcp = config && typeof config === 'object'
    ? (config as { mcp?: { servers?: Array<Record<string, unknown>> } }).mcp
    : undefined;
  const servers = Array.isArray(mcp?.servers) ? mcp!.servers : [];
  const enabledServers = servers.filter((server) => {
    const enabled = server.enabled;
    return enabled !== false && typeof server.name === 'string' && server.name.trim().length > 0;
  });

  if (enabledServers.length === 0) {
    throw new Error(
      'Strict mode requires at least one enabled workspace-authored MCP server in config.yaml',
    );
  }
}

function assertModelConfiguration(config: unknown): void {
  const models = config && typeof config === 'object'
    ? (config as { models?: { provider?: unknown; model?: unknown } }).models
    : undefined;
  const provider = typeof models?.provider === 'string' ? models.provider.trim() : '';
  const model = typeof models?.model === 'string' ? models.model.trim() : '';

  if (!provider || !model) {
    throw new Error(
      'Workspace config must define models.provider and models.model before runtime start',
    );
  }
}
