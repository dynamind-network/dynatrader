/**
 * Tests for Task 16: Wire Workspace + Cron into TradingPipeline.
 *
 * Verifies that:
 * - TradingPipeline accepts WorkspaceManager, KanbanBoard, and CronEngine in config
 * - TradingPipeline creates Kanban tasks for pipeline runs
 * - TradingPipeline registers recurring cron jobs
 * - Pipeline lifecycle hooks (task creation, status transitions) work correctly
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TradingPipeline } from './trading-pipeline';
import type { TradingPipelineConfig } from './trading-pipeline';
import { WorkspaceManager } from './workspace-manager';
import { CronEngine } from '@dyna/agent-cron';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestConfig(overrides: Record<string, unknown> = {}): TradingPipelineConfig {
  return {
    workspacePath: '/tmp/test-workspace',
    mode: 'paper',
    marketContextResolver: async () => ({ symbol: 'BTC/USDT', timeframe: '1h' }),
    ...overrides,
  };
}

type KanbanTask = {
  id: string;
  workspaceId: string;
  title: string;
  description: string;
  status: 'triage' | 'todo' | 'ready' | 'running' | 'done' | 'archived' | 'blocked';
  priority: 'low' | 'medium' | 'high' | 'critical';
  tags: string[];
  assignedTo: string | null;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
  heartbeatAt: number | null;
};

type KanbanEvent = {
  id: string;
  task_id: string;
  event_type: string;
  old_value: string | null;
  new_value: string | null;
  actor: string;
  created_at: number;
};

class MockKanbanBoard {
  private tasks = new Map<string, KanbanTask>();
  private events: KanbanEvent[] = [];
  private taskSeq = 0;
  private eventSeq = 0;

  createTask(spec: {
    workspaceId: string;
    title: string;
    description?: string;
    status?: KanbanTask['status'];
    priority?: KanbanTask['priority'];
    tags?: string[];
    assignedTo?: string;
  }): KanbanTask {
    const now = Date.now();
    const id = `task-${++this.taskSeq}`;
    const task: KanbanTask = {
      id,
      workspaceId: spec.workspaceId,
      title: spec.title,
      description: spec.description ?? '',
      status: spec.status ?? 'triage',
      priority: spec.priority ?? 'medium',
      tags: spec.tags ?? [],
      assignedTo: spec.assignedTo ?? null,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
      heartbeatAt: null,
    };
    this.tasks.set(id, task);
    return task;
  }

  transitionTask(taskId: string, status: KanbanTask['status'], actor = 'pipeline'): KanbanTask {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    const now = Date.now();
    const oldValue = task.status;
    task.status = status;
    task.updatedAt = now;
    task.resolvedAt = status === 'done' ? now : task.resolvedAt;
    this.events.push({
      id: `event-${++this.eventSeq}`,
      task_id: taskId,
      event_type: 'status_change',
      old_value: oldValue,
      new_value: status,
      actor,
      created_at: now,
    });
    return task;
  }

  listTasks(filter?: { status?: KanbanTask['status'] }): KanbanTask[] {
    const tasks = Array.from(this.tasks.values());
    if (!filter?.status) {
      return tasks;
    }
    return tasks.filter((task) => task.status === filter.status);
  }

  getTask(taskId: string): KanbanTask | null {
    return this.tasks.get(taskId) ?? null;
  }

  getTaskEvents(taskId: string): KanbanEvent[] {
    return this.events.filter((event) => event.task_id === taskId);
  }

  close(): void {
    this.tasks.clear();
    this.events = [];
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TradingPipeline wiring', () => {
  let testDir: string;
  /** Track mock boards so we can reset them before cleanup */
  const boardsToClose: MockKanbanBoard[] = [];

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'pipeline-wiring-test-'));
  });

  afterEach(() => {
    // Close any KanbanBoard instances to release SQLite file handles
    for (const board of boardsToClose) {
      try { board.close(); } catch { /* ignore */ }
    }
    boardsToClose.length = 0;
    rmSync(testDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Config acceptance
  // -----------------------------------------------------------------------

  describe('Config acceptance', () => {
    it('should accept WorkspaceManager in config', () => {
      const wm = new WorkspaceManager(testDir);
      const pipeline = new TradingPipeline(createTestConfig({ workspaceManager: wm }));
      expect(pipeline).toBeDefined();
      // Access the private field via any cast to verify it was stored
      expect((pipeline as any).workspaceManager).toBe(wm);
    });

    it('should accept KanbanBoard in config', () => {
      const kb = new MockKanbanBoard();
      boardsToClose.push(kb);
      const pipeline = new TradingPipeline(createTestConfig({ kanbanBoard: kb }));
      expect(pipeline).toBeDefined();
      expect((pipeline as any).kanbanBoard).toBe(kb);
    });

    it('should accept CronEngine in config', () => {
      const ce = new CronEngine(testDir);
      const pipeline = new TradingPipeline(createTestConfig({ cronEngine: ce }));
      expect(pipeline).toBeDefined();
      expect((pipeline as any).cronEngine).toBe(ce);
    });

    it('should accept all three components simultaneously', () => {
      const wm = new WorkspaceManager(testDir);
      const kb = new MockKanbanBoard();
      boardsToClose.push(kb);
      const ce = new CronEngine(testDir);
      const pipeline = new TradingPipeline(createTestConfig({
        workspaceManager: wm,
        kanbanBoard: kb,
        cronEngine: ce,
      }));
      expect(pipeline).toBeDefined();
      expect((pipeline as any).workspaceManager).toBe(wm);
      expect((pipeline as any).kanbanBoard).toBe(kb);
      expect((pipeline as any).cronEngine).toBe(ce);
    });

    it('should default to null when components are not provided', () => {
      const pipeline = new TradingPipeline(createTestConfig());
      expect((pipeline as any).workspaceManager).toBeNull();
      expect((pipeline as any).kanbanBoard).toBeNull();
      expect((pipeline as any).cronEngine).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Kanban task creation
  // -----------------------------------------------------------------------

  describe('Kanban task integration', () => {
    it('should create a Kanban task via createPipelineTask()', async () => {
      const kb = new MockKanbanBoard();
      boardsToClose.push(kb);
      const pipeline = new TradingPipeline(createTestConfig({ kanbanBoard: kb }));

      const taskId = await pipeline.createPipelineTask('Test task', 'Test description');

      expect(taskId).toBeTruthy();
      expect(typeof taskId).toBe('string');

      // Verify the task exists in the board
      const task = kb.getTask(taskId);
      expect(task).not.toBeNull();
      expect(task!.title).toBe('Test task');
      expect(task!.description).toBe('Test description');
      expect(task!.status).toBe('todo');
      expect(task!.tags).toContain('pipeline');
    });

    it('should return empty string when KanbanBoard is not available', async () => {
      const pipeline = new TradingPipeline(createTestConfig());
      const taskId = await pipeline.createPipelineTask('Test', 'Desc');
      expect(taskId).toBe('');
    });

    it('should create and track a Kanban task during pipeline execution', async () => {
      const kb = new MockKanbanBoard();
      boardsToClose.push(kb);
      const pipeline = new TradingPipeline(createTestConfig({ kanbanBoard: kb }));

      // Register handlers so the pipeline can execute
      pipeline.on('research-agent', async (input: any) => ({
        type: 'research',
        symbol: input.symbol,
        timeframe: input.timeframe,
        hypotheses: [],
        analysis: 'test',
        confidence: 0.5,
      }));
      pipeline.on('market-analyst', async (input: any) => ({
        type: 'technical_analysis',
        symbol: input.symbol,
        indicators: {},
        signals: [{ type: 'HOLD', confidence: 0.5 }],
        support: [],
        resistance: [],
      }));
      pipeline.on('risk-manager', async (_input: any) => ({
        type: 'risk_assessment',
        riskScore: 0.3,
        riskLevel: 'low',
        maxPositionSize: 0.1,
        stopLoss: 0,
        takeProfit: 0,
        factors: [],
        recommendation: 'APPROVED',
      }));

      const result = await pipeline.execute();

      // Verify the pipeline ran successfully
      expect(result.symbol).toBe('BTC/USDT');
      expect(result.decision).toBeDefined();

      // Verify a Kanban task was created and completed
      const tasks = kb.listTasks({ status: 'done' });
      const pipelineTask = tasks.find((t) => t.title.includes('BTC/USDT'));
      expect(pipelineTask).toBeDefined();
      expect(pipelineTask!.status).toBe('done');
      expect(pipelineTask!.tags).toContain('pipeline');
    });

    it('should transition task through running -> done states', async () => {
      const kb = new MockKanbanBoard();
      boardsToClose.push(kb);
      const pipeline = new TradingPipeline(createTestConfig({
        kanbanBoard: kb,
        marketContextResolver: async () => ({ symbol: 'ETH/USDT', timeframe: '4h' }),
      }));

      pipeline.on('research-agent', async (input: any) => ({
        type: 'research',
        symbol: input.symbol,
        timeframe: input.timeframe,
        hypotheses: [],
        confidence: 0.5,
        analysis: 'test',
      }));
      pipeline.on('market-analyst', async (input: any) => ({
        type: 'technical_analysis',
        symbol: input.symbol,
        indicators: {},
        signals: [{ type: 'HOLD', confidence: 0.5 }],
        support: [],
        resistance: [],
      }));
      pipeline.on('risk-manager', async (_input: any) => ({
        type: 'risk_assessment',
        riskScore: 0.3,
        riskLevel: 'low',
        maxPositionSize: 0.1,
        stopLoss: 0,
        takeProfit: 0,
        factors: [],
        recommendation: 'APPROVED',
      }));

      await pipeline.execute();

      const tasks = kb.listTasks({ status: 'done' });
      const pipelineTask = tasks.find((t) => t.title.includes('ETH/USDT'));
      expect(pipelineTask).toBeDefined();

      // Check events to verify the transition path
      const events = kb.getTaskEvents(pipelineTask!.id);
      const statusEvents = events.filter((e) => e.event_type === 'status_change');
      expect(statusEvents.length).toBeGreaterThanOrEqual(2);
      // First transition should be to running
      expect(statusEvents[0]!.new_value).toBe('running');
      // Last transition should be to done
      expect(statusEvents[statusEvents.length - 1]!.new_value).toBe('done');
    });
  });

  // -----------------------------------------------------------------------
  // Cron recurring tasks
  // -----------------------------------------------------------------------

  describe('Cron recurring tasks', () => {
    it('should register recurring pipeline tasks via registerRecurringTasks()', async () => {
      const ce = new CronEngine(testDir);
      await ce.initialize();
      const pipeline = new TradingPipeline(createTestConfig({ cronEngine: ce }));

      const jobIds = await pipeline.registerRecurringTasks();

      expect(jobIds).toHaveLength(4);
      expect(typeof jobIds[0]).toBe('string');

      // Verify each job was created in the engine
      const jobs = await ce.listJobs();
      expect(jobs).toHaveLength(4);

      const jobNames = jobs.map((j) => j.name).sort();
      expect(jobNames).toEqual([
        'daily-performance-report',
        'market-data-refresh',
        'portfolio-rebalance-check',
        'strategy-evaluation',
      ]);
    });

    it('should return empty array when CronEngine is not available', async () => {
      const pipeline = new TradingPipeline(createTestConfig());
      const jobIds = await pipeline.registerRecurringTasks();
      expect(jobIds).toEqual([]);
    });

    it('should register jobs with correct schedules', async () => {
      const ce = new CronEngine(testDir);
      await ce.initialize();
      const pipeline = new TradingPipeline(createTestConfig({ cronEngine: ce }));

      await pipeline.registerRecurringTasks();

      const jobs = await ce.listJobs();

      const marketData = jobs.find((j) => j.name === 'market-data-refresh');
      expect(marketData).toBeDefined();
      expect(marketData!.schedule.display).toBe('every 5m');
      expect(marketData!.schedule.kind).toBe('interval');
      expect(marketData!.schedule.intervalMs).toBe(5 * 60 * 1000);

      const strategy = jobs.find((j) => j.name === 'strategy-evaluation');
      expect(strategy).toBeDefined();
      expect(strategy!.schedule.display).toBe('every 30m');
      expect(strategy!.schedule.kind).toBe('interval');

      const rebalance = jobs.find((j) => j.name === 'portfolio-rebalance-check');
      expect(rebalance).toBeDefined();
      expect(rebalance!.schedule.display).toBe('every 1h');
      expect(rebalance!.schedule.kind).toBe('interval');

      const report = jobs.find((j) => j.name === 'daily-performance-report');
      expect(report).toBeDefined();
      expect(report!.schedule.display).toBe('0 9 * * *');
      expect(report!.schedule.kind).toBe('cron');
    });

    it('should tag all recurring jobs with pipeline tag', async () => {
      const ce = new CronEngine(testDir);
      await ce.initialize();
      const pipeline = new TradingPipeline(createTestConfig({ cronEngine: ce }));

      await pipeline.registerRecurringTasks();

      const jobs = await ce.listJobs();
      for (const job of jobs) {
        expect(job.tags).toContain('pipeline');
      }
    });
  });

  // -----------------------------------------------------------------------
  // Pipeline execution without wiring (backward compatibility)
  // -----------------------------------------------------------------------

  describe('Backward compatibility', () => {
    it('should execute pipeline without KanbanBoard or CronEngine', async () => {
      const pipeline = new TradingPipeline(createTestConfig());

      pipeline.on('research-agent', async (input: any) => ({
        type: 'research',
        symbol: input.symbol,
        timeframe: input.timeframe,
        hypotheses: [],
        confidence: 0.5,
        analysis: 'test',
      }));
      pipeline.on('market-analyst', async (input: any) => ({
        type: 'technical_analysis',
        symbol: input.symbol,
        indicators: {},
        signals: [{ type: 'HOLD', confidence: 0.5 }],
        support: [],
        resistance: [],
      }));
      pipeline.on('risk-manager', async (_input: any) => ({
        type: 'risk_assessment',
        riskScore: 0.3,
        riskLevel: 'low',
        maxPositionSize: 0.1,
        stopLoss: 0,
        takeProfit: 0,
        factors: [],
        recommendation: 'APPROVED',
      }));

      const result = await pipeline.execute();
      expect(result.symbol).toBe('BTC/USDT');
      expect(result.decision.action).toBeDefined();
      expect(result.totalExecutionTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should still register handlers via on() and registerHandlers()', () => {
      const pipeline = new TradingPipeline(createTestConfig());
      const handler: any = async () => ({});
      pipeline.on('test-agent', handler);
      pipeline.registerHandlers({ 'another-agent': handler });
      expect((pipeline as any).handlers.has('test-agent')).toBe(true);
      expect((pipeline as any).handlers.has('another-agent')).toBe(true);
    });

    it('should infer pipeline phases from generic handler names when no chain is configured', async () => {
      const pipeline = new TradingPipeline(createTestConfig({
        marketContextResolver: async () => ({ symbol: 'SOL/USDT', timeframe: '1h' }),
      }));

      pipeline.on('signal-scout', async (input: any) => ({
        type: 'research',
        symbol: input.symbol,
        timeframe: input.timeframe,
        hypotheses: [{ type: 'trend', direction: 'bullish', confidence: 0.6 }],
        confidence: 0.6,
        analysis: 'scouted',
      }));
      pipeline.on('trend-analyst', async (input: any) => ({
        type: 'technical_analysis',
        symbol: input.symbol,
        indicators: { ema: 20 },
        signals: [{ type: 'HOLD', confidence: 0.55 }],
        support: [100],
        resistance: [120],
      }));
      pipeline.on('risk-guardian', async (_input: any) => ({
        type: 'risk_assessment',
        riskScore: 0.25,
        riskLevel: 'low',
        maxPositionSize: 0.1,
        stopLoss: 95,
        takeProfit: 130,
        factors: [],
        recommendation: 'APPROVED',
      }));

      const result = await pipeline.execute();

      expect(result.symbol).toBe('SOL/USDT');
      expect(result.research.agentOutputs['signal-scout']).toBeDefined();
      expect(result.analysis.agentOutputs['trend-analyst']).toBeDefined();
      expect(result.risk.agentOutputs['risk-guardian']).toBeDefined();
    });
  });
});
