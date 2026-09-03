import type { StateDb } from 'dynatrader';

export type TaskType =
  | 'agent_execution'
  | 'spawned_agent_execution'
  | 'backtest'
  | 'data_collection'
  | 'analysis'
  | 'cron'
  | 'custom';
export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type TaskPriority = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export interface TaskPayload {
  userRequest?: string;
  agentName?: string;
  task?: string;
  parameters?: Record<string, unknown>;
  context?: Record<string, unknown>;
}

export interface Task {
  id: string;
  type: TaskType;
  priority: TaskPriority;
  status: TaskStatus;
  payload: TaskPayload;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  result?: unknown;
  retries: number;
  maxRetries: number;
  timeout: number;
  tags?: string[];
}

export interface TaskQueueStats {
  totalTasks: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  averageWaitTime: number;
  averageExecutionTime: number;
}

export class TaskQueue {
  private tasks = new Map<string, Task>();
  private queue: string[] = [];
  private executingTasks = new Set<string>();
  private maxQueueSize = 1000;
  private taskIdCounter = 0;
  private db: StateDb | null = null;

  constructor(options?: { maxQueueSize?: number; db?: StateDb }) {
    if (options?.maxQueueSize) {
      this.maxQueueSize = options.maxQueueSize;
    }
    if (options?.db) {
      this.db = options.db;
      this.loadFromDb();
    }
  }

  private loadFromDb(): void {
    if (!this.db) return;

    const persisted = this.db.loadTasks();
    for (const row of persisted) {
      const task: Task = {
        id: row.id,
        type: row.type as TaskType,
        priority: row.priority as TaskPriority,
        status: row.status as TaskStatus,
        payload: row.payload as TaskPayload,
        createdAt: row.created_at,
        startedAt: row.started_at ?? undefined,
        completedAt: row.completed_at ?? undefined,
        error: row.error ?? undefined,
        result: row.result,
        retries: row.retries,
        maxRetries: row.max_retries,
        timeout: row.timeout,
        tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags,
      };

      this.tasks.set(task.id, task);

      if (task.status === 'queued') {
        this.queue.push(task.id);
      } else if (task.status === 'running') {
        this.executingTasks.add(task.id);
      }

      const match = task.id.match(/task_(\d+)_(\d+)/);
      if (match) {
        const ts = parseInt(match[1], 10);
        const counter = parseInt(match[2], 10);
        if (ts > Date.now() - 86400000) {
          this.taskIdCounter = Math.max(this.taskIdCounter, counter);
        }
      }
    }

    this.sortQueue();
  }

  private saveTask(task: Task): void {
    if (!this.db) return;
    this.db.saveTask({
      id: task.id,
      type: task.type,
      priority: task.priority,
      status: task.status,
      payload: task.payload as Record<string, unknown>,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      error: task.error,
      result: task.result,
      retries: task.retries,
      maxRetries: task.maxRetries,
      timeout: task.timeout,
      tags: task.tags,
    });
  }

  enqueue(task: Omit<Task, 'id' | 'createdAt' | 'status' | 'retries'>): Task {
    if (this.tasks.size >= this.maxQueueSize) {
      throw new Error(`Task queue is full (max ${this.maxQueueSize})`);
    }

    const id = `task_${Date.now()}_${++this.taskIdCounter}`;

    const newTask: Task = {
      id,
      type: task.type,
      priority: task.priority,
      status: 'queued',
      payload: task.payload,
      createdAt: Date.now(),
      retries: 0,
      maxRetries: task.maxRetries || 3,
      timeout: task.timeout || 30 * 60 * 1000,
      tags: task.tags,
    };

    this.tasks.set(id, newTask);
    this.queue.push(id);
    this.sortQueue();
    this.saveTask(newTask);

    return newTask;
  }

  dequeue(): Task | null {
    while (this.queue.length > 0) {
      const taskId = this.queue.shift();
      if (!taskId) break;

      const task = this.tasks.get(taskId);
      if (!task) continue;

      if (this.executingTasks.has(taskId) || task.status !== 'queued') {
        continue;
      }

      task.status = 'running';
      task.startedAt = Date.now();
      this.executingTasks.add(taskId);
      this.saveTask(task);

      return task;
    }

    return null;
  }

  complete(taskId: string, result: unknown): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    task.status = 'completed';
    task.completedAt = Date.now();
    task.result = result;
    this.executingTasks.delete(taskId);
    this.saveTask(task);

    return task;
  }

  fail(taskId: string, error: string, retry: boolean = true): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    this.executingTasks.delete(taskId);

    if (retry && task.retries < task.maxRetries) {
      task.retries++;
      task.status = 'queued';
      this.queue.push(taskId);
      this.sortQueue();
      this.saveTask(task);
      return task;
    }

    task.status = 'failed';
    task.error = error;
    task.completedAt = Date.now();
    this.saveTask(task);

    return task;
  }

  cancel(taskId: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    task.status = 'cancelled';
    task.completedAt = Date.now();
    this.executingTasks.delete(taskId);
    this.saveTask(task);

    const index = this.queue.indexOf(taskId);
    if (index >= 0) {
      this.queue.splice(index, 1);
    }

    return task;
  }

  getTask(taskId: string): Task | null {
    return this.tasks.get(taskId) || null;
  }

  getTasks(filter?: {
    status?: TaskStatus;
    type?: TaskType;
    priority?: TaskPriority;
    tag?: string;
  }): Task[] {
    let tasks = Array.from(this.tasks.values());

    if (filter?.status) {
      tasks = tasks.filter((t) => t.status === filter.status);
    }

    if (filter?.type) {
      tasks = tasks.filter((t) => t.type === filter.type);
    }

    if (filter?.priority) {
      tasks = tasks.filter((t) => t.priority === filter.priority);
    }

    if (filter?.tag) {
      tasks = tasks.filter((t) => t.tags?.includes(filter.tag!));
    }

    return tasks;
  }

  getQueueLength(): number {
    return this.queue.filter((id) => {
      const task = this.tasks.get(id);
      return task?.status === 'queued';
    }).length;
  }

  getRunningCount(): number {
    return this.executingTasks.size;
  }

  private sortQueue(): void {
    this.queue.sort((a, b) => {
      const taskA = this.tasks.get(a);
      const taskB = this.tasks.get(b);

      if (!taskA || !taskB) return 0;

      if (taskA.priority !== taskB.priority) {
        return taskB.priority - taskA.priority;
      }

      return taskA.createdAt - taskB.createdAt;
    });
  }

  getStats(): TaskQueueStats {
    const tasks = Array.from(this.tasks.values());

    const queued = tasks.filter((t) => t.status === 'queued').length;
    const running = tasks.filter((t) => t.status === 'running').length;
    const completed = tasks.filter((t) => t.status === 'completed').length;
    const failed = tasks.filter((t) => t.status === 'failed').length;
    const cancelled = tasks.filter((t) => t.status === 'cancelled').length;

    const completedOrRunning = tasks.filter((t) => t.startedAt);
    const avgWait =
      completedOrRunning.length > 0
        ? completedOrRunning.reduce((sum, t) => sum + (t.startedAt! - t.createdAt), 0) /
          completedOrRunning.length
        : 0;

    const withExecution = tasks.filter((t) => t.startedAt && t.completedAt);
    const avgExecution =
      withExecution.length > 0
        ? withExecution.reduce((sum, t) => sum + (t.completedAt! - t.startedAt!), 0) /
          withExecution.length
        : 0;

    return {
      totalTasks: tasks.length,
      queued,
      running,
      completed,
      failed,
      cancelled,
      averageWaitTime: Math.round(avgWait),
      averageExecutionTime: Math.round(avgExecution),
    };
  }

  clearCompleted(): number {
    let cleared = 0;

    for (const [id, task] of this.tasks) {
      if (task.status === 'completed' || task.status === 'cancelled') {
        const age = Date.now() - (task.completedAt || task.createdAt);
        if (age > 60 * 60 * 1000) {
          this.tasks.delete(id);
          if (this.db) this.db.deleteTask(id);
          cleared++;
        }
      }
    }

    return cleared;
  }

  cleanupStale(): Task[] {
    const stale: Task[] = [];

    for (const [id, task] of this.tasks) {
      if (task.status === 'running') {
        const elapsed = Date.now() - (task.startedAt || task.createdAt);
        if (elapsed > task.timeout) {
          this.fail(id, `Task timeout after ${task.timeout}ms`, false);
          stale.push(task);
        }
      }
    }

    return stale;
  }

  recoverInterruptedTasks(): Task[] {
    if (!this.db) return [];
    const count = this.db.recoverInterruptedTasks();
    if (count === 0) return [];

    const recovered: Task[] = [];
    for (const [id, task] of this.tasks) {
      if (task.status === 'running' && !this.executingTasks.has(id)) {
        task.status = 'failed';
        task.error = 'Interrupted before recovery';
        task.completedAt = Date.now();
        this.saveTask(task);
        recovered.push(task);
      }
    }

    return recovered;
  }

  selectFairly(weights?: Record<TaskPriority, number>): Task | null {
    const defaultWeights: Record<TaskPriority, number> = {
      10: 10,
      9: 9,
      8: 8,
      7: 7,
      6: 6,
      5: 5,
      4: 4,
      3: 3,
      2: 2,
      1: 1,
    };

    const weightMap = weights || defaultWeights;

    const byPriority = new Map<TaskPriority, Task[]>();
    for (const id of this.queue) {
      const task = this.tasks.get(id);
      if (task && task.status === 'queued') {
        if (!byPriority.has(task.priority)) {
          byPriority.set(task.priority, []);
        }
        byPriority.get(task.priority)!.push(task);
      }
    }

    if (byPriority.size === 0) {
      return null;
    }

    const candidates: { task: Task; weight: number }[] = [];
    for (const [priority, tasks] of byPriority) {
      const weight = weightMap[priority] || 1;
      for (const task of tasks) {
        candidates.push({ task, weight });
      }
    }

    const totalWeight = candidates.reduce((sum, c) => sum + c.weight, 0);
    let random = Math.random() * totalWeight;

    for (const { task, weight } of candidates) {
      random -= weight;
      if (random <= 0) {
        task.status = 'running';
        task.startedAt = Date.now();
        this.executingTasks.add(task.id);
        this.saveTask(task);

        const index = this.queue.indexOf(task.id);
        if (index >= 0) {
          this.queue.splice(index, 1);
        }

        return task;
      }
    }

    return candidates[0]?.task || null;
  }

  export(): Task[] {
    return Array.from(this.tasks.values());
  }

  clear(): void {
    this.tasks.clear();
    this.queue = [];
    this.executingTasks.clear();
  }
}

export default TaskQueue;
