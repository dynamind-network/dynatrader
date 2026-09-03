/**
 * Cron Scheduler — SQLite-backed scheduled task execution
 *
 * Parses cron expressions, ticks every 60 seconds, enqueues jobs into TaskQueue.
 */

import { randomUUID } from 'crypto';
import type { StateDb } from 'dynatrader';
import type { TaskQueue, TaskPayload } from './task-queue.js';

export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  taskType: string;
  payload: TaskPayload;
  enabled: boolean;
  lastRunAt: number | null;
  nextRunAt: number;
  createdAt: number;
  maxRuns: number | null;
  runCount: number;
}

export interface CronJobOptions {
  name: string;
  schedule: string;
  taskType: string;
  payload: TaskPayload;
  maxRuns?: number;
  enabled?: boolean;
}

export class CronScheduler {
  private db: StateDb;
  private taskQueue: TaskQueue;
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private jobs: Map<string, CronJob> = new Map();

  constructor(db: StateDb, taskQueue: TaskQueue) {
    this.db = db;
    this.taskQueue = taskQueue;
    this.loadJobs();
  }

  private loadJobs(): void {
    const rows = this.db.loadCronJobsCompat();
    for (const row of rows) {
      const job: CronJob = {
        id: row.id,
        name: row.name,
        schedule: row.schedule,
        taskType: row.taskType,
        payload: row.payload,
        enabled: row.enabled,
        lastRunAt: row.lastRunAt,
        nextRunAt: row.nextRunAt,
        createdAt: row.createdAt,
        maxRuns: row.maxRuns,
        runCount: row.runCount,
      };
      this.jobs.set(job.id, job);
    }
  }

  createJob(options: CronJobOptions): CronJob {
    const id = `cron_${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const nextRunAt = this.getNextRunTime(options.schedule, now);

    const job: CronJob = {
      id,
      name: options.name,
      schedule: options.schedule,
      taskType: options.taskType,
      payload: options.payload,
      enabled: options.enabled ?? true,
      lastRunAt: null,
      nextRunAt,
      createdAt: now,
      maxRuns: options.maxRuns ?? null,
      runCount: 0,
    };

    this.jobs.set(id, job);
    this.db.saveCronJobCompat({
      id: job.id,
      name: job.name,
      schedule: job.schedule,
      taskType: job.taskType,
      payload: job.payload as Record<string, unknown>,
      enabled: job.enabled,
      lastRunAt: job.lastRunAt ?? undefined,
      nextRunAt: job.nextRunAt,
      createdAt: job.createdAt,
      maxRuns: job.maxRuns ?? undefined,
      runCount: job.runCount,
    });

    return job;
  }

  deleteJob(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    this.jobs.delete(id);
    this.db.deleteCronJob(id);
    return true;
  }

  pauseJob(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.enabled = false;
    this.db.saveCronJobCompat({
      id: job.id,
      name: job.name,
      schedule: job.schedule,
      taskType: job.taskType,
      payload: job.payload as Record<string, unknown>,
      enabled: false,
      lastRunAt: job.lastRunAt ?? undefined,
      nextRunAt: job.nextRunAt,
      createdAt: job.createdAt,
      maxRuns: job.maxRuns ?? undefined,
      runCount: job.runCount,
    });
    return true;
  }

  resumeJob(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.enabled = true;
    job.nextRunAt = this.getNextRunTime(job.schedule, Date.now());
    this.db.saveCronJobCompat({
      id: job.id,
      name: job.name,
      schedule: job.schedule,
      taskType: job.taskType,
      payload: job.payload as Record<string, unknown>,
      enabled: true,
      lastRunAt: job.lastRunAt ?? undefined,
      nextRunAt: job.nextRunAt,
      createdAt: job.createdAt,
      maxRuns: job.maxRuns ?? undefined,
      runCount: job.runCount,
    });
    return true;
  }

  listJobs(): CronJob[] {
    return Array.from(this.jobs.values());
  }

  getJob(id: string): CronJob | undefined {
    return this.jobs.get(id);
  }

  start(intervalMs: number = 60_000): void {
    if (this.tickInterval) return;
    this.tickInterval = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  private async tick(): Promise<void> {
    const now = Date.now();

    for (const job of this.jobs.values()) {
      if (!job.enabled) continue;
      if (job.nextRunAt > now) continue;
      if (job.maxRuns !== null && job.runCount >= job.maxRuns) {
        job.enabled = false;
      this.db.saveCronJobCompat({
        id: job.id,
        name: job.name,
        schedule: job.schedule,
        taskType: job.taskType,
        payload: job.payload as Record<string, unknown>,
        enabled: false,
        lastRunAt: job.lastRunAt ?? undefined,
        nextRunAt: job.nextRunAt,
        createdAt: job.createdAt,
        maxRuns: job.maxRuns ?? undefined,
        runCount: job.runCount,
      });
      continue;
    }

    this.taskQueue.enqueue({
      type: job.taskType as 'cron',
      priority: 5,
      payload: job.payload,
      maxRetries: 1,
      timeout: 5 * 60 * 1000,
      tags: ['cron', job.name],
    });

    job.runCount++;
    job.lastRunAt = now;
    job.nextRunAt = this.getNextRunTime(job.schedule, now);

    this.db.saveCronJobCompat({
      id: job.id,
      name: job.name,
      schedule: job.schedule,
      taskType: job.taskType,
      payload: job.payload as Record<string, unknown>,
      enabled: job.enabled,
      lastRunAt: job.lastRunAt,
      nextRunAt: job.nextRunAt,
      createdAt: job.createdAt,
      maxRuns: job.maxRuns ?? undefined,
      runCount: job.runCount,
    });
    }
  }

  getNextRunTime(schedule: string, from: Date | number = Date.now()): number {
    const date = new Date(from);
    const parts = schedule.trim().split(/\s+/);

    if (parts.length !== 5) {
      return date.getTime() + 60_000;
    }

    const [minExpr, hourExpr, domExpr, monthExpr, dowExpr] = parts;

    const minute = this.parseField(minExpr, 0, 59);
    const hour = this.parseField(hourExpr, 0, 23);
    const dom = this.parseField(domExpr, 1, 31);
    const month = this.parseField(monthExpr, 1, 12);
    const dow = this.parseField(dowExpr, 0, 6);

    const next = new Date(date);
    next.setSeconds(0, 0);
    next.setMinutes(next.getMinutes() + 1);

    for (let i = 0; i < 366 * 24 * 60; i++) {
      const candidate = new Date(date.getTime() + i * 60_000);
      candidate.setSeconds(0, 0);

      if (minute.length > 0 && !minute.includes(candidate.getMinutes())) continue;
      if (hour.length > 0 && !hour.includes(candidate.getHours())) continue;
      if (dom.length > 0 && !dom.includes(candidate.getDate())) continue;
      if (month.length > 0 && !month.includes(candidate.getMonth() + 1)) continue;
      if (dow.length > 0 && !dow.includes(candidate.getDay())) continue;

      return candidate.getTime();
    }

    return date.getTime() + 60_000;
  }

  private parseField(field: string, min: number, max: number): number[] {
    if (field === '*') {
      return [];
    }

    const values = new Set<number>();

    for (const part of field.split(',')) {
      if (part.includes('/')) {
        const [range, stepStr] = part.split('/');
        const step = parseInt(stepStr, 10);
        if (isNaN(step) || step <= 0) continue;

        const [rangeMin, rangeMax] = range === '*'
          ? [min, max]
          : range.split('-').map(Number);

        if (isNaN(rangeMin) || isNaN(rangeMax)) continue;

        for (let i = rangeMin; i <= rangeMax; i += step) {
          values.add(i);
        }
      } else if (part.includes('-')) {
        const [a, b] = part.split('-').map(Number);
        if (!isNaN(a) && !isNaN(b)) {
          for (let i = a; i <= b; i++) {
            values.add(i);
          }
        }
      } else {
        const v = parseInt(part, 10);
        if (!isNaN(v)) values.add(v);
      }
    }

    return Array.from(values).sort((a, b) => a - b);
  }
}

export default CronScheduler;
