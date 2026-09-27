/**
 * CronEngine — jobs.json-only cron system
 *
 * jobs.json is the single source of truth. Agents manage it via
 * CLI tools (dynatrader cron ...) or direct file edits.
 *
 * Runtime state (run counts, last output) is stored in workspace/cron/state/.
 * No database dependency.
 */

import fs from "node:fs/promises";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import Emittery from "emittery";
import type { StateDb } from "../../state-db/state-db";
import type { CronJobRow, CronStateRow } from "../../state-db/types";

const execFileAsync = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CronScheduleKind = "once" | "interval" | "cron";

export interface CronSchedule {
  kind: CronScheduleKind;
  /** Human-readable display string (e.g., "every 2h", "0 9 * * *") */
  display: string;
  /** Parsed interval in ms (for interval kind) */
  intervalMs?: number;
  /** Absolute timestamp (ms since epoch) for once kind */
  runAt?: number;
  /** Cron expression for cron kind */
  expression?: string;
}

export interface CronJobDeliver {
  target: "telegram" | "discord" | "local" | "none";
  chatId?: string;
}

export type CronPipeline = "analysis" | "execution" | "monitoring" | "research";

export interface CronTradeRecord {
  timestamp: number;
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  stopLoss?: number;
  takeProfit?: number;
  confidence?: number;
  summary?: string;
}

export interface CronJobState {
  version: 1;
  jobId: string;
  sessionId?: string;
  promptFingerprint?: string;
  prompt?: string;
  summary?: string;
  lastOutput?: string;
  lastTrade?: CronTradeRecord;
  tradeHistory?: CronTradeRecord[];
  lastVenue?: string;
  lastSymbol?: string;
  lastTimeframe?: string;
  lastStatus?: "ok" | "error" | null;
  lastError?: string;
  lastRunAt?: number;
  updatedAt: number;
}

export interface CronJob {
  id: string;
  name: string;
  /** LLM prompt to execute (null for script-only) */
  prompt?: string;
  /** Shell command to execute (no LLM) */
  command?: string;
  schedule: CronSchedule;
  /** Skills to load before execution */
  skills?: string[];
  /** Tools available to this job's agent session */
  tools?: string[];
  /** Memory namespaces this job can read/write */
  memory?: { read?: string[]; write?: string[] };
  /** MCP servers to connect for this job */
  mcps?: string[];
  /** Delivery configuration */
  deliver?: CronJobDeliver;
  enabled: boolean;
  state: "scheduled" | "paused" | "running" | "completed";
  lastStatus: "ok" | "error" | null;
  lastError?: string;
  repeatCount?: number | null;
  completedRuns: number;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  nextRunAt?: number;
  runCount: number;
  tags: string[];
  pipeline?: CronPipeline;
  approvalStatus?: "pending" | "approved" | "rejected";
  executionPolicy?: "trade" | "close-only";
  lastTrade?: CronTradeRecord;
  tradeHistory?: CronTradeRecord[];
  wakeAgent?: boolean;
  contextFrom?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  model?: { provider: string; modelName: string };
  agentId?: string;
  subagent?: string;
}

export interface CronExecution {
  jobId: string;
  timestamp: number;
  duration: number;
  success: boolean;
  output: string;
  error?: string;
}

export interface CreateCronJobSpec {
  id?: string;
  name: string;
  prompt?: string;
  command?: string;
  schedule: string;
  tags?: string[];
  skills?: string[];
  tools?: string[];
  memory?: { read?: string[]; write?: string[] };
  mcps?: string[];
  deliver?: CronJobDeliver;
  repeatCount?: number | null;
  pipeline?: CronPipeline;
  approvalStatus?: "pending" | "approved" | "rejected";
  executionPolicy?: "trade" | "close-only";
  enabled?: boolean;
  wakeAgent?: boolean;
  contextFrom?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  model?: { provider: string; modelName: string };
  agentId?: string;
  subagent?: string;
}

export interface CronEngineEvents {
  execution: { jobId: string; execution: CronExecution };
  delivery: {
    jobId: string;
    jobName: string;
    target: string;
    chatId?: string;
    content: string;
    timestamp: Date;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function validateCronCommand(cmd: string): boolean {
  if (!cmd || cmd.trim().length === 0) return false;
  const shellMetacharacters = /[;|&`$(){}<>!#*?\[\]~\\]/;
  if (shellMetacharacters.test(cmd)) return false;
  const safePattern = /^[\w\s\-.:\/@=+%,]+$/;
  return safePattern.test(cmd);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

// ---------------------------------------------------------------------------
// CronEngine
// ---------------------------------------------------------------------------

export class CronEngine extends Emittery<CronEngineEvents> {
  private workspacePath: string;
  private executeCallback?: (prompt: string, job: CronJob) => Promise<string>;
  private _tickTimer: ReturnType<typeof setInterval> | undefined;
  private _running = false;
  private _lastTickAt: string | null = null;
  private jobs: CronJob[] = [];
  private jobStates: Map<string, CronJobState> = new Map();
  private jobsPath: string;
  private stateDb?: StateDb;

  // Cross-process file locking
  private _lockFd: number | null = null;
  private _lockPath: string;

  private static readonly MAX_OUTPUT_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  private static readonly MAX_OUTPUTS_PER_JOB = 100;

  constructor(
    workspacePath: string,
    executeCallback?: (prompt: string, job: CronJob) => Promise<string>,
    stateDb?: StateDb,
  ) {
    super();
    this.workspacePath = workspacePath;
    this.executeCallback = executeCallback;
    this.jobsPath = join(workspacePath, "cron", "jobs.json");
    this._lockPath = join(workspacePath, "cron", ".tick.lock");
    this.stateDb = stateDb;
  }

  static async fromDb(
    stateDb: StateDb,
    workspacePath: string,
    executeCallback?: (prompt: string, job: CronJob) => Promise<string>,
  ): Promise<CronEngine> {
    const engine = new CronEngine(workspacePath, executeCallback, stateDb);
    await engine.initialize();
    return engine;
  }

  // -----------------------------------------------------------------------
  // Cross-Process File Locking
  // -----------------------------------------------------------------------

  private async acquireLock(retryCount = 0, depth = 0): Promise<boolean> {
    const fsMod = await import("node:fs");
    try {
      this._lockFd = fsMod.openSync(this._lockPath, "wx");
      fsMod.writeSync(this._lockFd, String(process.pid));
      return true;
    } catch {
      if (depth >= 5) return false;
      try {
        const stat = fsMod.statSync(this._lockPath);
        const age = Date.now() - stat.mtimeMs;
        if (age > 55_000) {
          fsMod.unlinkSync(this._lockPath);
          return this.acquireLock(retryCount, depth + 1);
        }
      } catch { /* ignore */ }
      return false;
    }
  }

  private releaseLock(): void {
    if (this._lockFd !== null) {
      try {
        const fsMod = require("node:fs");
        fsMod.closeSync(this._lockFd);
        fsMod.unlinkSync(this._lockPath);
      } catch { /* ignore */ }
      this._lockFd = null;
    }
  }

  // -----------------------------------------------------------------------
  // Initialization
  // -----------------------------------------------------------------------

  async initialize(): Promise<void> {
    const cronDir = join(this.workspacePath, "cron");
    if (!existsSync(cronDir)) {
      mkdirSync(cronDir, { recursive: true });
    }
    await fs.mkdir(this.outputDir(), { recursive: true });
    await fs.mkdir(this.stateDir(), { recursive: true });
    this.loadJobsSync();
    this.loadJobStatesSync();
  }

  // -----------------------------------------------------------------------
  // Job CRUD
  // -----------------------------------------------------------------------

  async createJob(spec: CreateCronJobSpec): Promise<CronJob> {
    if (!spec.prompt && !spec.command) {
      throw new Error("CronJob must have either a prompt or a command");
    }

    const id = spec.id?.trim() || randomUUID();
    const now = Date.now();
    const schedule = this.parseSchedule(spec.schedule);
    const enabled = spec.enabled ?? true;

    const job: CronJob = {
      id,
      name: spec.name,
      prompt: spec.prompt,
      command: spec.command,
      schedule,
      skills: spec.skills,
      tools: spec.tools,
      memory: spec.memory,
      mcps: spec.mcps,
      deliver: spec.deliver,
      enabled,
      state: enabled ? "scheduled" : "paused",
      lastStatus: null,
      repeatCount: spec.repeatCount ?? null,
      completedRuns: 0,
      createdAt: now,
      updatedAt: now,
      runCount: 0,
      tags: spec.tags ?? [],
      pipeline: spec.pipeline,
      approvalStatus: spec.approvalStatus,
      executionPolicy: spec.executionPolicy,
      tradeHistory: [],
      wakeAgent: spec.wakeAgent,
      contextFrom: spec.contextFrom,
      allowedTools: spec.allowedTools,
      disallowedTools: spec.disallowedTools,
      model: spec.model,
      agentId: spec.agentId,
      subagent: spec.subagent,
      nextRunAt: enabled ? this.calculateNextRun(schedule, now) ?? undefined : undefined,
    };

    this.jobs.push(job);
    this.saveJobsSync();
    this.ensureJobState(job.id, {
      sessionId: `cron:${job.id}`,
      updatedAt: now,
    });
    return job;
  }

  async getJob(id: string): Promise<CronJob | null> {
    return this.jobs.find((j) => j.id === id) ?? null;
  }

  async listJobs(enabledOnly?: boolean): Promise<CronJob[]> {
    const filtered = enabledOnly
      ? this.jobs.filter((j) => j.enabled)
      : [...this.jobs];
    return filtered.sort((a, b) => b.createdAt - a.createdAt);
  }

  async updateJob(id: string, updates: Partial<CreateCronJobSpec>): Promise<CronJob> {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) throw new Error(`CronJob not found: ${id}`);

    if (updates.name !== undefined) job.name = updates.name;
    if (updates.prompt !== undefined) job.prompt = updates.prompt;
    if (updates.command !== undefined) job.command = updates.command;
    if (updates.tags !== undefined) job.tags = updates.tags;
    if (updates.skills !== undefined) job.skills = updates.skills;
    if (updates.tools !== undefined) job.tools = updates.tools;
    if (updates.memory !== undefined) job.memory = updates.memory;
    if (updates.mcps !== undefined) job.mcps = updates.mcps;
    if (updates.deliver !== undefined) job.deliver = updates.deliver;
    if (updates.repeatCount !== undefined) job.repeatCount = updates.repeatCount;
    if (updates.pipeline !== undefined) job.pipeline = updates.pipeline;
    if (updates.approvalStatus !== undefined) job.approvalStatus = updates.approvalStatus;
    if (updates.executionPolicy !== undefined) job.executionPolicy = updates.executionPolicy;
    if (updates.wakeAgent !== undefined) job.wakeAgent = updates.wakeAgent;
    if (updates.contextFrom !== undefined) job.contextFrom = updates.contextFrom;
    if (updates.allowedTools !== undefined) job.allowedTools = updates.allowedTools;
    if (updates.disallowedTools !== undefined) job.disallowedTools = updates.disallowedTools;
    if (updates.model !== undefined) job.model = updates.model;
    if (updates.agentId !== undefined) job.agentId = updates.agentId;
    if (updates.subagent !== undefined) job.subagent = updates.subagent;
    if (updates.enabled !== undefined) {
      job.enabled = updates.enabled;
      job.state = updates.enabled ? "scheduled" : "paused";
      job.nextRunAt = updates.enabled ? this.calculateNextRun(job.schedule, Date.now()) ?? undefined : undefined;
    }
    if (updates.schedule !== undefined) {
      job.schedule = this.parseSchedule(updates.schedule);
      job.nextRunAt = job.enabled ? this.calculateNextRun(job.schedule, Date.now()) ?? undefined : undefined;
    }

    job.updatedAt = Date.now();
    void this.updateJobState(job.id, {
      sessionId: this.loadJobStateSync(job.id)?.sessionId ?? `cron:${job.id}`,
      lastStatus: job.lastStatus,
      lastError: job.lastError,
      lastRunAt: job.lastRunAt,
      updatedAt: job.updatedAt,
    }).catch(() => {});
    this.saveJobsSync();
    return job;
  }

  async deleteJob(id: string): Promise<void> {
    const idx = this.jobs.findIndex((j) => j.id === id);
    if (idx === -1) throw new Error(`CronJob not found: ${id}`);
    this.jobs.splice(idx, 1);
    this.deleteJobStateSync(id);
    this.saveJobsSync();
  }

  async recordTrade(
    jobId: string,
    trade: Omit<CronTradeRecord, "timestamp"> & { timestamp?: number },
  ): Promise<CronTradeRecord> {
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job) throw new Error(`CronJob not found: ${jobId}`);

    const record: CronTradeRecord = {
      timestamp: trade.timestamp ?? Date.now(),
      symbol: trade.symbol,
      side: trade.side,
      entryPrice: trade.entryPrice,
      stopLoss: trade.stopLoss,
      takeProfit: trade.takeProfit,
      confidence: trade.confidence,
      summary: trade.summary,
    };

    job.lastTrade = record;
    if (!job.tradeHistory) job.tradeHistory = [];
    job.tradeHistory.push(record);
    if (job.tradeHistory.length > 10) {
      job.tradeHistory = job.tradeHistory.slice(-10);
    }

    job.updatedAt = Date.now();
    void this.updateJobState(jobId, {
      lastTrade: record,
      tradeHistory: job.tradeHistory.slice(-10),
      lastRunAt: job.updatedAt,
      updatedAt: job.updatedAt,
    }).catch(() => {});
    this.saveJobsSync();
    return record;
  }

  // -----------------------------------------------------------------------
  // Job Lifecycle
  // -----------------------------------------------------------------------

  async pauseJob(id: string): Promise<CronJob> {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) throw new Error(`CronJob not found: ${id}`);
    job.state = "paused";
    job.enabled = false;
    job.updatedAt = Date.now();
    this.saveJobsSync();
    return job;
  }

  async resumeJob(id: string): Promise<CronJob> {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) throw new Error(`CronJob not found: ${id}`);
    job.state = "scheduled";
    job.enabled = true;
    job.updatedAt = Date.now();
    job.nextRunAt = this.calculateNextRun(job.schedule, Date.now()) ?? undefined;
    this.saveJobsSync();
    return job;
  }

  async triggerJob(id: string): Promise<CronExecution> {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) throw new Error(`CronJob not found: ${id}`);
    return this.executeJob(job);
  }

  async createHeartbeatJob(intervalMinutes = 30, enabled = false): Promise<CronJob> {
    const job = await this.createJob({
      name: "Heartbeat",
      prompt:
        "Read HEARTBEAT.md from workspace. Check task completion status. " +
        "Also check if any standing directives or pending actions need attention. " +
        "If all tasks are done and nothing needs action, reply with just HEARTBEAT_OK. " +
        "If any tasks need attention, list them with recommendations.",
      schedule: `every ${intervalMinutes}m`,
      tags: ["heartbeat"],
      deliver: { target: "telegram" },
    });
    if (!enabled) return this.pauseJob(job.id);
    return job;
  }

  // -----------------------------------------------------------------------
  // Schedule Parsing
  // -----------------------------------------------------------------------

  parseSchedule(input: string): CronSchedule {
    const trimmed = input.trim();

    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed)) {
      const timestamp = new Date(trimmed).getTime();
      if (isNaN(timestamp)) throw new Error(`Invalid ISO timestamp schedule: "${input}"`);
      return { kind: "once", display: trimmed, runAt: timestamp };
    }

    const lowered = trimmed.toLowerCase();

    if (/^\d+[mhd]$/.test(lowered)) {
      const ms = this.parseDurationMs(lowered);
      return { kind: "once", display: trimmed, runAt: Date.now() + ms };
    }

    if (lowered.startsWith("every ")) {
      const rest = lowered.slice(6).trim();
      if (!/^\d+[mhd]$/.test(rest)) throw new Error(`Invalid interval schedule: "${input}"`);
      const ms = this.parseDurationMs(rest);
      return { kind: "interval", display: trimmed, intervalMs: ms };
    }

    if (this.isCronExpression(trimmed)) {
      return { kind: "cron", display: trimmed, expression: trimmed };
    }

    throw new Error(`Unable to parse schedule expression: "${input}"`);
  }

  // -----------------------------------------------------------------------
  // Next-Run Calculation
  // -----------------------------------------------------------------------

  calculateNextRun(schedule: CronSchedule, from?: number): number | null {
    const now = from ?? Date.now();
    switch (schedule.kind) {
      case "once":
        if (!schedule.runAt) return null;
        return schedule.runAt > now ? schedule.runAt : null;
      case "interval":
        if (!schedule.intervalMs) return null;
        return now + schedule.intervalMs;
      case "cron":
        if (!schedule.expression) return null;
        return this.calculateNextCronRun(schedule.expression, now);
      default:
        return null;
    }
  }

  // -----------------------------------------------------------------------
  // Scheduler Loop
  // -----------------------------------------------------------------------

  start(): void {
    if (this._running) return;
    this._running = true;
    this._tickTimer = setInterval(() => {
      this.tick().catch((err) => {
        console.error("[CronEngine] Tick error:", err);
      });
    }, 60_000);
  }

  stop(): void {
    this._running = false;
    if (this._tickTimer !== undefined) {
      clearInterval(this._tickTimer);
      this._tickTimer = undefined;
    }
  }

  async tick(): Promise<void> {
    this._lastTickAt = new Date().toISOString();
    await this.cleanupOldOutputs().catch((err) => {
      console.error("[CronEngine] Output cleanup error:", err);
    });

    const locked = await this.acquireLock();
    if (!locked) return;

    try {
      const now = Date.now();
      for (const job of this.jobs) {
        if (job.state !== "scheduled" || !job.enabled || !job.nextRunAt) continue;
        if (job.nextRunAt > now) continue;

        if (
          job.repeatCount !== null &&
          job.repeatCount !== undefined &&
          job.completedRuns >= job.repeatCount
        ) {
          job.state = "completed";
          job.updatedAt = Date.now();
          this.saveJobsSync();
          continue;
        }

        try {
          await this.executeJob(job);
        } catch (err) {
          console.error(`[CronEngine] Failed to execute job ${job.id}:`, err);
        }
      }
    } finally {
      this.releaseLock();
    }
  }

  // -----------------------------------------------------------------------
  // Job Execution
  // -----------------------------------------------------------------------

  private async executeJob(job: CronJob): Promise<CronExecution> {
    const startTime = Date.now();
    let success = false;
    let output = "";
    let error: string | undefined;

    job.state = "running";
    job.lastRunAt = startTime;
    this.saveJobsSync();

    try {
      if (job.command) {
        if (!validateCronCommand(job.command)) {
          throw new Error(
            `CronJob '${job.name}' (${job.id}) command contains invalid or dangerous characters.`,
          );
        }
        const commandParts = job.command.trim().split(/\s+/);
        const commandName = commandParts[0] ?? '';
        const commandArgs = commandParts.slice(1);
        const windowsBuiltin = process.platform === 'win32' &&
          new Set(['echo', 'dir', 'type', 'where']).has(commandName.toLowerCase());
        const { stdout: rawOutput } = windowsBuiltin
          ? await execFileAsync('cmd.exe', ['/d', '/s', '/c', job.command], { timeout: 300_000, cwd: this.workspacePath, windowsHide: true })
          : await execFileAsync(commandName, commandArgs, { timeout: 300_000, cwd: this.workspacePath });
        output = rawOutput.trim();

        if (output !== "NO_REPLY" && output !== "[SILENT]" && output !== "HEARTBEAT_OK") {
          await this.deliver(job, output);
        }
      } else if (this.executeCallback) {
        if (job.wakeAgent) {
          const checkpoint = this.loadWakeCheckpoint(job.id);
          const currentHash = await this.computeWorldHash();

          if (checkpoint && checkpoint.hash === currentHash) {
            output = "[SILENT] wakeAgent: no changes detected, skipping";
            const duration = Date.now() - startTime;
            const execution: CronExecution = { jobId: job.id, timestamp: startTime, duration, success: true, output };
            job.lastStatus = "ok";
            job.runCount++;
            job.completedRuns++;

            if (job.repeatCount !== null && job.repeatCount !== undefined && job.completedRuns >= job.repeatCount) {
              job.state = "completed";
            } else {
              job.state = "scheduled";
              job.nextRunAt = this.calculateNextRun(job.schedule, Date.now()) ?? undefined;
            }

            job.updatedAt = Date.now();
            void this.updateJobState(job.id, {
              sessionId: this.loadJobStateSync(job.id)?.sessionId ?? `cron:${job.id}`,
              lastStatus: "ok",
              lastError: undefined,
              lastRunAt: job.lastRunAt,
              summary: this.truncateForState(output),
              lastOutput: output,
              updatedAt: job.updatedAt,
            });
            this.saveJobsSync();
            await this.saveExecutionOutput(job, execution);
            await this.emit("execution", { jobId: job.id, execution });
            return execution;
          }
          this.saveWakeCheckpoint(job.id, currentHash);
        }

        let finalPrompt = job.prompt?.trim() ?? "";
        if (job.contextFrom) {
          const upstreamJob = this.jobs.find((j) => j.id === job.contextFrom);
          if (upstreamJob?.lastStatus === "ok") {
            const upstreamOutput = await this.loadLastExecutionOutput(upstreamJob.id);
            if (upstreamOutput) {
              finalPrompt = `## Context from "${upstreamJob.name}" (${upstreamJob.id})\n\n${upstreamOutput}\n\n---\n\n${finalPrompt}`;
            }
          }
        }

        output = await this.executeCallback(finalPrompt, job);

        if (!output || output.trim().length === 0) {
          throw new Error(`Cron job ${job.id} (${job.name}) produced no visible output.`);
        }

        if (output && !output.includes("HEARTBEAT_OK") && !output.includes("[SILENT]")) {
          await this.deliver(job, output);
        }
      } else {
        output = "[CronEngine] No execute callback registered — job not executed";
        error = "No execute callback registered";
      }
      success = error === undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      output = `Error: ${message}`;
      error = message;
      success = false;
    }

    const duration = Date.now() - startTime;
    const execution: CronExecution = { jobId: job.id, timestamp: startTime, duration, success, output, error };

    job.lastStatus = success ? "ok" : "error";
    job.lastError = error;
    job.runCount++;
    job.completedRuns++;

    if (job.repeatCount !== null && job.repeatCount !== undefined && job.completedRuns >= job.repeatCount) {
      job.state = "completed";
    } else {
      job.state = "scheduled";
      job.nextRunAt = this.calculateNextRun(job.schedule, Date.now()) ?? undefined;
    }

    job.updatedAt = Date.now();
    this.saveJobsSync();
    await this.saveExecutionOutput(job, execution);
    await this.emit("execution", { jobId: job.id, execution });
    return execution;
  }

  // -----------------------------------------------------------------------
  // Delivery
  // -----------------------------------------------------------------------

  private async deliver(job: CronJob, output: string): Promise<void> {
    if (!job.deliver || job.deliver.target === "none") return;
    if (!output || output.trim().length === 0) return;

    await this.emit("delivery", {
      jobId: job.id,
      jobName: job.name,
      target: job.deliver.target,
      chatId: job.deliver.chatId,
      content: output,
      timestamp: new Date(),
    });
  }

  // -----------------------------------------------------------------------
  // Persistence (jobs.json + state files only)
  // -----------------------------------------------------------------------

  private outputDir(): string {
    return join(this.workspacePath, "cron", "output");
  }

  private stateDir(): string {
    return join(this.workspacePath, "cron", "state");
  }

  private executionOutputDir(jobId: string): string {
    return join(this.outputDir(), jobId);
  }

  private executionOutputPath(jobId: string, timestamp: number): string {
    return join(this.executionOutputDir(jobId), `${timestamp}.md`);
  }

  private loadJobsSync(): void {
    if (this.stateDb) {
      try {
        const rows = this.stateDb.listCronJobs();
        if (rows.length > 0) {
          this.jobs = rows.map((row) => this.fromStateDbJob(row));
          return;
        }
      } catch (err) {
        console.warn('[CronEngine] Failed to load jobs from StateDb, using jobs.json:', err);
      }
    }
    try {
      if (existsSync(this.jobsPath)) {
        const data = readFileSync(this.jobsPath, "utf-8");
        this.jobs = JSON.parse(data);
        return;
      }
    } catch (err) {
      console.warn('[CronEngine] Failed to load jobs.json, starting fresh:', err);
    }
    this.jobs = [];
  }

  private loadJobStatesSync(): void {
    try {
      if (existsSync(this.stateDir())) {
        for (const file of readdirSync(this.stateDir())) {
          if (!file.endsWith(".json")) continue;
          const filePath = join(this.stateDir(), file);
          try {
            const raw = readFileSync(filePath, "utf-8");
            const parsed = JSON.parse(raw) as Partial<CronJobState> & { jobId?: string };
            const jobId = parsed.jobId?.trim() || file.replace(/\.json$/i, "");
            if (!jobId) continue;
            this.jobStates.set(jobId, this.normalizeJobState(jobId, parsed));
          } catch (err) {
            console.warn('[CronEngine] Ignoring malformed state file:', file, err);
          }
        }
      }
    } catch (err) {
      console.warn('[CronEngine] Failed to load job states:', err);
    }
  }

  private loadJobStateSync(jobId: string): CronJobState | null {
    const cached = this.jobStates.get(jobId);
    if (cached) return this.cloneJobState(cached);

    try {
      const filePath = this.jobStatePath(jobId);
      if (!existsSync(filePath)) return null;
      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<CronJobState> & { jobId?: string };
      const state = this.normalizeJobState(jobId, parsed);
      this.jobStates.set(jobId, state);
      return this.cloneJobState(state);
    } catch {
      return null;
    }
  }

  private saveJobsSync(): void {
    if (this.stateDb) {
      try {
        for (const job of this.jobs) this.stateDb.saveCronJob(this.toStateDbJob(job));
      } catch (err) {
        console.warn('[CronEngine] Failed to persist jobs to StateDb:', err);
      }
    }
    try {
      const tmpPath = `${this.jobsPath}.tmp.${process.pid}`;
      writeFileSync(tmpPath, JSON.stringify(this.jobs, null, 2), "utf-8");
      const fsMod = require("node:fs");
      fsMod.renameSync(tmpPath, this.jobsPath);
    } catch (err) {
      console.warn('[CronEngine] Failed to persist jobs.json (atomic write):', err);
      try {
        writeFileSync(this.jobsPath, JSON.stringify(this.jobs, null, 2), "utf-8");
      } catch (err2) {
        console.warn('[CronEngine] Fallback jobs.json write also failed:', err2);
      }
    }
  }

  private jobStatePath(jobId: string): string {
    return join(this.stateDir(), `${jobId}.json`);
  }

  private saveJobStateSync(jobId: string, state: CronJobState): void {
    if (this.stateDb) {
      try {
        this.stateDb.saveCronState(this.toStateDbState(state));
      } catch (err) {
        console.warn('[CronEngine] Failed to persist cron state to StateDb:', err);
      }
    }
    try {
      mkdirSync(this.stateDir(), { recursive: true });
      this.jobStates.set(jobId, state);
      writeFileSync(this.jobStatePath(jobId), JSON.stringify(state, null, 2), "utf-8");
    } catch {
      // Silently fail
    }
  }

  private deleteJobStateSync(jobId: string): void {
    this.jobStates.delete(jobId);
    if (this.stateDb) {
      try { this.stateDb.deleteCronJob(jobId); } catch { /* file state remains authoritative fallback */ }
    }
    try {
      const filePath = this.jobStatePath(jobId);
      if (existsSync(filePath)) unlinkSync(filePath);
    } catch {
      // Silently fail
    }
  }

  private toStateDbJob(job: CronJob): CronJobRow {
    return {
      id: job.id, name: job.name, prompt: job.prompt ?? null, command: job.command ?? null,
      schedule_kind: job.schedule.kind, schedule_display: job.schedule.display,
      schedule_interval_ms: job.schedule.intervalMs ?? null, schedule_expression: job.schedule.expression ?? null,
      schedule_run_at: job.schedule.runAt ?? null, skills: JSON.stringify(job.skills ?? []),
      deliver: JSON.stringify(job.deliver ?? { target: 'none' }), enabled: job.enabled ? 1 : 0,
      state: job.state, last_status: job.lastStatus, last_error: job.lastError ?? null,
      repeat_count: job.repeatCount ?? null, completed_runs: job.completedRuns, tags: JSON.stringify(job.tags),
      pipeline: job.pipeline ?? null, approval_status: job.approvalStatus ?? null,
      execution_policy: job.executionPolicy ?? null, wake_agent: job.wakeAgent ? 1 : 0,
      context_from: job.contextFrom ?? null, allowed_tools: job.allowedTools ? JSON.stringify(job.allowedTools) : null,
      disallowed_tools: job.disallowedTools ? JSON.stringify(job.disallowedTools) : null,
      model_config: job.model ? JSON.stringify(job.model) : null, agent_id: job.agentId ?? null,
      subagent: job.subagent ?? null, created_at: job.createdAt, updated_at: job.updatedAt,
    };
  }

  private fromStateDbJob(row: CronJobRow): CronJob {
    const parse = <T>(value: string | null | undefined, fallback: T): T => {
      if (!value) return fallback;
      try { return JSON.parse(value) as T; } catch { return fallback; }
    };
    return {
      id: row.id, name: row.name, prompt: row.prompt ?? undefined, command: row.command ?? undefined,
      schedule: { kind: row.schedule_kind, display: row.schedule_display, intervalMs: row.schedule_interval_ms ?? undefined, expression: row.schedule_expression ?? undefined, runAt: row.schedule_run_at ?? undefined },
      skills: parse(row.skills, []), tools: undefined, deliver: parse(row.deliver, undefined), enabled: row.enabled === 1,
      state: row.state, lastStatus: row.last_status, lastError: row.last_error ?? undefined,
      repeatCount: row.repeat_count, completedRuns: row.completed_runs, createdAt: row.created_at, updatedAt: row.updated_at,
      runCount: row.completed_runs, tags: parse(row.tags, []), pipeline: (row.pipeline as CronPipeline | null) ?? undefined,
      approvalStatus: (row.approval_status as CronJob['approvalStatus']) ?? undefined,
      executionPolicy: (row.execution_policy as CronJob['executionPolicy']) ?? undefined, wakeAgent: row.wake_agent === 1,
      contextFrom: row.context_from ?? undefined, allowedTools: parse(row.allowed_tools, undefined), disallowedTools: parse(row.disallowed_tools, undefined),
      model: parse(row.model_config, undefined), agentId: row.agent_id ?? undefined, subagent: row.subagent ?? undefined,
    };
  }

  private toStateDbState(state: CronJobState): CronStateRow {
    return {
      id: state.jobId, job_id: state.jobId, version: state.version, session_id: state.sessionId ?? null,
      prompt_fingerprint: state.promptFingerprint ?? null, summary: state.summary ?? null, last_output: state.lastOutput ?? null,
      last_trade: state.lastTrade ? JSON.stringify(state.lastTrade) : null, trade_history: state.tradeHistory ? JSON.stringify(state.tradeHistory) : null,
      last_venue: state.lastVenue ?? null, last_symbol: state.lastSymbol ?? null, last_timeframe: state.lastTimeframe ?? null,
      last_status: state.lastStatus ?? null, last_error: state.lastError ?? null, last_run_at: state.lastRunAt ?? null, updated_at: state.updatedAt,
    };
  }

  ensureJobState(jobId: string, seed?: Partial<CronJobState>): CronJobState {
    const job = this.jobs.find((entry) => entry.id === jobId);
    if (!job) throw new Error(`CronJob not found: ${jobId}`);

    const current = this.loadJobStateSync(jobId) ?? this.normalizeJobState(jobId, {
      sessionId: `cron:${jobId}`,
      updatedAt: Date.now(),
    });
    const next = this.normalizeJobState(jobId, {
      ...current,
      ...seed,
      jobId,
      updatedAt: seed?.updatedAt ?? current.updatedAt ?? Date.now(),
    });
    this.saveJobStateSync(jobId, next);
    return this.cloneJobState(next);
  }

  getJobState(jobId: string): CronJobState | null {
    return this.loadJobStateSync(jobId);
  }

  async updateJobState(jobId: string, updates: Partial<CronJobState>): Promise<CronJobState> {
    const job = this.jobs.find((entry) => entry.id === jobId);
    if (!job) throw new Error(`CronJob not found: ${jobId}`);

    const current = this.loadJobStateSync(jobId) ?? this.normalizeJobState(jobId, {
      sessionId: `cron:${jobId}`,
      updatedAt: Date.now(),
    });
    const next = this.normalizeJobState(jobId, {
      ...current,
      ...updates,
      jobId,
      updatedAt: updates.updatedAt ?? Date.now(),
    });
    this.saveJobStateSync(jobId, next);
    return this.cloneJobState(next);
  }

  private normalizeJobState(jobId: string, state: Partial<CronJobState>): CronJobState {
    const tradeHistory = Array.isArray(state.tradeHistory) ? state.tradeHistory.slice(-10) : undefined;
    return {
      version: 1,
      jobId,
      sessionId: state.sessionId,
      promptFingerprint: state.promptFingerprint,
      prompt: state.prompt,
      summary: state.summary,
      lastOutput: state.lastOutput,
      lastTrade: state.lastTrade,
      tradeHistory,
      lastVenue: state.lastVenue,
      lastSymbol: state.lastSymbol,
      lastTimeframe: state.lastTimeframe,
      lastStatus: state.lastStatus ?? null,
      lastError: state.lastError,
      lastRunAt: state.lastRunAt,
      updatedAt: state.updatedAt ?? Date.now(),
    };
  }

  private cloneJobState(state: CronJobState): CronJobState {
    return JSON.parse(JSON.stringify(state)) as CronJobState;
  }

  private truncateForState(text: string, maxChars = 4000): string {
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars).trimEnd()}\n... [truncated ${text.length - maxChars} chars]`;
  }

  private async saveExecutionOutput(job: CronJob, execution: CronExecution): Promise<void> {
    const dir = this.executionOutputDir(job.id);
    await fs.mkdir(dir, { recursive: true });

    const md = [
      `# Cron Execution`,
      ``,
      `- **Job ID:** ${execution.jobId}`,
      `- **Job Name:** ${job.name}`,
      `- **Timestamp:** ${new Date(execution.timestamp).toISOString()}`,
      `- **Duration:** ${execution.duration}ms`,
      `- **Status:** ${execution.success ? "Success" : "Failed"}`,
      job.prompt ? `- **Prompt:** ${job.prompt}` : "",
      job.command ? `- **Command:** ${job.command}` : "",
      ``,
      `## Output`,
      ``,
      execution.output,
      ``,
    ]
      .filter((l) => l !== "")
      .join("\n");

    await fs.writeFile(this.executionOutputPath(job.id, execution.timestamp), md, "utf-8");
  }

  // -----------------------------------------------------------------------
  // Output Cleanup
  // -----------------------------------------------------------------------

  private async cleanupOldOutputs(): Promise<void> {
    const outputBase = this.outputDir();
    try {
      if (!existsSync(outputBase)) return;
      const jobDirs = await fs.readdir(outputBase);
      for (const jobId of jobDirs) {
        const jobDir = join(outputBase, jobId);
        const stat = await fs.stat(jobDir).catch(() => null);
        if (!stat || !stat.isDirectory()) continue;

        const files = await fs.readdir(jobDir);
        const sorted = files.sort().reverse();

        for (let i = CronEngine.MAX_OUTPUTS_PER_JOB; i < sorted.length; i++) {
          await fs.unlink(join(jobDir, sorted[i]!)).catch(() => {});
        }

        const cutoff = Date.now() - CronEngine.MAX_OUTPUT_AGE_MS;
        for (const file of sorted.slice(0, CronEngine.MAX_OUTPUTS_PER_JOB)) {
          const filePath = join(jobDir, file);
          const fileStat = await fs.stat(filePath).catch(() => null);
          if (fileStat && fileStat.mtimeMs < cutoff) {
            await fs.unlink(filePath).catch(() => {});
          }
        }

        const remaining = await fs.readdir(jobDir);
        if (remaining.length === 0) {
          await fs.rmdir(jobDir).catch(() => {});
        }
      }
    } catch { /* ignore */ }
  }

  // -----------------------------------------------------------------------
  // Wake Agent Helpers
  // -----------------------------------------------------------------------

  private wakeCheckpointsDir(): string {
    return join(this.workspacePath, "cron", "wake-checkpoints");
  }

  private wakeCheckpointPath(jobId: string): string {
    return join(this.wakeCheckpointsDir(), `${jobId}.json`);
  }

  private loadWakeCheckpoint(jobId: string): { hash: string; timestamp: number } | null {
    try {
      const path = this.wakeCheckpointPath(jobId);
      if (!existsSync(path)) return null;
      const data = readFileSync(path, "utf-8");
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  private saveWakeCheckpoint(jobId: string, hash: string): void {
    try {
      const dir = this.wakeCheckpointsDir();
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(
        this.wakeCheckpointPath(jobId),
        JSON.stringify({ hash, timestamp: Date.now() }),
        "utf-8",
      );
    } catch { /* silently fail */ }
  }

  private async computeWorldHash(): Promise<string> {
    const crypto = await import("node:crypto");
    const filesToCheck = ["HEARTBEAT.md", "PLAN.md", "PROGRESS.md"];
    const parts: string[] = [];

    try {
      if (existsSync(this.jobsPath)) {
        parts.push(readFileSync(this.jobsPath, "utf-8"));
      }
    } catch { /* ignore */ }

    for (const file of filesToCheck) {
      const filePath = join(this.workspacePath, file);
      try {
        if (existsSync(filePath)) parts.push(readFileSync(filePath, "utf-8"));
      } catch { /* ignore */ }
    }

    return crypto.createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
  }

  // -----------------------------------------------------------------------
  // Context From Helpers
  // -----------------------------------------------------------------------

  private async loadLastExecutionOutput(jobId: string): Promise<string | null> {
    const dir = this.executionOutputDir(jobId);
    try {
      if (!existsSync(dir)) return null;
      const files = await fs.readdir(dir);
      if (files.length === 0) return null;
      const sorted = files.sort().reverse();
      const content = await fs.readFile(join(dir, sorted[0]!), "utf-8");
      const outputMatch = content.match(/## Output\n\n([\s\S]*)/);
      return outputMatch?.[1]?.trim() ?? content;
    } catch {
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Internal Helpers
  // -----------------------------------------------------------------------

  private parseDurationMs(input: string): number {
    const match = input.match(/^(\d+)([mhd])$/);
    if (!match) throw new Error(`Invalid duration: "${input}"`);
    const value = parseInt(match[1]!, 10);
    const unit = match[2]!;
    switch (unit) {
      case "m": return value * 60_000;
      case "h": return value * 3_600_000;
      case "d": return value * 86_400_000;
      default: throw new Error(`Unknown duration unit: "${unit}"`);
    }
  }

  private isCronExpression(input: string): boolean {
    const parts = input.trim().split(/\s+/);
    if (parts.length !== 5) return false;
    const cronFieldPattern = /^(\*|\d+(-\d+)?(\/\d+)?)(,\d+(-\d+)?(\/\d+)?)*$/;
    return parts.every((part) => cronFieldPattern.test(part));
  }

  private calculateNextCronRun(expression: string, from: number): number {
    const parts = expression.trim().split(/\s+/);
    if (parts.length !== 5) {
      throw new Error(`Invalid cron expression: "${expression}". Must have 5 fields.`);
    }

    const start = new Date(from);
    start.setSeconds(0, 0);
    start.setMilliseconds(0);
    start.setMinutes(start.getMinutes() + 1);

    const maxIterations = 1_051_200;

    for (let i = 0; i < maxIterations; i++) {
      const candidate = new Date(start.getTime() + i * 60_000);
      const minute = candidate.getMinutes();
      const hour = candidate.getHours();
      const day = candidate.getDate();
      const month = candidate.getMonth() + 1;
      const weekday = candidate.getDay();

      if (
        this.cronFieldMatches(minute, parts[0]!) &&
        this.cronFieldMatches(hour, parts[1]!) &&
        this.cronFieldMatches(day, parts[2]!) &&
        this.cronFieldMatches(month, parts[3]!) &&
        this.cronFieldMatches(weekday, parts[4]!)
      ) {
        return candidate.getTime();
      }
    }

    throw new Error(`Could not find next cron match for "${expression}" within 2 years`);
  }

  private cronFieldMatches(value: number, field: string): boolean {
    if (field === "*") return true;
    if (field.includes(",")) {
      return field.split(",").some((part) => this.cronFieldMatches(value, part.trim()));
    }

    let rangeStr = field;
    let step = 1;

    if (field.includes("/")) {
      const slashIdx = field.indexOf("/");
      rangeStr = field.slice(0, slashIdx);
      step = parseInt(field.slice(slashIdx + 1), 10);
      if (isNaN(step) || step < 1) return false;
    }

    if (rangeStr.includes("-")) {
      const dashIdx = rangeStr.indexOf("-");
      const low = parseInt(rangeStr.slice(0, dashIdx), 10);
      const high = parseInt(rangeStr.slice(dashIdx + 1), 10);
      if (isNaN(low) || isNaN(high)) return false;
      if (value < low || value > high) return false;
      if (step > 1 && (value - low) % step !== 0) return false;
      return true;
    }

    const exact = parseInt(rangeStr, 10);
    if (isNaN(exact)) return false;
    if (value !== exact) return false;
    return step === 1 || (value - exact) % step === 0;
  }

  // -----------------------------------------------------------------------
  // Status
  // -----------------------------------------------------------------------

  getStatus(): {
    running: boolean;
    jobCount: number;
    enabledJobs: number;
    lastTickAt: string | null;
    nextTickIn: number | null;
  } {
    return {
      running: this._running,
      jobCount: this.jobs.length,
      enabledJobs: this.jobs.filter((j) => j.enabled && j.state === "scheduled").length,
      lastTickAt: this._lastTickAt,
      nextTickIn: this._running ? 60_000 : null,
    };
  }
}
