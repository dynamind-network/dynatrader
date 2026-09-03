/**
 * Webhook Server - Express-based HTTP API for async task execution
 * Provides endpoints for triggering tasks, checking status, and managing execution
 */

import express, { Express, Request, Response, NextFunction } from 'express';
import type { TaskQueue } from './task-queue.js';
import type { WorkerPool } from './worker-pool.js';
import type { Task, TaskPayload, TaskType, TaskPriority } from './task-queue.js';

export interface WebhookServerConfig {
  port?: number;
  host?: string;
  apiKey?: string; // Optional authentication key
  corsOrigins?: string[];
  maxRequestSize?: string;
}

export interface TaskRequest {
  type: TaskType;
  priority?: TaskPriority;
  payload: TaskPayload;
  timeout?: number;
  maxRetries?: number;
  tags?: string[];
  webhookUrl?: string; // URL to call when task completes
}

export interface TaskResponse {
  id: string;
  status: string;
  result?: unknown;
  error?: string;
}

/**
 * Webhook Server Implementation
 */
export class WebhookServer {
  private app: Express;
  private config: Required<WebhookServerConfig>;
  private taskQueue: TaskQueue;
  private workerPool: WorkerPool;
  private server?: any;
  private webhookCallbacks: Map<string, string> = new Map(); // taskId -> webhookUrl
  private apiKeys: Set<string>;

  constructor(
    taskQueue: TaskQueue,
    workerPool: WorkerPool,
    config?: WebhookServerConfig
  ) {
    this.app = express();
    this.taskQueue = taskQueue;
    this.workerPool = workerPool;

    this.config = {
      port: config?.port || 3000,
      host: config?.host || 'localhost',
      apiKey: config?.apiKey || '',
      corsOrigins: config?.corsOrigins || [],
      maxRequestSize: config?.maxRequestSize || '10mb'
    };

    this.apiKeys = new Set();
    if (this.config.apiKey) {
      this.apiKeys.add(this.config.apiKey);
    } else {
      console.warn('[WebhookServer] WARNING: No API key configured. Server is running unauthenticated.');
    }

    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Setup Express middleware
   */
  private setupMiddleware(): void {
    // Body parser
    this.app.use(express.json({ limit: this.config.maxRequestSize }));
    this.app.use(express.urlencoded({ limit: this.config.maxRequestSize, extended: true }));

    // CORS
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      const origin = req.headers.origin as string;
      if (this.config.corsOrigins.includes('*') || this.config.corsOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin || '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      }
      next();
    });

    // Request ID tracking
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      (req as any).id = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      res.setHeader('X-Request-ID', (req as any).id);
      next();
    });

    // API key authentication (if configured)
    if (this.config.apiKey) {
      this.app.use((req: Request, res: Response, next: NextFunction) => {
        // Public endpoints don't need auth
        if (['/health', '/metrics'].includes(req.path)) {
          return next();
        }

        const authHeader = req.headers.authorization;
        const token = authHeader?.replace('Bearer ', '') || req.query.apiKey;

        if (!token || !this.apiKeys.has(token as string)) {
          return res.status(401).json({
            error: 'Unauthorized',
            message: 'Missing or invalid API key'
          });
        }

        next();
      });
    }

    // Error handling
    this.app.use((err: any, req: Request, res: Response, next: NextFunction) => {
      console.error(`[Error] ${(req as any).id}:`, err);
      res.status(err.status || 500).json({
        error: err.message || 'Internal server error',
        requestId: (req as any).id
      });
    });
  }

  /**
   * Setup API routes
   */
  private setupRoutes(): void {
    // Health check
    this.app.get('/health', (req: Request, res: Response) => {
      const poolStats = this.workerPool.getPoolStats();
      res.json({
        status: 'healthy',
        pool: {
          workers: poolStats.workers.length,
          active: poolStats.workers.filter((w) => w.status === 'running').length,
          tasks: poolStats.completedTasks + poolStats.failedTasks
        },
        uptime: poolStats.uptime
      });
    });

    // Queue metrics
    this.app.get('/metrics', (req: Request, res: Response) => {
      const poolStats = this.workerPool.getPoolStats();
      const queueStats = this.taskQueue.getStats();

      res.json({
        pool: poolStats,
        queue: queueStats,
        timestamp: Date.now()
      });
    });

    // Submit task
    this.app.post('/tasks/execute', (req: Request, res: Response) => {
      try {
        const { type, priority = 5, payload, timeout, maxRetries = 3, tags, webhookUrl } =
          req.body as TaskRequest;

        if (!type || !payload) {
          return res.status(400).json({
            error: 'Missing required fields: type, payload'
          });
        }

        // Enqueue task
        const task = this.taskQueue.enqueue({
          type,
          priority,
          payload,
          timeout: timeout || 30 * 60 * 1000,
          maxRetries,
          tags
        });

        // Store webhook if provided
        if (webhookUrl) {
          // Validate webhook URL - block private IPs (SSRF protection)
          const webhookUrlObj = new URL(webhookUrl);
          const hostname = webhookUrlObj.hostname;
          const privatePatterns = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.|::1|fc|fd)/;
          if (privatePatterns.test(hostname)) {
            return res.status(400).json({ error: 'Webhook URL cannot point to private/internal addresses' });
          }
          this.webhookCallbacks.set(task.id, webhookUrl);
        }

        res.status(202).json({
          id: task.id,
          status: 'queued',
          message: 'Task submitted successfully',
          links: {
            status: `/tasks/${task.id}`,
            cancel: `/tasks/${task.id}/cancel`
          }
        });
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : 'Failed to enqueue task'
        });
      }
    });

    // Get task status
    this.app.get('/tasks/:id', (req: Request, res: Response) => {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const task = this.taskQueue.getTask(id);

      if (!task) {
        return res.status(404).json({
          error: 'Task not found',
          id
        });
      }

      res.json(this.formatTaskResponse(task));
    });

    // Cancel task
    this.app.delete('/tasks/:id', (req: Request, res: Response) => {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const task = this.taskQueue.getTask(id);

      if (!task) {
        return res.status(404).json({
          error: 'Task not found',
          id
        });
      }

      const cancelled = this.taskQueue.cancel(id);
      res.json(this.formatTaskResponse(cancelled));
    });

    // List tasks
    this.app.get('/tasks', (req: Request, res: Response) => {
      const { status, type, priority, tag } = req.query;

      const priorityNum = priority ? parseInt(priority as string) : undefined;
      const tasks = this.taskQueue.getTasks({
        status: status as any,
        type: type as any,
        priority: (priorityNum !== undefined && priorityNum >= 1 && priorityNum <= 10 ? priorityNum : undefined) as any,
        tag: tag as string
      });

      res.json({
        count: tasks.length,
        tasks: tasks.map((t) => this.formatTaskResponse(t))
      });
    });

    // Get queue stats
    this.app.get('/queue', (req: Request, res: Response) => {
      const stats = this.taskQueue.getStats();
      res.json(stats);
    });

    // Get pool stats
    this.app.get('/pool', (req: Request, res: Response) => {
      const stats = this.workerPool.getPoolStats();
      res.json(stats);
    });

    // Scale workers
    this.app.post('/pool/scale', (req: Request, res: Response) => {
      try {
        const { count } = req.body;

        if (!count || count < 1 || count > 16) {
          return res.status(400).json({
            error: 'Invalid worker count. Must be between 1 and 16'
          });
        }

        this.workerPool.scale(count);
        const stats = this.workerPool.getPoolStats();

        res.json({
          message: `Scaled to ${count} workers`,
          pool: stats
        });
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : 'Failed to scale workers'
        });
      }
    });

    // Clear completed tasks
    this.app.post('/tasks/cleanup', (req: Request, res: Response) => {
      const cleared = this.taskQueue.clearCompleted();
      res.json({
        message: `Cleared ${cleared} completed tasks`,
        cleaned: cleared
      });
    });

    // Cleanup stale tasks
    this.app.post('/tasks/cleanup-stale', (req: Request, res: Response) => {
      const stale = this.taskQueue.cleanupStale();
      res.json({
        message: `Cleaned up ${stale.length} stale tasks`,
        stale: stale.map((t) => this.formatTaskResponse(t))
      });
    });

    // Reset server state (for testing only - should require special auth)
    this.app.post('/reset', (req: Request, res: Response) => {
      const auth = req.headers['x-admin-key'];
      if (auth !== (process.env['ADMIN_RESET_KEY'] || 'admin-reset-key')) {
        return res.status(403).json({ error: 'Unauthorized' });
      }

      this.taskQueue.clear();
      res.json({ message: 'Server reset' });
    });
  }

  /**
   * Format task response
   */
  private formatTaskResponse(task: Task): TaskResponse {
    return {
      id: task.id,
      status: task.status,
      result: task.result,
      error: task.error
    };
  }

  /**
   * Emit task completion webhook
   */
  async emitWebhook(taskId: string, task: Task): Promise<void> {
    const webhookUrl = this.webhookCallbacks.get(taskId);
    if (!webhookUrl) return;

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Task-ID': taskId
        },
        body: JSON.stringify({
          id: task.id,
          status: task.status,
          result: task.result,
          error: task.error,
          completedAt: task.completedAt
        })
      });

      if (!response.ok) {
        console.error(`Webhook failed: ${webhookUrl} - ${response.status}`);
      }

      // Remove after successful delivery
      if (response.ok) {
        this.webhookCallbacks.delete(taskId);
      }
    } catch (error) {
      console.error(`Webhook error for ${webhookUrl}:`, error);
    }
  }

  /**
   * Start the server
   */
  async start(): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(this.config.port, this.config.host, () => {
          const url = `http://${this.config.host}:${this.config.port}`;
          console.log(`Webhook server listening on ${url}`);
          resolve(url);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.server) {
        this.server.close((err: any) => {
          if (err) reject(err);
          else resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Get server URL
   */
  getUrl(): string {
    return `http://${this.config.host}:${this.config.port}`;
  }

  /**
   * Add API key for authentication
   */
  addApiKey(key: string): void {
    this.apiKeys.add(key);
  }

  /**
   * Remove API key
   */
  removeApiKey(key: string): void {
    this.apiKeys.delete(key);
  }
}

export default WebhookServer;
