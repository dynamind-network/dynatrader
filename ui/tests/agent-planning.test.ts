import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PlanManager } from '../src/core/plan-manager.js';
import type { Plan } from '../src/core/plan-manager.js';

describe('PlanManager', () => {
  let tmpDir: string;
  let manager: PlanManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'plan-manager-'));
    manager = new PlanManager({ workingDirectory: tmpDir });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('starts with no plan and no planning mode', () => {
    expect(manager.isPlanningMode()).toBe(false);
    expect(manager.getCurrentPlan()).toBeNull();
    expect(manager.getPlanHistory()).toEqual([]);
  });

  it('stores plans in a .dynamind/plans directory under the working directory', () => {
    expect(manager.plansDirectory).toBe(path.join(tmpDir, '.dynamind', 'plans'));
  });

  it('enters planning mode with an empty goal', async () => {
    await manager.enterPlanMode();
    expect(manager.isPlanningMode()).toBe(true);
    expect(manager.getCurrentPlan()).toBeNull();
  });

  it('creates a three-step plan for implementation goals', async () => {
    const plan = await manager.enterPlanMode('implement a feature');
    expect(manager.isPlanningMode()).toBe(true);
    expect(plan).not.toBeNull();
    expect(plan!.steps).toHaveLength(3);
    expect(plan!.status).toBe('proposed');
  });

  it('creates a three-step plan for build goals', async () => {
    const plan = await manager.enterPlanMode('build the app');
    expect(plan!.steps).toHaveLength(3);
  });

  it('creates a two-step plan for plain goals', async () => {
    const plan = await manager.enterPlanMode('hello');
    expect(plan!.steps).toHaveLength(2);
  });

  it('converts pending tool-bound steps into tool uses', async () => {
    const tools = [{ name: 'read', description: 'Read a file' }];
    const plan = await manager.createPlan(
      { userGoal: 'hello', context: { workingDirectory: tmpDir, availableTools: ['read'] } },
      tools
    );

    expect(plan.steps).toHaveLength(2);
    const uses = manager.planToToolUses();
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatchObject({ type: 'tool_use', name: 'read', input: {} });
  });

  it('formats a plan for review with pending status markers', async () => {
    const plan = await manager.enterPlanMode('hello');
    const formatted = manager.formatPlanForReview(plan!);

    expect(formatted).toContain(plan!.title);
    expect(formatted).toContain('hello');
    expect(formatted).toContain('[pending]');
  });

  it('approves a proposed plan and exits planning mode', async () => {
    await manager.createPlan(
      { userGoal: 'hello', context: { workingDirectory: tmpDir, availableTools: [] } },
      []
    );

    expect(await manager.approvePlan()).toBe(true);
    expect(manager.getCurrentPlan()?.status).toBe('approved');
    expect(manager.isPlanningMode()).toBe(false);
  });

  it('returns false when approving with no plan', async () => {
    expect(await manager.approvePlan()).toBe(false);
  });

  it('rejects a plan back into draft and stays in planning mode', async () => {
    await manager.createPlan(
      { userGoal: 'hello', context: { workingDirectory: tmpDir, availableTools: [] } },
      []
    );

    expect(await manager.rejectPlan('too broad')).toBe(true);
    expect(manager.getCurrentPlan()?.status).toBe('draft');
    expect(manager.isPlanningMode()).toBe(true);
  });

  it('returns false when rejecting with no plan', async () => {
    expect(await manager.rejectPlan('nope')).toBe(false);
  });

  it('cancels the active plan', async () => {
    await manager.createPlan(
      { userGoal: 'hello', context: { workingDirectory: tmpDir, availableTools: [] } },
      []
    );

    manager.cancelPlan('changed my mind');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(manager.getCurrentPlan()).toBeNull();
    expect(manager.isPlanningMode()).toBe(false);
    expect(manager.getPlanHistory()[0].status).toBe('cancelled');
  });

  it('throws when executing without an approved plan', async () => {
    await manager.createPlan(
      { userGoal: 'hello', context: { workingDirectory: tmpDir, availableTools: [] } },
      []
    );

    await expect(manager.executePlan().next()).rejects.toThrow('No approved plan to execute');
  });

  it('throws when executing with no plan at all', async () => {
    await expect(manager.executePlan().next()).rejects.toThrow('No approved plan to execute');
  });

  it('executes an approved plan to completion with updates', async () => {
    await manager.createPlan(
      { userGoal: 'implement a feature', context: { workingDirectory: tmpDir, availableTools: [] } },
      []
    );
    await manager.approvePlan();

    const generator = manager.executePlan();
    const steps: string[] = [];
    for (let result = await generator.next(); !result.done; result = await generator.next()) {
      steps.push(result.value.id);
      await manager.updateStep(result.value.id, 'completed', 'done');
    }

    expect(steps).toHaveLength(3);
    expect(manager.getCurrentPlan()?.status).toBe('completed');
  });

  it('skips steps whose dependencies are not completed', async () => {
    const plan: Plan = {
      id: 'manual-plan',
      title: 'Manual Plan',
      description: 'dependency test',
      status: 'approved',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      steps: [
        { id: 's1', description: 'finish', reasoning: 'r1', status: 'completed', dependencies: [] },
        { id: 's2', description: 'blocked', reasoning: 'r2', status: 'pending', dependencies: ['s3'] },
        { id: 's3', description: 'prerequisite', reasoning: 'r3', status: 'pending', dependencies: [] },
      ],
    };
    const file = path.join(tmpDir, '.dynamind', 'plans', 'dependency.md');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      `# Manual Plan\n\n<!-- dynamind-plan\n${JSON.stringify(plan)}\n-->`,
      'utf8'
    );

    const loaded = await manager.load(file);
    expect(loaded.id).toBe('manual-plan');

    const generator = manager.executePlan();
    const first = await generator.next();
    expect((first.value as { id: string }).id).toBe('s1');
    await manager.updateStep('s1', 'completed', 'ok');

    const second = await generator.next();
    expect((second.value as { id: string }).id).toBe('s3');
    expect(manager.getCurrentPlan()?.steps.find((s) => s.id === 's2')?.status).toBe('skipped');

    await manager.updateStep('s3', 'completed', 'ok');
    const last = await generator.next();
    expect(last.done).toBe(true);
    expect(manager.getCurrentPlan()?.status).toBe('completed');
  });

  it('persists and reloads plans from disk', async () => {
    const plan = await manager.createPlan(
      { userGoal: 'build the app', context: { workingDirectory: tmpDir, availableTools: [] } },
      []
    );

    const loaded = await manager.load(plan.filePath!);
    expect(loaded.title).toBe(plan.title);
    expect(loaded.steps).toHaveLength(3);
    expect(loaded.filePath).toBe(plan.filePath);
  });

  it('lists persisted plan files', async () => {
    await manager.createPlan(
      { userGoal: 'build the app', context: { workingDirectory: tmpDir, availableTools: [] } },
      []
    );

    const plans = await manager.listPersistedPlans();
    expect(plans.length).toBe(1);
    expect(plans[0]).toBe('build-the-app.md');
  });
});