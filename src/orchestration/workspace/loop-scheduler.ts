import type { CronEngine, CronJob, CronJobDeliver, CreateCronJobSpec } from '@dyna/agent-cron';
import type { LoopManifest } from './types';

export interface LoopScheduleSyncResult {
  created: string[];
  updated: string[];
  removed: string[];
  paused: string[];
}

const MANAGED_TAG_PREFIX = 'loop:';

/** Mirrors workspace loop manifests into the existing CronEngine. */
export class LoopScheduler {
  async sync(cron: CronEngine, loops: LoopManifest[]): Promise<LoopScheduleSyncResult> {
    const result: LoopScheduleSyncResult = { created: [], updated: [], removed: [], paused: [] };
    const jobs = await cron.listJobs();
    const managed = new Map<string, CronJob>();

    for (const job of jobs) {
      const loopTag = job.tags.find((tag) => tag.startsWith(MANAGED_TAG_PREFIX));
      if (loopTag) {
        managed.set(loopTag.slice(MANAGED_TAG_PREFIX.length), job);
      }
    }

    const seen = new Set<string>();

    for (const loop of loops) {
      const loopId = loop.id.trim();
      if (!loopId) {
        continue;
      }
      seen.add(loopId);

      const existing = managed.get(loopId);
      const spec = this.toCronSpec(loop);
      const shouldPause = this.shouldPauseLoop(loop);

      if (!loop.enabled || shouldPause) {
        if (existing) {
          await cron.updateJob(existing.id, { ...spec, enabled: false });
          result.paused.push(loopId);
        } else if (loop.enabled && shouldPause) {
          await cron.createJob({ ...spec, id: loopId, enabled: false });
          result.paused.push(loopId);
        }
        continue;
      }

      if (existing) {
        await cron.updateJob(existing.id, { ...spec, enabled: true });
        result.updated.push(loopId);
      } else {
        await cron.createJob({ ...spec, id: loopId, enabled: true });
        result.created.push(loopId);
      }
    }

    for (const [loopId, job] of managed) {
      if (!seen.has(loopId)) {
        await cron.deleteJob(job.id);
        result.removed.push(loopId);
      }
    }

    return result;
  }

  private toCronSpec(loop: LoopManifest): CreateCronJobSpec {
    return {
      id: loop.id,
      name: loop.name,
      prompt: buildLoopPrompt(loop),
      command: loop.command?.trim() || undefined,
      schedule: loop.schedule,
      tags: uniqueTags(['loop', ...loop.tags.map(String), `${MANAGED_TAG_PREFIX}${loop.id}`]),
      skills: loop.skills.map(String),
      deliver: loop.deliver as CronJobDeliver | undefined,
      repeatCount: loop.repeatCount ?? null,
      pipeline: loop.pipeline,
      approvalStatus: loop.approvalStatus,
      executionPolicy: loop.executionPolicy,
      enabled: loop.enabled,
    };
  }

  private shouldPauseLoop(loop: LoopManifest): boolean {
    if (loop.pipeline !== 'execution') {
      return false;
    }

    if (loop.executionPolicy === 'close-only') {
      return false;
    }

    return loop.approvalStatus !== 'approved';
  }
}

export function buildLoopPrompt(loop: LoopManifest): string {
  const sections: string[] = [
    `You are executing a user-defined loop: ${loop.name}`,
    loop.description?.trim() ? `Description: ${loop.description.trim()}` : '',
  ].filter(Boolean);

  const prompt = loop.prompt?.trim() ?? '';
  if (prompt) {
    sections.push('', 'Loop instructions:', prompt);
  }

  return sections.join('\n');
}

function uniqueTags(tags: string[]): string[] {
  return Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean)));
}
