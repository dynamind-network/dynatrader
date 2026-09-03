import { Logger } from './logger';
import type { WorkspaceManager } from './workspace-manager';
import type { KanbanBoard } from './kanban-board';
import type { CronEngine } from '@dyna/agent-cron';
import type { DreamEngine, DreamReport } from '../../agent/dream/index';

// ---------------------------------------------------------------------------
// Minimal types to avoid circular dependency with subagent-runtime
// ---------------------------------------------------------------------------

export interface PipelineDecision {
  action: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  reasoning: string;
}

export interface PipelineResult {
  symbol: string;
  timeframe: string;
  research: PhaseResult;
  analysis: PhaseResult;
  risk: PhaseResult;
  decision: PipelineDecision;
  totalExecutionTimeMs: number;
}

export interface PhaseResult {
  pattern: string;
  agentOutputs: Record<string, unknown>;
  finalOutput: unknown;
  executionTimeMs: number;
}

// ---------------------------------------------------------------------------
// Agent handler type
// ---------------------------------------------------------------------------

export type AgentHandler = (
  input: unknown,
  context: { agentName: string; allOutputs: Map<string, unknown> },
) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface TradingPipelineConfig {
  workspacePath: string;
  mode: 'research' | 'backtest' | 'paper' | 'live';
  researchAgents?: string[];
  analysisAgents?: string[];
  riskAgents?: string[];
  marketContextResolver?: () => Promise<{ symbol: string; timeframe: string }>;
  /** Optional WorkspaceManager for workspace validation on pipeline start */
  workspaceManager?: WorkspaceManager;
  /** Optional KanbanBoard for tracking pipeline runs as tasks */
  kanbanBoard?: KanbanBoard;
  /** Optional CronEngine for registering recurring pipeline tasks */
  cronEngine?: CronEngine;
  /** Optional DreamEngine for running background dreaming cycles */
  dreamEngine?: DreamEngine;
}

// ---------------------------------------------------------------------------
// Agent output shape helpers (for type-safe synthesis)
// ---------------------------------------------------------------------------

interface ResearchOutput {
  type: string;
  symbol: string;
  timeframe: string;
  hypotheses: Array<{ type: string; direction: string; confidence: number }>;
  analysis: string;
  confidence: number;
}

interface AnalysisOutput {
  type: string;
  symbol: string;
  indicators: Record<string, unknown>;
  signals: Array<{ type: string; confidence: number }>;
  support: number[];
  resistance: number[];
}

interface RiskOutput {
  type: string;
  riskScore: number;
  riskLevel: string;
  maxPositionSize: number;
  stopLoss: number;
  takeProfit: number;
  factors: string[];
  recommendation: string;
}

// ---------------------------------------------------------------------------
// TradingPipeline (zero external deps - no subagent-runtime import)
// ---------------------------------------------------------------------------

/**
 * Multi-agent trading pipeline that coordinates research, analysis, and risk
 * agents through a lightweight internal pipeline executor.
 *
 * This class deliberately avoids importing from @dyna/subagent-runtime
 * to prevent a circular dependency with @dyna/workspace.  The runtime
 * creates a TradingPipeline and registers agent handlers that delegate to the
 * SubagentRuntime when needed.
 */
export class TradingPipeline {
  private handlers: Map<string, AgentHandler> = new Map();
  private config: TradingPipelineConfig;
  private logger = new Logger('TradingPipeline');

  /** Optional WorkspaceManager for workspace validation */
  private workspaceManager: WorkspaceManager | null = null;
  /** Optional KanbanBoard for pipeline task tracking */
  private kanbanBoard: KanbanBoard | null = null;
  /** Optional CronEngine for recurring pipeline tasks */
  private cronEngine: CronEngine | null = null;
  /** Optional DreamEngine for background dreaming cycles */
  private dreamEngine: DreamEngine | null = null;

  constructor(config: TradingPipelineConfig) {
    this.config = config;
    this.workspaceManager = config.workspaceManager ?? null;
    this.kanbanBoard = config.kanbanBoard ?? null;
    this.cronEngine = config.cronEngine ?? null;
    this.dreamEngine = config.dreamEngine ?? null;
  }

  /**
   * Set the DreamEngine after construction (useful when the DreamEngine
   * is initialized after the TradingPipeline).
   */
  setDreamEngine(dreamEngine: DreamEngine): this {
    this.dreamEngine = dreamEngine;
    return this;
  }

  // -------------------------------------------------------------------------
  // Handler registration
  // -------------------------------------------------------------------------

  /**
   * Register a handler for a given agent name.  The handler will be called
   * when the pipeline needs that agent to process input.
   */
  on(agentName: string, handler: AgentHandler): this {
    this.handlers.set(agentName, handler);
    return this;
  }

  /**
   * Register multiple handlers at once.
   */
  registerHandlers(map: Record<string, AgentHandler>): this {
    for (const [name, handler] of Object.entries(map)) {
      this.on(name, handler);
    }
    return this;
  }

  // -------------------------------------------------------------------------
  // Recurring tasks (CronEngine integration)
  // -------------------------------------------------------------------------

  /**
   * Register recurring pipeline tasks on the CronEngine.
   *
   * Registers:
   * - Market data refresh (every 5 minutes)
   * - Strategy evaluation (every 30 minutes)
   * - Portfolio rebalance check (every hour)
   * - Daily performance report (at 9:00 AM)
   *
   * @returns Array of created CronJob IDs, or empty array if cronEngine is not available.
   */
  async registerRecurringTasks(): Promise<string[]> {
    if (!this.cronEngine) {
      this.logger.warn('CronEngine not available — skipping recurring task registration');
      return [];
    }

    const jobs = await Promise.all([
      this.cronEngine.createJob({
        name: 'market-data-refresh',
        prompt: 'Refresh market data for all tracked symbols',
        schedule: 'every 5m',
        tags: ['pipeline', 'market-data'],
      }),
      this.cronEngine.createJob({
        name: 'strategy-evaluation',
        prompt: 'Evaluate all active trading strategies against current market conditions',
        schedule: 'every 30m',
        tags: ['pipeline', 'strategy'],
      }),
      this.cronEngine.createJob({
        name: 'portfolio-rebalance-check',
        prompt: 'Check portfolio allocations and determine if rebalancing is needed',
        schedule: 'every 1h',
        tags: ['pipeline', 'portfolio'],
      }),
      this.cronEngine.createJob({
        name: 'daily-performance-report',
        prompt: 'Generate a daily performance report for all active positions and strategies',
        schedule: '0 9 * * *',
        tags: ['pipeline', 'reporting'],
      }),
    ]);

    const jobIds = jobs.map((j) => j.id);
    this.logger.info(`Registered ${jobIds.length} recurring pipeline tasks`);
    return jobIds;
  }

  /**
   * Register the daily dreaming cycle task on the CronEngine.
   *
   * Runs at 2:00 AM by default to perform background reflection on
   * the previous day's trades and learnings.
   *
   * @returns The created CronJob ID, or empty string if cronEngine is not available.
   */
  async registerDreamingTask(): Promise<string> {
    if (!this.cronEngine) {
      this.logger.warn('CronEngine not available — skipping dreaming task registration');
      return '';
    }

    const job = await this.cronEngine.createJob({
      name: 'daily-dreaming-cycle',
      prompt: 'Run the daily dreaming cycle to reflect on past trades, consolidate learnings, prune weak skills, and generate new insights',
      schedule: '0 2 * * *',
      tags: ['pipeline', 'dreaming'],
    });

    this.logger.info(`Registered dreaming task: ${job.id}`);
    return job.id;
  }

  /**
   * Trigger a dreaming cycle immediately on the configured DreamEngine.
   *
   * @returns The DreamReport from the cycle, or null if DreamEngine is not available.
   */
  async triggerDream(): Promise<DreamReport | null> {
    if (!this.dreamEngine) {
      this.logger.warn('DreamEngine not available — cannot trigger dreaming cycle');
      return null;
    }

    this.logger.info('Triggering manual dreaming cycle from pipeline');
    return this.dreamEngine.runDreamCycle();
  }

  // -------------------------------------------------------------------------
  // Kanban task integration
  // -------------------------------------------------------------------------

  /**
   * Create a KanbanBoard task for a pipeline run.
   *
   * @param name        Short title for the task.
   * @param description Detailed description of the pipeline run.
   * @returns The created task ID, or empty string if kanbanBoard is not available.
   */
  async createPipelineTask(name: string, description: string): Promise<string> {
    if (!this.kanbanBoard) {
      this.logger.warn('KanbanBoard not available — skipping task creation');
      return '';
    }

    const task = this.kanbanBoard.createTask({
      workspaceId: this.config.workspacePath,
      title: name,
      description,
      status: 'todo',
      priority: 'high',
      tags: ['pipeline'],
    });

    this.logger.info(`Created pipeline Kanban task: ${task.id} — "${name}"`);
    return task.id;
  }

  // -------------------------------------------------------------------------
  // Pipeline execution
  // -------------------------------------------------------------------------

  /**
   * Execute the full multi-agent trading pipeline using an internally
   * resolved market context.
   *
   * If a KanbanBoard is configured, a task is created and tracked through
   * pipeline stages.
   */
  async execute(): Promise<PipelineResult> {
    const startTime = performance.now();
    const marketContext = await this.resolveMarketContext();
    const { symbol, timeframe } = marketContext;

    // Create Kanban task if board is available
    let taskId: string | undefined;
    if (this.kanbanBoard) {
      taskId = await this.createPipelineTask(
        `Pipeline: ${symbol} ${timeframe}`,
        `Multi-agent pipeline execution for ${symbol} on ${timeframe} timeframe`,
      );
      if (taskId) {
        this.kanbanBoard.transitionTask(taskId, 'running', 'pipeline');
      }
    }

    const input = {
      symbol,
      timeframe,
      timestamp: new Date().toISOString(),
    };

    // Phase 1: Research
    this.logger.info(`Phase 1: Research for ${symbol}`);
    const researchAgents = this.config.researchAgents ?? this.resolvePhaseAgents('research');
    const research = await this.runPhase(researchAgents, input);

    // Phase 2: Analysis (consumes research output)
    this.logger.info(`Phase 2: Analysis for ${symbol}`);
    const analysisAgents = this.config.analysisAgents ?? this.resolvePhaseAgents('analysis');
    const analysisInput = { ...input, research: research.finalOutput };
    const analysis = await this.runPhase(analysisAgents, analysisInput);

    // Phase 3: Risk evaluation (consumes both prior outputs)
    this.logger.info(`Phase 3: Risk evaluation for ${symbol}`);
    const riskAgents = this.config.riskAgents ?? this.resolvePhaseAgents('risk');
    const riskInput = {
      ...input,
      research: research.finalOutput,
      analysis: analysis.finalOutput,
    };
    const risk = await this.runPhase(riskAgents, riskInput);

    // Phase 4: Decision synthesis
    const decision = this.synthesizeDecision(research, analysis, risk);
    const totalMs = Math.round(performance.now() - startTime);

    this.logger.info(
      `Pipeline complete for ${symbol}: ${decision.action} ` +
      `(confidence ${decision.confidence}, ${totalMs}ms)`,
    );

    // Mark Kanban task as done if board is available
    if (taskId && this.kanbanBoard) {
      this.kanbanBoard.transitionTask(taskId, 'done', 'pipeline');
    }

    return {
      symbol,
      timeframe,
      research,
      analysis,
      risk,
      decision,
      totalExecutionTimeMs: totalMs,
    };
  }

  private async resolveMarketContext(): Promise<{ symbol: string; timeframe: string }> {
    if (this.config.marketContextResolver) {
      const resolved = await this.config.marketContextResolver();
      if (resolved.symbol.trim() && resolved.timeframe.trim()) {
        return resolved;
      }
    }

    throw new Error("No market context resolver is configured for the trading pipeline");
  }

  // -------------------------------------------------------------------------
  // Internal pipeline executor (no subagent-runtime dependency)
  // -------------------------------------------------------------------------

  private async runPhase(
    agentNames: string[],
    initialInput: unknown,
  ): Promise<PhaseResult> {
    const start = performance.now();
    const allOutputs = new Map<string, unknown>();
    let currentInput = initialInput;

    for (const agentName of agentNames) {
      const handler = this.handlers.get(agentName);
      if (!handler) {
        this.logger.warn(`No handler registered for agent: ${agentName}, using passthrough`);
        allOutputs.set(agentName, currentInput);
        continue;
      }

      const agentStart = performance.now();
      try {
        const output = await handler(currentInput, {
          agentName,
          allOutputs,
        });
        allOutputs.set(agentName, output);
        currentInput = output;
      } catch (error) {
        this.logger.error(`Agent ${agentName} failed`, error);
        allOutputs.set(agentName, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    return {
      pattern: 'pipeline',
      agentOutputs: Object.fromEntries(allOutputs),
      finalOutput: currentInput,
      executionTimeMs: Math.round(performance.now() - start),
    };
  }

  private resolvePhaseAgents(phase: 'research' | 'analysis' | 'risk'): string[] {
    const allHandlers = Array.from(this.handlers.keys());
    const phaseMatchers: Record<typeof phase, RegExp[]> = {
      research: [/research/i, /discover/i, /scout/i, /explore/i],
      analysis: [/analysis/i, /analyst/i, /sentiment/i, /technical/i, /study/i],
      risk: [/risk/i, /safety/i, /compliance/i, /guard/i, /review/i],
    };

    const matched = allHandlers.filter((agentName) =>
      phaseMatchers[phase].some((pattern) => pattern.test(agentName))
    );

    if (matched.length > 0) {
      return [...new Set(matched)];
    }

    if (allHandlers.length === 0) {
      return [];
    }

    // Keep the pipeline usable even when the workspace uses generic agent names.
    if (phase === 'research') {
      return allHandlers.slice(0, Math.min(2, allHandlers.length));
    }

    if (phase === 'analysis') {
      return allHandlers.slice(Math.min(1, allHandlers.length - 1));
    }

    return [allHandlers[allHandlers.length - 1]!];
  }

  // -------------------------------------------------------------------------
  // Decision synthesis
  // -------------------------------------------------------------------------

  private synthesizeDecision(
    research: PhaseResult,
    analysis: PhaseResult,
    risk: PhaseResult,
  ): PipelineDecision {
    const researchOut = research.finalOutput as ResearchOutput | undefined;
    const analysisOut = analysis.finalOutput as AnalysisOutput | undefined;
    const riskOut = risk.finalOutput as RiskOutput | undefined;

    const researchConf = researchOut?.confidence ?? 0.5;
    const analysisConf = analysisOut?.signals?.[0]?.confidence ?? 0.5;
    const riskScore = riskOut?.riskScore ?? 0.5;
    const riskRec = riskOut?.recommendation ?? 'REJECTED';

    // Weighted confidence: research 30%, analysis 40%, inverse risk 30%
    const confidence =
      researchConf * 0.3 + analysisConf * 0.4 + (1 - riskScore) * 0.3;

    let action: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
    if (riskRec === 'APPROVED' && confidence > 0.7) {
      const signal = analysisOut?.signals?.[0]?.type;
      if (signal === 'BUY') action = 'BUY';
      else if (signal === 'SELL') action = 'SELL';
    }

    return {
      action,
      confidence: Math.round(confidence * 100) / 100,
      reasoning:
        `Research: ${researchConf.toFixed(2)}, ` +
        `Analysis: ${analysisConf.toFixed(2)}, ` +
        `Risk: ${riskScore.toFixed(2)}, ` +
        `Recommendation: ${riskRec}`,
    };
  }
}
