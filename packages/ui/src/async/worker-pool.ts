/**
 * Worker Pool - Manages concurrent task execution
 * Executes tasks from queue with configurable worker count
 */

import { EventEmitter } from "events";
import type { Task, TaskQueue, TaskPayload } from "./task-queue.js";
import { getErrorMessage } from "../utils/index.js";

export type TaskExecutor = (task: Task) => Promise<unknown>;

export interface WorkerPoolConfig {
  workerCount?: number; // Number of concurrent workers (default: 4)
  maxTaskTime?: number; // Max execution time per task (default: 30 minutes)
  heartbeatInterval?: number; // Worker health check interval (default: 5 seconds)
}

export interface WorkerStats {
  id: number;
  tasksCompleted: number;
  tasksFailed: number;
  totalExecutionTime: number;
  averageTaskTime: number;
  currentTask?: string;
  status: "idle" | "running" | "stopped";
}

export interface PoolStats {
  workers: WorkerStats[];
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  averageTaskTime: number;
  uptime: number;
  status: "running" | "stopping" | "stopped";
}

interface Worker {
  id: number;
  status: "idle" | "running" | "stopped";
  currentTaskId?: string;
  currentTaskStarted?: number;
  tasksCompleted: number;
  tasksFailed: number;
  totalExecutionTime: number;
  lastHeartbeat: number;
}

/**
 * Worker Pool Implementation
 * Manages concurrent task execution with multiple workers
 */
export class WorkerPool extends EventEmitter {
  private workers: Map<number, Worker> = new Map();
  private taskQueue: TaskQueue;
  private executor: TaskExecutor;
  private config: Required<WorkerPoolConfig>;
  private status: "running" | "stopping" | "stopped" = "stopped";
  private startTime: number = 0;
  private heartbeatTimer?: NodeJS.Timeout;
  private totalTasksProcessed: number = 0;
  private totalExecutionTime: number = 0;

  constructor(
    taskQueue: TaskQueue,
    executor: TaskExecutor,
    config?: WorkerPoolConfig,
  ) {
    super();

    this.taskQueue = taskQueue;
    this.executor = executor;
    this.config = {
      workerCount: config?.workerCount || 4,
      maxTaskTime: config?.maxTaskTime || 30 * 60 * 1000, // 30 minutes
      heartbeatInterval: config?.heartbeatInterval || 5000, // 5 seconds
    };

    // Initialize workers
    for (let i = 0; i < this.config.workerCount; i++) {
      this.workers.set(i, {
        id: i,
        status: "idle",
        tasksCompleted: 0,
        tasksFailed: 0,
        totalExecutionTime: 0,
        lastHeartbeat: Date.now(),
      });
    }
  }

  /**
   * Start the worker pool
   */
  start(): void {
    if (this.status !== "stopped") {
      throw new Error(`Worker pool is already ${this.status}`);
    }

    this.status = "running";
    this.startTime = Date.now();
    this.emit("started");

    // Start workers
    for (const worker of this.workers.values()) {
      worker.status = "idle";
      this.startWorker(worker);
    }

    // Start heartbeat monitoring
    this.startHeartbeat();
  }

  /**
   * Stop the worker pool gracefully
   */
  async stop(): Promise<void> {
    if (this.status === "stopped") {
      return;
    }

    this.status = "stopping";
    this.emit("stopping");

    // Stop heartbeat
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    // Wait for all workers to finish current tasks
    const timeout = Date.now() + 60000; // 60 second timeout
    while (Date.now() < timeout) {
      const running = Array.from(this.workers.values()).filter(
        (w) => w.status === "running",
      );

      if (running.length === 0) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Mark all workers as stopped
    for (const worker of this.workers.values()) {
      worker.status = "stopped";
    }

    this.status = "stopped";
    this.emit("stopped");
  }

  /**
   * Start a single worker loop
   */
  private async startWorker(worker: Worker): Promise<void> {
    while (this.status === "running" && worker.status !== "stopped") {
      try {
        worker.status = "idle";

        // Try to get next task from queue
        const task = this.taskQueue.dequeue();

        if (!task) {
          // No tasks available, wait and retry
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }

        worker.status = "running";
        worker.currentTaskId = task.id;
        worker.currentTaskStarted = Date.now();

        this.emit("task_started", { workerId: worker.id, taskId: task.id });

        try {
          // Execute the task
          const result = await this.executeTask(task, worker);

          // Mark as completed
          this.taskQueue.complete(task.id, result);

          const executionTime = Date.now() - worker.currentTaskStarted;
          worker.tasksCompleted++;
          worker.totalExecutionTime += executionTime;
          this.totalTasksProcessed++;
          this.totalExecutionTime += executionTime;

          this.emit("task_completed", {
            workerId: worker.id,
            taskId: task.id,
            executionTime,
            result,
          });
        } catch (error) {
          const errorMessage = getErrorMessage(error);

          // Try to fail task with retry
          this.taskQueue.fail(task.id, errorMessage, true);
          worker.tasksFailed++;

          this.emit("task_failed", {
            workerId: worker.id,
            taskId: task.id,
            error: errorMessage,
          });
        }

        worker.currentTaskId = undefined;
      } catch (error) {
        this.emit("worker_error", {
          workerId: worker.id,
          error: getErrorMessage(error),
        });

        // Brief pause before retry
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  /**
   * Execute a single task with timeout
   */
  private async executeTask(task: Task, worker: Worker): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let completed = false;

      // Set timeout
      const timeout = setTimeout(() => {
        if (!completed) {
          completed = true;
          reject(new Error(`Task timeout after ${this.config.maxTaskTime}ms`));
        }
      }, this.config.maxTaskTime);

      // Execute task
      this.executor(task)
        .then((result) => {
          clearTimeout(timeout);
          if (!completed) {
            completed = true;
            resolve(result);
          }
        })
        .catch((error) => {
          clearTimeout(timeout);
          if (!completed) {
            completed = true;
            reject(error);
          }
        });
    });
  }

  /**
   * Start heartbeat monitoring
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();

      for (const worker of this.workers.values()) {
        // Check for stalled workers
        if (worker.status === "running" && worker.currentTaskStarted) {
          const elapsed = now - worker.currentTaskStarted;

          if (elapsed > this.config.maxTaskTime) {
            this.emit("worker_stalled", {
              workerId: worker.id,
              taskId: worker.currentTaskId,
              elapsedTime: elapsed,
            });

            // Restart worker
            worker.status = "idle";
            worker.currentTaskId = undefined;
          }
        }

        worker.lastHeartbeat = now;
      }
    }, this.config.heartbeatInterval);
  }

  /**
   * Get worker statistics
   */
  getWorkerStats(workerId: number): WorkerStats | null {
    const worker = this.workers.get(workerId);
    if (!worker) return null;

    return {
      id: worker.id,
      tasksCompleted: worker.tasksCompleted,
      tasksFailed: worker.tasksFailed,
      totalExecutionTime: worker.totalExecutionTime,
      averageTaskTime:
        worker.tasksCompleted > 0
          ? Math.round(worker.totalExecutionTime / worker.tasksCompleted)
          : 0,
      currentTask: worker.currentTaskId,
      status: worker.status,
    };
  }

  /**
   * Get all workers statistics
   */
  getAllWorkerStats(): WorkerStats[] {
    const stats: WorkerStats[] = [];

    for (const worker of this.workers.values()) {
      stats.push({
        id: worker.id,
        tasksCompleted: worker.tasksCompleted,
        tasksFailed: worker.tasksFailed,
        totalExecutionTime: worker.totalExecutionTime,
        averageTaskTime:
          worker.tasksCompleted > 0
            ? Math.round(worker.totalExecutionTime / worker.tasksCompleted)
            : 0,
        currentTask: worker.currentTaskId,
        status: worker.status,
      });
    }

    return stats;
  }

  /**
   * Get pool statistics
   */
  getPoolStats(): PoolStats {
    const workerStats = this.getAllWorkerStats();
    const totalCompleted = workerStats.reduce(
      (sum, w) => sum + w.tasksCompleted,
      0,
    );
    const totalFailed = workerStats.reduce((sum, w) => sum + w.tasksFailed, 0);

    return {
      workers: workerStats,
      totalTasks: totalCompleted + totalFailed,
      completedTasks: totalCompleted,
      failedTasks: totalFailed,
      averageTaskTime:
        this.totalTasksProcessed > 0
          ? Math.round(this.totalExecutionTime / this.totalTasksProcessed)
          : 0,
      uptime: Date.now() - this.startTime,
      status: this.status,
    };
  }

  /**
   * Get current status
   */
  getStatus(): string {
    const stats = this.getPoolStats();
    const running = Array.from(this.workers.values()).filter(
      (w) => w.status === "running",
    ).length;

    return (
      `Pool Status: ${this.status}\n` +
      `Workers: ${running}/${this.config.workerCount} running\n` +
      `Tasks: ${stats.completedTasks} completed, ${stats.failedTasks} failed\n` +
      `Avg Time: ${stats.averageTaskTime}ms`
    );
  }

  /**
   * Scale worker count (add/remove workers)
   */
  scale(newCount: number): void {
    if (newCount < 1 || newCount > 16) {
      throw new Error("Worker count must be between 1 and 16");
    }

    const currentCount = this.workers.size;

    if (newCount > currentCount) {
      // Add new workers
      for (let i = currentCount; i < newCount; i++) {
        const worker: Worker = {
          id: i,
          status: "idle",
          tasksCompleted: 0,
          tasksFailed: 0,
          totalExecutionTime: 0,
          lastHeartbeat: Date.now(),
        };
        this.workers.set(i, worker);

        if (this.status === "running") {
          this.startWorker(worker);
        }
      }
    } else if (newCount < currentCount) {
      // Remove workers (gracefully)
      for (let i = newCount; i < currentCount; i++) {
        const worker = this.workers.get(i);
        if (worker) {
          worker.status = "stopped";
        }
      }
    }

    this.config.workerCount = newCount;
  }

  /**
   * Get worker count
   */
  getWorkerCount(): number {
    return this.config.workerCount;
  }

  /**
   * Get active worker count
   */
  getActiveWorkerCount(): number {
    return Array.from(this.workers.values()).filter(
      (w) => w.status === "running",
    ).length;
  }
}

export default WorkerPool;

