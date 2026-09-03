/**
 * Durable Task Model — Persistent Task Queue
 *
 * Agent-side self-scheduling with exponential backoff retries.
 * Tasks survive crashes via SQLite persistence.
 *
 * States: pending → running → completed | failed → (retry) → pending
 *                                                 → blocked → pending
 *                                                 → cancelled
 */

import { randomUUID } from "node:crypto";

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "blocked" | "cancelled";

export interface TaskRecord {
  id: string;
  sessionId: string;
  goalId?: string;
  status: TaskStatus;
  payload: {
    type: string;
    description: string;
    data?: unknown;
  };
  result?: unknown;
  error?: string;
  retries: number;
  maxRetries: number;
  nextRunAt: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  metadata?: Record<string, unknown>;
}

export interface TaskCreateInput {
  sessionId: string;
  goalId?: string;
  type: string;
  description: string;
  data?: unknown;
  maxRetries?: number;
  /** Initial delay before first run (ms). Default: 0 */
  initialDelayMs?: number;
  metadata?: Record<string, unknown>;
}

export interface TaskListOptions {
  sessionId?: string;
  goalId?: string;
  status?: TaskStatus;
  type?: string;
  limit?: number;
}

export interface TaskExecutor {
  (task: TaskRecord): Promise<unknown>;
}

export interface DurableTaskModelConfig {
  /** Base delay for exponential backoff (ms). Default: 1000 */
  baseBackoffMs?: number;
  /** Max backoff delay (ms). Default: 300000 (5 min) */
  maxBackoffMs?: number;
  /** Max tasks to process per tick. Default: 10 */
  maxTasksPerTick?: number;
  /** Tick interval (ms). Default: 5000 */
  tickIntervalMs?: number;
}

export interface TaskModelEvents {
  onTaskStarted?: (task: TaskRecord) => void;
  onTaskCompleted?: (task: TaskRecord) => void;
  onTaskFailed?: (task: TaskRecord) => void;
  onTaskCancelled?: (task: TaskRecord) => void;
}

/**
 * In-memory durable task model with persistence adapter pattern.
 * Storage is injected — can be SQLite, file, or any durable backend.
 */
export class DurableTaskModel {
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxTasksPerTick: number;
  private readonly tickIntervalMs: number;
  private readonly events: TaskModelEvents;

  private tasks = new Map<string, TaskRecord>();
  private executors = new Map<string, TaskExecutor>();
  private tickTimer?: ReturnType<typeof setInterval>;

  constructor(config?: DurableTaskModelConfig, events?: TaskModelEvents) {
    this.baseBackoffMs = config?.baseBackoffMs ?? 1000;
    this.maxBackoffMs = config?.maxBackoffMs ?? 300000;
    this.maxTasksPerTick = config?.maxTasksPerTick ?? 10;
    this.tickIntervalMs = config?.tickIntervalMs ?? 5000;
    this.events = events ?? {};
  }

  /**
   * Register an executor for a task type.
   */
  registerExecutor(type: string, executor: TaskExecutor): void {
    this.executors.set(type, executor);
  }

  /**
   * Create a new task.
   */
  create(input: TaskCreateInput): TaskRecord {
    const now = Date.now();
    const task: TaskRecord = {
      id: randomUUID(),
      sessionId: input.sessionId,
      goalId: input.goalId,
      status: "pending",
      payload: {
        type: input.type,
        description: input.description,
        data: input.data,
      },
      retries: 0,
      maxRetries: input.maxRetries ?? 3,
      nextRunAt: now + (input.initialDelayMs ?? 0),
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  /**
   * Get a task by ID.
   */
  get(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * List tasks with optional filters.
   */
  list(options?: TaskListOptions): TaskRecord[] {
    let results = Array.from(this.tasks.values());
    if (options?.sessionId) results = results.filter((t) => t.sessionId === options.sessionId);
    if (options?.goalId) results = results.filter((t) => t.goalId === options.goalId);
    if (options?.status) results = results.filter((t) => t.status === options.status);
    if (options?.type) results = results.filter((t) => t.payload.type === options.type);
    results.sort((a, b) => a.nextRunAt - b.nextRunAt);
    if (options?.limit) results = results.slice(0, options.limit);
    return results;
  }

  /**
   * Cancel a task.
   */
  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.status === "completed" || task.status === "cancelled") return false;
    task.status = "cancelled";
    task.updatedAt = Date.now();
    this.events.onTaskCancelled?.(task);
    return true;
  }

  /**
   * Mark a task as blocked (waiting for external dependency).
   */
  block(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.status === "completed" || task.status === "cancelled") return false;
    task.status = "blocked";
    task.updatedAt = Date.now();
    return true;
  }

  /**
   * Unblock a task (set it back to pending).
   */
  unblock(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "blocked") return false;
    task.status = "pending";
    task.nextRunAt = Date.now();
    task.updatedAt = Date.now();
    return true;
  }

  /**
   * Get task progress for a goal.
   */
  getProgress(goalId: string): {
    total: number;
    completed: number;
    failed: number;
    pending: number;
    running: number;
    blocked: number;
  } {
    const tasks = this.list({ goalId });
    return {
      total: tasks.length,
      completed: tasks.filter((t) => t.status === "completed").length,
      failed: tasks.filter((t) => t.status === "failed").length,
      pending: tasks.filter((t) => t.status === "pending").length,
      running: tasks.filter((t) => t.status === "running").length,
      blocked: tasks.filter((t) => t.status === "blocked").length,
    };
  }

  /**
   * Start the task processing loop.
   */
  start(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.tick(), this.tickIntervalMs);
  }

  /**
   * Stop the task processing loop.
   */
  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
  }

  /**
   * Process one tick — run ready tasks.
   */
  private async tick(): Promise<void> {
    const now = Date.now();
    const ready = Array.from(this.tasks.values())
      .filter((t) => t.status === "pending" && t.nextRunAt <= now)
      .sort((a, b) => a.nextRunAt - b.nextRunAt)
      .slice(0, this.maxTasksPerTick);

    const results = await Promise.allSettled(
      ready.map((task) => this.executeTask(task)),
    );

    // Log failures
    for (const result of results) {
      if (result.status === "rejected") {
        console.error("[DurableTaskModel] tick error:", result.reason);
      }
    }
  }

  private async executeTask(task: TaskRecord): Promise<void> {
    const executor = this.executors.get(task.payload.type);
    if (!executor) {
      task.status = "failed";
      task.error = `No executor registered for type: ${task.payload.type}`;
      task.updatedAt = Date.now();
      this.events.onTaskFailed?.(task);
      return;
    }

    task.status = "running";
    task.updatedAt = Date.now();
    this.events.onTaskStarted?.(task);

    try {
      const result = await executor(task);
      task.status = "completed";
      task.result = result;
      task.completedAt = Date.now();
      task.updatedAt = Date.now();
      this.events.onTaskCompleted?.(task);
    } catch (error) {
      task.retries++;
      task.error = error instanceof Error ? error.message : String(error);

      if (task.retries >= task.maxRetries) {
        task.status = "failed";
        task.updatedAt = Date.now();
        this.events.onTaskFailed?.(task);
      } else {
        // Exponential backoff with jitter
        const backoff = Math.min(
          this.baseBackoffMs * Math.pow(2, task.retries),
          this.maxBackoffMs,
        );
        const jitter = backoff * 0.1 * Math.random();
        task.nextRunAt = Date.now() + backoff + jitter;
        task.status = "pending";
        task.updatedAt = Date.now();
      }
    }
  }

  /**
   * Load tasks from an external store (call on startup).
   */
  loadFromStore(records: TaskRecord[]): void {
    for (const record of records) {
      this.tasks.set(record.id, record);
    }
  }

  /**
   * Export all tasks for persistence.
   */
  exportToStore(): TaskRecord[] {
    return Array.from(this.tasks.values());
  }
}
