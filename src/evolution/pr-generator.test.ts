import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvolutionPrGenerator } from './pr-generator';

describe('EvolutionPrGenerator', () => {
  it('creates a review branch and writes an evolved skill artifact', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'dyna-pr-'));
    try {
      const commands: string[][] = [];
      const generator = new EvolutionPrGenerator({ repoPath: repo, exec: vi.fn(async (_command, args) => { commands.push(args); return { stdout: args[0] === 'commit' ? 'abc1234' : '', stderr: '' }; }) });
      const result = await generator.generate({ skillName: 'Risk Review', description: 'Improved review', instructions: 'Use the checklist.', baseBranch: 'main' });
      expect(result.branch).toMatch(/^evolution\/risk-review-/);
      expect(result.commit).toBe('abc1234');
      expect(await readFile(join(repo, result.skillPath), 'utf8')).toContain('Use the checklist.');
      expect(commands.map((args) => args[0])).toEqual(['switch', 'switch', 'add', 'commit']);
    } finally { await rm(repo, { recursive: true, force: true }); }
  });
});
