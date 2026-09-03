import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PlanManager } from '../src/core/plan-manager.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('live PlanManager', () => {
  it('persists, loads, and updates a plan', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'dynamind-plan-'));
    dirs.push(cwd);
    const onEvent = vi.fn();
    const manager = new PlanManager({ workingDirectory: cwd, onEvent });
    const plan = await manager.createPlan(
      { userGoal: 'implement plan mode', context: { workingDirectory: cwd, availableTools: [] } },
      []
    );
    expect(plan.filePath).toContain(path.join('.dynamind', 'plans'));
    expect(await readFile(plan.filePath!, 'utf8')).toContain('dynamind-plan');
    await manager.updateStep(plan.steps[0].id, 'completed', 'inspected');
    const loaded = await new PlanManager({ workingDirectory: cwd }).load(plan.filePath!);
    expect(loaded.steps[0].status).toBe('completed');
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'plan_step_update' }));
  });

  it('keeps planning on rejection and leaves it after approval', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'dynamind-plan-'));
    dirs.push(cwd);
    const manager = new PlanManager({ workingDirectory: cwd });
    await manager.enterPlanMode('review architecture');
    expect(manager.isPlanningMode()).toBe(true);
    await manager.rejectPlan('add tests');
    expect(manager.getCurrentPlan()?.status).toBe('draft');
    expect(await manager.approvePlan()).toBe(true);
    expect(manager.isPlanningMode()).toBe(false);
  });
});
