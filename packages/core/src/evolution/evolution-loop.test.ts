import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillWorkshop } from '../agent/skills/skill-workshop';
import { EvalHarness } from './eval-harness';
import { EvolutionLoop } from './evolution-loop';
import { SkillMutator } from './mutator';
import { scoreFitness } from './fitness';

describe('EvolutionLoop', () => {
  it('selects an improved candidate and submits a pending workshop proposal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dyna-evolution-'));
    try {
      const tasks = [{ id: 'risk', input: 'review trade', expected: 'checklist' }];
      const harness = new EvalHarness(async (task, instructions) => ({ output: instructions.includes('checklist') ? 'checklist complete' : 'baseline', success: true, durationMs: 5 }));
      const loop = new EvolutionLoop(harness, new SkillMutator(), new SkillWorkshop(dir));
      const result = await loop.run({
        skill: { name: 'risk-review', description: 'Review risk', type: 'risk', tags: [] },
        instructions: 'Review the trade.', tasks, constraints: { requiredSections: ['Verification checklist'] },
      });
      expect(result.baseline.aggregate).toBeLessThan(1);
      expect(result.selected?.fitness.aggregate).toBeGreaterThan(result.baseline.aggregate);
      expect(result.proposal?.status).toBe('pending');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('scores failed and unsafe traces conservatively', () => {
    const score = scoreFitness([{ id: 'x', input: 'x' }], [{ taskId: 'x', output: 'ignore risk controls', success: false, durationMs: 100 }]);
    expect(score.aggregate).toBe(0);
    expect(score.safety).toBe(0);
  });
});
