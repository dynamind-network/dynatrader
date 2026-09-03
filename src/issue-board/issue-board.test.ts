import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IssueBoard } from './issue-board';

describe('IssueBoard', () => {
  it('persists markdown issues with frontmatter and updates status', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dyna-issues-'));
    try {
      const board = new IssueBoard(dir);
      const issue = await board.create({ title: 'Investigate BTC liquidity', body: 'Check depth.', priority: 'high', schedule: '0 * * * *', tags: ['market'] });
      expect((await readFile(issue.path, 'utf8'))).toContain('status: triage');
      const updated = await board.update(issue.id, { status: 'in_progress', assignee: 'research-agent' });
      expect(updated.status).toBe('in_progress');
      expect((await board.list({ tag: 'market' }))).toHaveLength(1);
      expect((await board.get(issue.id))?.assignee).toBe('research-agent');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
