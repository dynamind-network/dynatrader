import type { CronEngine, CronJob } from '@dyna/agent-cron';
import { IssueBoard } from './issue-board';

export interface IssueScheduleSyncResult {
  created: string[];
  updated: string[];
  removed: string[];
}

/** Mirrors scheduled markdown issues into the existing CronEngine. */
export class IssueScheduler {
  constructor(private readonly board: IssueBoard) {}

  async sync(cron: CronEngine): Promise<IssueScheduleSyncResult> {
    const result: IssueScheduleSyncResult = { created: [], updated: [], removed: [] };
    const issues = await this.board.list();
    const jobs = await cron.listJobs();
    const managed = new Map<string, CronJob>();
    for (const job of jobs) {
      const issueTag = job.tags.find((tag) => tag.startsWith('issue:'));
      if (issueTag) managed.set(issueTag.slice('issue:'.length), job);
    }

    for (const issue of issues) {
      const existing = managed.get(issue.id);
      if (!issue.schedule || issue.status === 'archived' || issue.status === 'done') {
        if (existing) { await cron.deleteJob(existing.id); result.removed.push(issue.id); }
        continue;
      }
      const spec = {
        name: `Issue: ${issue.title}`,
        prompt: `Process issue ${issue.id}: ${issue.title}\n\n${issue.body}`,
        schedule: issue.schedule,
        tags: ['issue-board', `issue:${issue.id}`],
      };
      if (existing) {
        await cron.updateJob(existing.id, spec);
        result.updated.push(issue.id);
      } else {
        await cron.createJob(spec);
        result.created.push(issue.id);
      }
    }
    return result;
  }
}
