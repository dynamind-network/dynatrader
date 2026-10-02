import { EventEmitter } from 'events';
import type { Task, TaskStatus, TaskType, TaskPriority, TaskQueueStats } from './task-queue.js';
import type { AsyncAgentConfig, TaskOptions } from './async-config.js';
import type { PoolStats } from './worker-pool.js';
import { TaskQueue } from './task-queue.js';
import { WorkerPool } from './worker-pool.js';
import { AgentTaskExecutor } from './agent-task-executor.js';
import { TaskExecutor, type SpawnedAgentEvent } from './subagent-task-executor.js';
import { WebhookServer } from './webhook-server.js';

export interface AsyncServiceStats {
  queue: TaskQueueStats;
  pool: PoolStats;
  webhookServer?: {
    url: string;
    status: 'running' | 'stopped';
  };
}

export class AsyncAgentService extends EventEmitter {
  private taskQueue: TaskQueue;
  private workerPool: WorkerPool;
  private executor: AgentTaskExecutor;
  private spawnedAgentExecutor?: TaskExecutor;
  private webhookServer?: WebhookServer;
  private isRunning = false;

  constructor(config: AsyncAgentConfig) {
    super();

    this.taskQueue = new TaskQueue({ maxQueueSize: 1000 });
    this.executor = new AgentTaskExecutor(
      config.apiKeys,
      config.defaultAgentConfig,
      config.toolRegistry
    );

    if (config.subagentRegistry) {
      this.spawnedAgentExecutor = new TaskExecutor({
        apiKeys: config.apiKeys,
        model: config.defaultAgentConfig.model,
        subagentRegistry: config.subagentRegistry,
        toolRegistry: config.toolRegistry,
        resultsDir: config.agentResultsDir,
        onEvent: (event: SpawnedAgentEvent) => {
          this.emit('spawned_agent_event', event);
          this.emit(`spawned_agent_${event.type}`, event);
        },
      });
    }

    const routingExecutor = async (task: Task): Promise<unknown> => {
      if (task.type === 'spawned_agent_execution' && this.spawnedAgentExecutor) {
        return this.spawnedAgentExecutor.execute(task);
      }
      return this.executor.execute(task);
    };

    this.workerPool = new WorkerPool(this.taskQueue, routingExecutor, {
      workerCount: config.workerCount || 4,
    });

    if (config.enableWebhookServer) {
      this.webhookServer = new WebhookServer(this.taskQueue, this.workerPool, config.webhookConfig);
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) return;

    try {
      await this.workerPool.start();
      if (this.webhookServer) {
        await this.webhookServer.start();
      }
      this.isRunning = true;
      console.log('AsyncAgentService started');
    } catch (error) {
      this.isRunning = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    try {
      if (this.webhookServer) {
        await this.webhookServer.stop();
      }
      await this.workerPool.stop();
      this.isRunning = false;
      console.log('AsyncAgentService stopped');
    } catch (error) {
      console.error('Error stopping AsyncAgentService:', error);
      throw error;
    }
  }

  submitTask(userRequest: string, options?: TaskOptions): Task {
    return this.taskQueue.enqueue({
      type: 'agent_execution',
      priority: options?.priority || (5 as TaskPriority),
      payload: {
        userRequest,
        context: options?.context,
      },
      timeout: options?.timeout || 30 * 60 * 1000,
      maxRetries: options?.maxRetries || 2,
      tags: options?.tags,
    });
  }

  submitSpawnedAgentTask(presetName: string, taskDescription: string, options?: TaskOptions): Task {
    if (!this.spawnedAgentExecutor) {
      throw new Error('SubagentRegistry not configured - cannot submit spawned agent tasks');
    }

    return this.taskQueue.enqueue({
      type: 'spawned_agent_execution',
      priority: options?.priority || (5 as TaskPriority),
      payload: {
        agentName: presetName,
        task: taskDescription,
        context: options?.context,
      },
      timeout: options?.timeout || 30 * 60 * 1000,
      maxRetries: options?.maxRetries || 2,
      tags: [...(options?.tags || []), 'spawned-agent', presetName],
    });
  }

  async readAgentResult(taskId: string): Promise<{
    taskId: string;
    presetName: string;
    status: 'completed' | 'failed';
    result: string | null;
    error: string | null;
    completedAt: string;
  } | null> {
    if (!this.spawnedAgentExecutor) {
      return null;
    }
    return this.spawnedAgentExecutor.readResult(taskId);
  }

  getAgentResultsDir(): string | null {
    return this.spawnedAgentExecutor?.getResultsDir() || null;
  }

  getTaskStatus(taskId: string): Task | null {
    return this.taskQueue.getTask(taskId);
  }

  getTasks(filter?: {
    status?: TaskStatus;
    type?: TaskType;
    priority?: TaskPriority;
    tag?: string;
  }): Task[] {
    return this.taskQueue.getTasks(filter);
  }

  cancelTask(taskId: string): Task {
    return this.taskQueue.cancel(taskId);
  }

  getStats(): AsyncServiceStats {
    const stats: AsyncServiceStats = {
      queue: this.taskQueue.getStats(),
      pool: this.workerPool.getPoolStats(),
    };

    if (this.webhookServer) {
      stats.webhookServer = {
        url: this.webhookServer.getUrl(),
        status: this.isRunning ? 'running' : 'stopped',
      };
    }

    return stats;
  }
}

export default AsyncAgentService;

