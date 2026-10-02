/**
 * Self-Modifying Cron Tool (Unified)
 *
 * Single unified tool that lets the agent create, list, update, delete,
 * pause, resume, trigger, and inspect its own cron jobs.
 * Implements ToolHandler interface for integration with the tool registry.
 *
 * Replaces the previous CronCreateTool, CronListTool, CronUpdateTool, CronDeleteTool
 * with a single action-based tool.
 */

import type { ToolCall, ToolResult, ToolHandler, ToolDefinition } from '@dyna/contracts';
import type { CronEngine, CronJobState } from '@dyna/agent-cron';
import { parseScheduleArg } from '../../agent/cron/parse-schedule';

type LoopPipeline = 'analysis' | 'execution' | 'monitoring' | 'research';

function validateExecutionPolicy(
  pipeline: LoopPipeline | undefined,
  approvalStatus: 'pending' | 'approved' | 'rejected' | undefined,
  executionPolicy: 'trade' | 'close-only' | undefined,
): string | null {
  if (pipeline !== 'execution') {
    return null;
  }

  if (executionPolicy === 'close-only') {
    return null;
  }

  if (approvalStatus === 'approved') {
    return null;
  }

  return 'Execution cron jobs require approvalStatus="approved" or executionPolicy="close-only"';
}

/**
 * Parse a deliverTo string into target + chatId.
 * Supports the following syntax:
 *   'telegram'            -> { target: 'telegram' }
 *   'telegram:12345'      -> { target: 'telegram', chatId: '12345' }
 *   'discord:CHAN_ID'     -> { target: 'discord', chatId: 'CHAN_ID' }
 *   'local'               -> { target: 'local' }
 *   'none' / undefined    -> { target: 'none' }
 */
type DeliverTarget = 'telegram' | 'discord' | 'local' | 'none';

function parseDeliverTo(deliverTo: string | undefined): { target: DeliverTarget; chatId?: string } {
  if (!deliverTo || deliverTo === 'none') {
    return { target: 'none' };
  }
  const colonIdx = deliverTo.indexOf(':');
  if (colonIdx > 0) {
    const raw = deliverTo.slice(0, colonIdx).trim().toLowerCase();
    const chatId = deliverTo.slice(colonIdx + 1).trim();
    if (['telegram', 'discord'].includes(raw) && chatId) {
      return { target: raw as DeliverTarget, chatId };
    }
  }
  // Bare platform name — validate against known targets
  const bare = deliverTo.trim().toLowerCase();
  if (['telegram', 'discord', 'local'].includes(bare)) {
    return { target: bare as DeliverTarget };
  }
  return { target: 'none' };
}

function serializeCronState(state: CronJobState | null | undefined): Record<string, unknown> | null {
  if (!state) {
    return null;
  }

  return {
    version: state.version,
    jobId: state.jobId,
    sessionId: state.sessionId,
    promptFingerprint: state.promptFingerprint,
    summary: state.summary,
    lastOutput: state.lastOutput,
    lastTrade: state.lastTrade,
    tradeCount: state.tradeHistory?.length ?? 0,
    lastVenue: state.lastVenue,
    lastSymbol: state.lastSymbol,
    lastTimeframe: state.lastTimeframe,
    lastStatus: state.lastStatus,
    lastError: state.lastError,
    lastRunAt: state.lastRunAt ? new Date(state.lastRunAt).toISOString() : null,
    updatedAt: new Date(state.updatedAt).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Unified Cron Tool
// ---------------------------------------------------------------------------

export class CronTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'cron',
    description: 'Manage scheduled cron jobs. Actions: create, list, update, delete, pause, resume, trigger, inspect',
    category: 'execution',
    inputSchema: {
      action: 'string',           // required: create | list | update | delete | pause | resume | trigger | inspect
      jobId: 'string?',
      name: 'string?',
      prompt: 'string?',
      command: 'string?',
      schedule: 'string?',
      skills: 'string[]?',
      deliverTo: 'string?',
      enabled: 'boolean?',
      pipeline: 'string?',
      approvalStatus: 'string?',
      executionPolicy: 'string?',
      enabledOnly: 'boolean?',
      wakeAgent: 'boolean?',
      contextFrom: 'string?',
      allowedTools: 'string[]?',
      disallowedTools: 'string[]?',
      model: 'object?',
    },
    outputSchema: { success: 'boolean', message: 'string', data: 'object?' },
    permissionsRequired: ['tool.cron'],
    sideEffects: ['cron_job_created', 'cron_job_updated', 'cron_job_deleted'],
    riskLevel: 'medium',
    timeoutMs: 10000,
  };

  constructor(private cronEngine: CronEngine) {}

  async execute(call: ToolCall): Promise<ToolResult> {
    const start = Date.now();
    try {
      const action = call.args.action as string | undefined;
      if (!action || typeof action !== 'string') {
        return {
          success: false,
          error: 'action is required (create, list, update, delete, pause, resume, trigger, inspect)',
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      switch (action) {
        case 'create':
          return this.handleCreate(call, start);
        case 'list':
          return this.handleList(call, start);
        case 'update':
          return this.handleUpdate(call, start);
        case 'delete':
          return this.handleDelete(call, start);
        case 'pause':
          return this.handlePause(call, start);
        case 'resume':
          return this.handleResume(call, start);
        case 'trigger':
          return this.handleTrigger(call, start);
        case 'inspect':
          return this.handleInspect(call, start);
        default:
          return {
            success: false,
            error: `Unknown action: "${action}". Valid actions: create, list, update, delete, pause, resume, trigger, inspect`,
            durationMs: Date.now() - start,
            truncated: false,
          };
      }
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message ?? String(err),
        durationMs: Date.now() - start,
        truncated: false,
      };
    }
  }

  // -----------------------------------------------------------------------
  // Action Handlers
  // -----------------------------------------------------------------------

  private async handleCreate(call: ToolCall, start: number): Promise<ToolResult> {
    const name = call.args.name as string | undefined;
    if (!name || typeof name !== 'string') {
      return {
        success: false,
        error: 'name must be a non-empty string',
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    const prompt = call.args.prompt as string | undefined;
    const command = call.args.command as string | undefined;
    if ((!prompt || typeof prompt !== 'string') && (!command || typeof command !== 'string')) {
      return {
        success: false,
        error: 'either prompt or command must be a non-empty string',
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    const scheduleInput = call.args.schedule as string | undefined;
    if (!scheduleInput || typeof scheduleInput !== 'string') {
      return {
        success: false,
        error: 'schedule must be a non-empty string (e.g., "in 30m", "every 10m", "at 14:30", "0 9 * * *")',
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    // Natural-language schedule parsing: in <N><unit> (one-shot), at HH:MM
    // (one-shot), every <N><unit> / every day|hour|minute|week (forever
    // interval), or raw 5-field cron passthrough. The agent never needs to
    // compute cron expressions.
    const parsed = parseScheduleArg(scheduleInput);
    let schedule: string;
    if (parsed.kind === 'once') {
      // One-shot: convert to an absolute-time expression the engine parses.
      schedule = `at ${new Date(parsed.runAt).toISOString()}`;
    } else if (parsed.kind === 'interval') {
      const minutes = Math.round(parsed.intervalMs / 60_000);
      schedule = `every ${minutes}m`;
    } else {
      schedule = parsed.expression;
    }
    const repeatCount = (call.args.repeatCount as number | null | undefined) ?? null;

    const skills = (call.args.skills as string[] | undefined) ?? [];
    const deliverTo = (call.args.deliverTo as string | undefined) ?? 'none';
    const enabled = (call.args.enabled as boolean | undefined) ?? true;
    const pipeline = (call.args.pipeline as string | undefined) as LoopPipeline | undefined;
    const approvalStatus = call.args.approvalStatus as
      | 'pending'
      | 'approved'
      | 'rejected'
      | undefined;
    const executionPolicy = call.args.executionPolicy as
      | 'trade'
      | 'close-only'
      | undefined;
    const wakeAgent = call.args.wakeAgent as boolean | undefined;
    const contextFrom = call.args.contextFrom as string | undefined;
    const allowedTools = (call.args.allowedTools as string[] | undefined) ?? undefined;
    const disallowedTools = (call.args.disallowedTools as string[] | undefined) ?? undefined;
    const model = (call.args.model as { provider: string; modelName: string } | undefined) ?? undefined;

    const parsedDeliver = parseDeliverTo(deliverTo);

    const policyError = validateExecutionPolicy(pipeline, approvalStatus, executionPolicy);
    if (policyError) {
      return {
        success: false,
        error: policyError,
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    const job = await this.cronEngine.createJob({
      name,
      prompt,
      schedule,
      repeatCount,
      tags: pipeline ? [pipeline] : [],
      skills: skills.length > 0 ? skills : undefined,
      deliver: { target: parsedDeliver.target, chatId: parsedDeliver.chatId },
      command: command?.trim() || undefined,
      pipeline: pipeline ?? undefined,
      approvalStatus,
      executionPolicy,
      wakeAgent: wakeAgent ?? undefined,
      contextFrom: contextFrom ?? undefined,
      allowedTools,
      disallowedTools,
      model,
    });

    // If not enabled, pause it
    if (!enabled) {
      await this.cronEngine.pauseJob(job.id);
    }

    return {
      success: true,
      data: {
        success: true,
        message: `Cron job "${name}" created with ID ${job.id}`,
        jobId: job.id,
      },
      durationMs: Date.now() - start,
      truncated: false,
    };
  }

  private async handleList(call: ToolCall, start: number): Promise<ToolResult> {
    const enabledOnly = (call.args.enabledOnly as boolean | undefined) ?? false;
    const jobs = await this.cronEngine.listJobs(enabledOnly);

    const serialized = jobs.map((job) => ({
      id: job.id,
      name: job.name,
      prompt: job.prompt?.substring(0, 200),
      schedule: job.schedule.display,
      scheduleKind: job.schedule.kind,
      enabled: job.enabled,
      state: job.state,
      lastStatus: job.lastStatus,
      lastError: job.lastError,
      runCount: job.runCount,
      completedRuns: job.completedRuns,
      lastRunAt: job.lastRunAt ? new Date(job.lastRunAt).toISOString() : null,
      nextRunAt: job.nextRunAt ? new Date(job.nextRunAt).toISOString() : null,
      skills: job.skills,
      deliverTarget: job.deliver?.target,
      tags: job.tags,
      approvalStatus: job.approvalStatus,
      executionPolicy: job.executionPolicy,
      lastTrade: job.lastTrade,
      tradeCount: job.tradeHistory?.length ?? 0,
      createdAt: new Date(job.createdAt).toISOString(),
      wakeAgent: job.wakeAgent,
      contextFrom: job.contextFrom,
      allowedTools: job.allowedTools,
      disallowedTools: job.disallowedTools,
      model: job.model,
      runtimeState: serializeCronState(this.cronEngine.getJobState(job.id)),
    }));

    return {
      success: true,
      data: {
        jobs: serialized,
        count: serialized.length,
      },
      durationMs: Date.now() - start,
      truncated: false,
    };
  }

  private async handleUpdate(call: ToolCall, start: number): Promise<ToolResult> {
    const jobId = call.args.jobId as string | undefined;
    if (!jobId || typeof jobId !== 'string') {
      return {
        success: false,
        error: 'jobId must be a non-empty string',
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    // Verify job exists
    const existing = await this.cronEngine.getJob(jobId);
    if (!existing) {
      return {
        success: false,
        error: `CronJob not found: ${jobId}`,
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    // Build updates object from provided args
    const updates: Record<string, unknown> = {};
    if (call.args.name !== undefined) updates.name = call.args.name;
    if (call.args.prompt !== undefined) updates.prompt = call.args.prompt;
    if (call.args.command !== undefined) updates.command = call.args.command;
    if (call.args.schedule !== undefined) updates.schedule = call.args.schedule;
    if (call.args.skills !== undefined) updates.skills = call.args.skills;
    if (call.args.deliverTo !== undefined) {
      const parsed = parseDeliverTo(call.args.deliverTo as string);
      updates.deliver = { target: parsed.target, chatId: parsed.chatId };
    }
    if (call.args.pipeline !== undefined) {
      updates.pipeline = call.args.pipeline as LoopPipeline;
    }
    if (call.args.approvalStatus !== undefined) {
      updates.approvalStatus = call.args.approvalStatus as 'pending' | 'approved' | 'rejected';
    }
    if (call.args.executionPolicy !== undefined) {
      updates.executionPolicy = call.args.executionPolicy as 'trade' | 'close-only';
    }
    if (call.args.wakeAgent !== undefined) {
      updates.wakeAgent = call.args.wakeAgent as boolean;
    }
    if (call.args.contextFrom !== undefined) {
      updates.contextFrom = call.args.contextFrom as string;
    }
    if (call.args.allowedTools !== undefined) {
      updates.allowedTools = call.args.allowedTools as string[];
    }
    if (call.args.disallowedTools !== undefined) {
      updates.disallowedTools = call.args.disallowedTools as string[];
    }
    if (call.args.model !== undefined) {
      updates.model = call.args.model as { provider: string; modelName: string };
    }

    const nextPipeline = (updates.pipeline as LoopPipeline | undefined) ?? existing.pipeline;
    const nextApprovalStatus = (updates.approvalStatus as 'pending' | 'approved' | 'rejected' | undefined) ?? existing.approvalStatus;
    const nextExecutionPolicy = (updates.executionPolicy as 'trade' | 'close-only' | undefined) ?? existing.executionPolicy;
    const policyError = validateExecutionPolicy(
      nextPipeline,
      nextApprovalStatus,
      nextExecutionPolicy,
    );
    if (policyError) {
      return {
        success: false,
        error: policyError,
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    const updated = await this.cronEngine.updateJob(jobId, updates);

    // Handle enabled/disabled toggle
    if (call.args.enabled !== undefined) {
      const enabled = call.args.enabled as boolean;
      if (enabled && !updated.enabled) {
        await this.cronEngine.resumeJob(jobId);
      } else if (!enabled && updated.enabled) {
        await this.cronEngine.pauseJob(jobId);
      }
    }

    const finalJob = await this.cronEngine.getJob(jobId);

    return {
      success: true,
      data: {
        success: true,
        message: `Cron job "${updated.name}" updated`,
        job: {
          id: finalJob?.id,
          name: finalJob?.name,
          schedule: finalJob?.schedule.display,
          enabled: finalJob?.enabled,
          state: finalJob?.state,
        },
      },
      durationMs: Date.now() - start,
      truncated: false,
    };
  }

  private async handleDelete(call: ToolCall, start: number): Promise<ToolResult> {
    const jobId = call.args.jobId as string | undefined;
    if (!jobId || typeof jobId !== 'string') {
      return {
        success: false,
        error: 'jobId must be a non-empty string',
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    // Verify job exists before deleting
    const existing = await this.cronEngine.getJob(jobId);
    if (!existing) {
      return {
        success: false,
        error: `CronJob not found: ${jobId}`,
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    const jobName = existing.name;
    await this.cronEngine.deleteJob(jobId);

    return {
      success: true,
      data: {
        success: true,
        message: `Cron job "${jobName}" (${jobId}) deleted permanently`,
      },
      durationMs: Date.now() - start,
      truncated: false,
    };
  }

  private async handlePause(call: ToolCall, start: number): Promise<ToolResult> {
    const jobId = call.args.jobId as string | undefined;
    if (!jobId || typeof jobId !== 'string') {
      return {
        success: false,
        error: 'jobId must be a non-empty string',
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    const existing = await this.cronEngine.getJob(jobId);
    if (!existing) {
      return {
        success: false,
        error: `CronJob not found: ${jobId}`,
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    await this.cronEngine.pauseJob(jobId);

    return {
      success: true,
      data: {
        success: true,
        message: `Cron job "${existing.name}" (${jobId}) paused`,
      },
      durationMs: Date.now() - start,
      truncated: false,
    };
  }

  private async handleResume(call: ToolCall, start: number): Promise<ToolResult> {
    const jobId = call.args.jobId as string | undefined;
    if (!jobId || typeof jobId !== 'string') {
      return {
        success: false,
        error: 'jobId must be a non-empty string',
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    const existing = await this.cronEngine.getJob(jobId);
    if (!existing) {
      return {
        success: false,
        error: `CronJob not found: ${jobId}`,
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    await this.cronEngine.resumeJob(jobId);

    return {
      success: true,
      data: {
        success: true,
        message: `Cron job "${existing.name}" (${jobId}) resumed`,
      },
      durationMs: Date.now() - start,
      truncated: false,
    };
  }

  private async handleTrigger(call: ToolCall, start: number): Promise<ToolResult> {
    const jobId = call.args.jobId as string | undefined;
    if (!jobId || typeof jobId !== 'string') {
      return {
        success: false,
        error: 'jobId must be a non-empty string',
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    const existing = await this.cronEngine.getJob(jobId);
    if (!existing) {
      return {
        success: false,
        error: `CronJob not found: ${jobId}`,
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    const execution = await this.cronEngine.triggerJob(jobId);

    return {
      success: true,
      data: {
        success: true,
        message: `Cron job "${existing.name}" (${jobId}) triggered`,
        execution: {
          jobId: execution.jobId,
          timestamp: execution.timestamp,
          duration: execution.duration,
          success: execution.success,
          output: execution.output.substring(0, 500),
          error: execution.error,
        },
      },
      durationMs: Date.now() - start,
      truncated: false,
    };
  }

  private async handleInspect(call: ToolCall, start: number): Promise<ToolResult> {
    const jobId = call.args.jobId as string | undefined;
    if (!jobId || typeof jobId !== 'string') {
      return {
        success: false,
        error: 'jobId must be a non-empty string',
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    const job = await this.cronEngine.getJob(jobId);
    if (!job) {
      return {
        success: false,
        error: `CronJob not found: ${jobId}`,
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    return {
      success: true,
      data: {
        id: job.id,
        name: job.name,
        prompt: job.prompt,
        command: job.command,
        schedule: job.schedule.display,
        scheduleKind: job.schedule.kind,
        enabled: job.enabled,
        state: job.state,
        lastStatus: job.lastStatus,
        lastError: job.lastError,
        runCount: job.runCount,
        completedRuns: job.completedRuns,
        lastRunAt: job.lastRunAt ? new Date(job.lastRunAt).toISOString() : null,
        nextRunAt: job.nextRunAt ? new Date(job.nextRunAt).toISOString() : null,
        skills: job.skills,
        deliver: job.deliver,
        tags: job.tags,
        approvalStatus: job.approvalStatus,
        executionPolicy: job.executionPolicy,
        lastTrade: job.lastTrade,
        tradeCount: job.tradeHistory?.length ?? 0,
        createdAt: new Date(job.createdAt).toISOString(),
        updatedAt: new Date(job.updatedAt).toISOString(),
        wakeAgent: job.wakeAgent,
        contextFrom: job.contextFrom,
        allowedTools: job.allowedTools,
        disallowedTools: job.disallowedTools,
        model: job.model,
        runtimeState: serializeCronState(this.cronEngine.getJobState(job.id)),
      },
      durationMs: Date.now() - start,
      truncated: false,
    };
  }
}
