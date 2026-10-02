/**
 * CLI Command: cron
 */

import type { DynaTraderRuntime } from '@dyna/core/cli';
import { bold, cyan, green, red, yellow, dim, formatDate, printSeparator } from '../utils';

type CronFlags = Record<string, string | boolean>;

type CronDeliverTarget = 'telegram' | 'discord' | 'local' | 'none';
type CronPipeline = 'analysis' | 'execution' | 'monitoring' | 'research';
type CronApprovalStatus = 'pending' | 'approved' | 'rejected';
type CronExecutionPolicy = 'trade' | 'close-only';

function flagString(flags: CronFlags | undefined, key: string): string | undefined {
  const value = flags?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function flagBoolean(flags: CronFlags | undefined, key: string): boolean | undefined {
  const value = flags?.[key];
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const lowered = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(lowered)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(lowered)) return false;
  return undefined;
}

function parseStringList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.map(String).map((item) => item.trim()).filter(Boolean);
    }
  } catch {
    // Fall through to comma parsing.
  }

  return trimmed
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseEnvObject(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>)
          .filter(([, value]) => typeof value === 'string')
          .map(([key, value]) => [key, (value as string).trim()] as const)
          .filter(([, value]) => value.length > 0),
      );
    }
  } catch {
    // Fall through to KEY=VALUE parsing.
  }

  const env: Record<string, string> = {};
  for (const pair of trimmed.split(',')) {
    const [key, ...rest] = pair.split('=');
    const normalizedKey = key?.trim();
    const normalizedValue = rest.join('=').trim();
    if (normalizedKey && normalizedValue) {
      env[normalizedKey] = normalizedValue;
    }
  }

  return Object.keys(env).length > 0 ? env : undefined;
}

function deriveNameFromJob(job: { name?: string; prompt?: string; command?: string }): string {
  if (job.name?.trim()) return job.name.trim();
  const basis = job.prompt?.trim() || job.command?.trim() || 'cron job';
  return basis.slice(0, 40) + (basis.length > 40 ? '...' : '');
}

function resolveEnabled(flags: CronFlags | undefined, current = true): boolean {
  const disabled = flagBoolean(flags, 'disabled');
  if (disabled === true) return false;

  const enabled = flagBoolean(flags, 'enabled');
  if (enabled !== undefined) return enabled;

  return current;
}

function buildDeliver(flags: CronFlags | undefined, current?: { target: CronDeliverTarget; chatId?: string }): { target: CronDeliverTarget; chatId?: string } | undefined {
  const target = flagString(flags, 'deliver-to') ?? flagString(flags, 'deliverTo');
  const chatId = flagString(flags, 'chat-id') ?? flagString(flags, 'chatId');
  if (!target && !chatId && !current) return undefined;
  const nextTarget = (target as CronDeliverTarget | undefined) ?? current?.target ?? 'none';
  return {
    target: nextTarget,
    chatId: chatId ?? current?.chatId,
  };
}

function printJobSummary(job: {
  id: string;
  name: string;
  schedule: { display: string; kind: string };
  enabled: boolean;
  state: string;
  prompt?: string;
  command?: string;
  pipeline?: string;
  approvalStatus?: string;
  executionPolicy?: string;
  lastStatus: string | null;
  completedRuns: number;
  repeatCount?: number | null;
  lastRunAt?: number;
  nextRunAt?: number;
  deliver?: { target: string; chatId?: string };
}): void {
  const stateColor = job.state === 'completed' ? dim : job.enabled ? green : red;
  const stateLabel = job.state === 'completed'
    ? 'completed'
    : job.state === 'running'
      ? 'running'
      : job.enabled
        ? 'enabled'
        : 'paused';

  console.log();
  console.log(`  ${bold(job.name)} ${dim(`(${job.id.slice(0, 8)}...)`)}`);
  console.log(`    Schedule: ${job.schedule.display}`);
      console.log(`    State:    ${stateColor(stateLabel)}`);
  console.log(`    Pipeline: ${job.pipeline ?? dim('n/a')}`);
  console.log(`    Approval: ${job.approvalStatus ?? dim('n/a')}`);
  console.log(`    Policy:   ${job.executionPolicy ?? dim('n/a')}`);

  if (job.prompt) {
    console.log(`    Prompt:   ${dim(job.prompt.slice(0, 80))}`);
  }
  if (job.command) {
    console.log(`    Command:  ${dim(job.command.slice(0, 80))}`);
  }

  console.log(`    Runs:     ${job.completedRuns}${job.repeatCount != null ? `/${job.repeatCount}` : ''}`);
  console.log(`    Status:   ${job.lastStatus === 'ok' ? green('ok') : job.lastStatus === 'error' ? red('error') : dim('n/a')}`);

  if (job.deliver && job.deliver.target !== 'none') {
    console.log(`    Deliver:  ${job.deliver.target}${job.deliver.chatId ? ` (${job.deliver.chatId})` : ''}`);
  }

  if (job.lastRunAt) {
    console.log(`    Last:     ${formatDate(new Date(job.lastRunAt))}`);
  }
  if (job.nextRunAt) {
    console.log(`    Next:     ${formatDate(new Date(job.nextRunAt))}`);
  }
}

function toJsonJob(job: Record<string, unknown>): string {
  return JSON.stringify(job, null, 2);
}

export async function cmdCron(
  runtime: DynaTraderRuntime,
  sub: string,
  args: string[],
  flags: CronFlags = {},
): Promise<void> {
  const cronEngine = runtime.getCronEngine();
  const json = flags.json === true;
  const emit = (data: unknown): void => { if (json) process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`); };

  switch (sub) {
    case 'list': {
      if (json) { emit(await cronEngine.listJobs()); return; }
      console.log();
      console.log(bold(cyan('Cron Jobs')));
      printSeparator();

      const jobs = await cronEngine.listJobs();
      if (jobs.length === 0) {
        console.log(yellow('  No cron jobs scheduled.'));
        console.log();
        return;
      }

      for (const job of jobs) {
        printJobSummary(job as any);
      }
      console.log();
      break;
    }

    case 'inspect':
    case 'show': {
      const jobId = args[0];
      if (!jobId) {
        if (json) throw new Error('jobId is required');
        console.log(red('Error: jobId is required.'));
        console.log(dim('Usage: dynatrader cron inspect <jobId>'));
        return;
      }
      const job = await cronEngine.getJob(jobId);
      if (!job) {
        if (json) throw new Error(`Cron job not found: ${jobId}`);
        console.log(red(`Cron job not found: ${jobId}`));
        return;
      }

      if (json) { emit(job); return; }

      console.log();
      console.log(bold(cyan('Cron Job Details')));
      printSeparator();
      console.log(toJsonJob({
        id: job.id,
        name: job.name,
        prompt: job.prompt,
        command: job.command,
        schedule: job.schedule,
        skills: job.skills ?? [],
        deliver: job.deliver ?? { target: 'none' },
        enabled: job.enabled,
        state: job.state,
        lastStatus: job.lastStatus,
        lastError: job.lastError,
        repeatCount: job.repeatCount,
        completedRuns: job.completedRuns,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        lastRunAt: job.lastRunAt,
        nextRunAt: job.nextRunAt,
        runCount: job.runCount,
        tags: job.tags,
        pipeline: job.pipeline,
        approvalStatus: job.approvalStatus,
        executionPolicy: job.executionPolicy,
        lastTrade: job.lastTrade,
        tradeHistory: job.tradeHistory ?? [],
      }));
      console.log();
      break;
    }

    case 'add':
    case 'create': {
      const schedule = flagString(flags, 'schedule') ?? args[0];
      const positionalPayload = args.slice(1).join(' ').trim();
      const prompt = flagString(flags, 'prompt') ?? (!flagString(flags, 'command') ? positionalPayload : undefined);
      const command = flagString(flags, 'command');
      if (!schedule) {
        if (json) throw new Error('schedule is required');
        console.log(red('Error: schedule is required.'));
        console.log(dim('Usage: dynatrader cron add <schedule> <prompt>'));
        return;
      }
      if (!prompt && !command) {
        if (json) throw new Error('either prompt or command is required');
        console.log(red('Error: either prompt or command is required.'));
        console.log(dim('Usage: dynatrader cron add <schedule> <prompt>'));
        return;
      }

      const name = flagString(flags, 'name') ?? deriveNameFromJob({ prompt, command });
      const enabled = resolveEnabled(flags, true);
      const job = await cronEngine.createJob({
        id: flagString(flags, 'id'),
        name,
        prompt,
        command,
        schedule,
        skills: parseStringList(flagString(flags, 'skills')),
        deliver: buildDeliver(flags),
        repeatCount: (() => {
          const raw = flagString(flags, 'repeat-count');
          if (!raw) return undefined;
          const parsed = Number(raw);
          return Number.isFinite(parsed) ? parsed : undefined;
        })(),
        pipeline: flagString(flags, 'pipeline') as CronPipeline | undefined,
        approvalStatus: flagString(flags, 'approval-status') as CronApprovalStatus | undefined,
        executionPolicy: flagString(flags, 'execution-policy') as CronExecutionPolicy | undefined,
        enabled,
        tags: parseStringList(flagString(flags, 'tags')),
      });

      if (json) { emit(job); return; }

      console.log(green(`Cron job created: ${job.id}`));
      console.log(dim(`  Name:     ${job.name}`));
      console.log(dim(`  Schedule: ${job.schedule.display}`));
      console.log(dim(`  State:    ${job.state}`));
      if (!job.enabled) {
        console.log(dim('  Disabled on creation by request.'));
      }
      break;
    }

    case 'update':
    case 'edit': {
      const jobId = args[0];
      if (!jobId) {
        if (json) throw new Error('jobId is required');
        console.log(red('Error: jobId is required.'));
        console.log(dim('Usage: dynatrader cron update <jobId> [--name ...] [--prompt ...] [--command ...]'));
        return;
      }

      const existing = await cronEngine.getJob(jobId);
      if (!existing) {
        if (json) throw new Error(`Cron job not found: ${jobId}`);
        console.log(red(`Cron job not found: ${jobId}`));
        return;
      }

      const updates: Record<string, unknown> = {};
      const name = flagString(flags, 'name');
      const prompt = flagString(flags, 'prompt');
      const command = flagString(flags, 'command');
      const schedule = flagString(flags, 'schedule');
      const skills = parseStringList(flagString(flags, 'skills'));
      const tags = parseStringList(flagString(flags, 'tags'));
      const repeatCountRaw = flagString(flags, 'repeat-count');
      const deliver = buildDeliver(flags, existing.deliver);
      const enabled = flagBoolean(flags, 'enabled');

      if (name !== undefined) updates.name = name;
      if (prompt !== undefined) updates.prompt = prompt;
      if (command !== undefined) updates.command = command;
      if (schedule !== undefined) updates.schedule = schedule;
      if (skills !== undefined) updates.skills = skills;
      if (tags !== undefined) updates.tags = tags;
      if (deliver !== undefined) updates.deliver = deliver;
      if (repeatCountRaw !== undefined) {
        const parsed = Number(repeatCountRaw);
        if (Number.isFinite(parsed)) updates.repeatCount = parsed;
      }
      if (flagString(flags, 'pipeline') !== undefined) updates.pipeline = flagString(flags, 'pipeline') as CronPipeline;
      if (flagString(flags, 'approval-status') !== undefined) updates.approvalStatus = flagString(flags, 'approval-status') as CronApprovalStatus;
      if (flagString(flags, 'execution-policy') !== undefined) updates.executionPolicy = flagString(flags, 'execution-policy') as CronExecutionPolicy;
      if (enabled !== undefined) updates.enabled = enabled;
      if (flagBoolean(flags, 'disabled') === true) updates.enabled = false;

      const updated = await cronEngine.updateJob(jobId, updates);

      if (json) { emit(updated); return; }

      console.log(green(`Cron job updated: ${updated.id}`));
      console.log(dim(`  Name:     ${updated.name}`));
      console.log(dim(`  Schedule: ${updated.schedule.display}`));
      console.log(dim(`  State:    ${updated.state}`));
      break;
    }

    case 'remove':
    case 'delete': {
      const jobId = args[0];
      if (!jobId) {
        if (json) throw new Error('jobId is required');
        console.log(red('Error: jobId is required.'));
        console.log(dim('Usage: dynatrader cron remove <jobId>'));
        return;
      }
      await cronEngine.deleteJob(jobId);
      if (json) { emit({ id: jobId, deleted: true }); return; }
      console.log(green(`Cron job removed: ${jobId}`));
      break;
    }

    case 'pause': {
      const jobId = args[0];
      if (!jobId) {
        if (json) throw new Error('jobId is required');
        console.log(red('Error: jobId is required.'));
        console.log(dim('Usage: dynatrader cron pause <jobId>'));
        return;
      }
      const job = await cronEngine.pauseJob(jobId);
      if (json) { emit(job); return; }
      console.log(yellow(`Cron job paused: ${job.name} (${job.id.slice(0, 8)}...)`));
      break;
    }

    case 'resume': {
      const jobId = args[0];
      if (!jobId) {
        if (json) throw new Error('jobId is required');
        console.log(red('Error: jobId is required.'));
        console.log(dim('Usage: dynatrader cron resume <jobId>'));
        return;
      }
      const job = await cronEngine.resumeJob(jobId);
      if (json) { emit(job); return; }
      console.log(green(`Cron job resumed: ${job.name} (${job.id.slice(0, 8)}...)`));
      break;
    }

    case 'trigger':
    case 'run': {
      const jobId = args[0];
      if (!jobId) {
        if (json) throw new Error('jobId is required');
        console.log(red('Error: jobId is required.'));
        console.log(dim(`Usage: dynatrader cron ${sub} <jobId>`));
        return;
      }
      const execution = await cronEngine.triggerJob(jobId);
      if (json) { emit(execution); return; }
      const execColor = execution.success ? green : red;
      console.log(execColor(`Cron job executed: ${execution.success ? 'success' : 'failed'}`));
      console.log(dim(`  Duration: ${execution.duration}ms`));
      if (execution.output) {
        console.log(dim(`  Output: ${execution.output.slice(0, 200)}`));
      }
      break;
    }

    case 'history': {
      const jobId = args[0];
      const rawLimit = flagString(flags, 'limit');
      const limit = rawLimit ? Number(rawLimit) : undefined;
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) {
        throw new Error('--limit must be an integer from 1 to 500');
      }
      const history = await cronEngine.listExecutionHistory({ jobId, limit });
      if (json) { emit(history); return; }
      console.log(JSON.stringify(history, null, 2));
      break;
    }

    default: {
      if (json) throw new Error(`Unknown cron subcommand: ${sub}`);
      console.log(red(`Unknown cron subcommand: ${sub}`));
      console.log(dim('Usage: dynatrader cron <list|add|update|remove|pause|resume|trigger|run|inspect> [args...]'));
    }
  }
}
