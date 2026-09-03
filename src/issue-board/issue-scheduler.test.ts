import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CronEngine } from '@dyna/agent-cron';
import { IssueBoard } from './issue-board';
import { IssueScheduler } from './issue-scheduler';

describe('IssueScheduler', () => {
  it('mirrors scheduled issues into CronEngine and removes completed ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dyna-issue-scheduler-'));
    try {
      const board = new IssueBoard(dir);
      const issue = await board.create({ id: 'scheduled', title: 'Run research', schedule: 'every 1h' });
      const cron = new CronEngine(dir, async () => 'ok');
      await cron.initialize();
      const scheduler = new IssueScheduler(board);
      expect((await scheduler.sync(cron)).created).toEqual(['scheduled']);
      expect((await cron.listJobs()).some((job) => job.tags.includes('issue:scheduled'))).toBe(true);
      await board.update(issue.id, { status: 'done' });
      expect((await scheduler.sync(cron)).removed).toEqual(['scheduled']);
      expect((await cron.listJobs()).filter((job) => job.tags.includes('issue:scheduled'))).toHaveLength(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
