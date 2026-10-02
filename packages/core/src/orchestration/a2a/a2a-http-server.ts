/**
 * A2A HTTP Server
 *
 * Implements the Google A2A protocol over HTTP:
 * - Serves Agent Card at /.well-known/agent-card.json
 * - Handles incoming JSON-RPC 2.0 requests
 * - Task lifecycle management
 * - Authentication support
 *
 * A2A HTTP server implementation.
 */

import http from 'http';
import { randomUUID } from 'crypto';
import type {
  AgentCard,
  Task,
  TaskState,
  A2AMessage,
  A2ARequest,
  A2AResponse,
} from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface A2AServerConfig {
  /** Port to listen on. Default: 9100. */
  port: number;
  /** Host to bind to. Default: '0.0.0.0'. */
  host?: string;
  /** Authentication token (bearer). Optional. */
  authToken?: string;
  /** Agent card metadata. */
  agentCard: Omit<AgentCard, 'url'>;
  /** Handler for incoming task requests. */
  taskHandler: A2ATaskHandler;
  /** Maximum concurrent tasks. Default: 10. */
  maxConcurrentTasks?: number;
  /** Task timeout in ms. Default: 300000 (5 min). */
  taskTimeoutMs?: number;
}

export type A2AServerConfigResolved = Required<Omit<A2AServerConfig, 'authToken'>> & { authToken?: string };

export type A2ATaskHandler = (
  message: A2AMessage,
  taskId: string,
  sessionId: string,
) => Promise<A2AMessage>;

export interface A2AServerStatus {
  running: boolean;
  port: number;
  activeTasks: number;
  completedTasks: number;
  failedTasks: number;
}

// ---------------------------------------------------------------------------
// A2AServer
// ---------------------------------------------------------------------------

export class A2AServer {
  private server: http.Server | null = null;
  private config: A2AServerConfigResolved;
  private tasks: Map<string, Task> = new Map();
  private activeTasks = 0;
  private completedTasks = 0;
  private failedTasks = 0;

  constructor(config: A2AServerConfig) {
    this.config = {
      port: config.port,
      host: config.host ?? '0.0.0.0',
      authToken: config.authToken,
      agentCard: config.agentCard,
      taskHandler: config.taskHandler,
      maxConcurrentTasks: config.maxConcurrentTasks ?? 10,
      taskTimeoutMs: config.taskTimeoutMs ?? 300000,
    };
  }

  /**
   * Start the A2A HTTP server.
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch(err => {
          console.error('Request handling error:', err);
          this.sendError(res, -32603, 'Internal server error');
        });
      });

      this.server.on('error', reject);

      this.server.listen(this.config.port, this.config.host, () => {
        console.log(`A2A server listening on ${this.config.host}:${this.config.port}`);
        resolve();
      });
    });
  }

  /**
   * Stop the A2A HTTP server.
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Get server status.
   */
  getStatus(): A2AServerStatus {
    return {
      running: this.server !== null,
      port: this.config.port,
      activeTasks: this.activeTasks,
      completedTasks: this.completedTasks,
      failedTasks: this.failedTasks,
    };
  }

  /**
   * Get all tasks.
   */
  getTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Get a specific task.
   */
  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  // -----------------------------------------------------------------------
  // Request Handling
  // -----------------------------------------------------------------------

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Authentication check
    if (this.config.authToken) {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        this.sendError(res, -32001, 'Unauthorized');
        return;
      }
      const token = authHeader.slice(7);
      if (token !== this.config.authToken) {
        this.sendError(res, -32001, 'Invalid token');
        return;
      }
    }

    // Route requests
    if (req.url === '/.well-known/agent-card.json' && req.method === 'GET') {
      await this.handleAgentCard(res);
    } else if (req.url === '/' && req.method === 'POST') {
      await this.handleJsonRpc(req, res);
    } else {
      this.sendError(res, -32601, 'Method not found');
    }
  }

  private async handleAgentCard(res: http.ServerResponse): Promise<void> {
    const card: AgentCard = {
      ...this.config.agentCard,
      url: `http://${this.config.host}:${this.config.port}`,
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(card, null, 2));
  }

  private async handleJsonRpc(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await this.readBody(req);
    let request: A2ARequest;

    try {
      request = JSON.parse(body);
    } catch {
      this.sendError(res, -32700, 'Parse error');
      return;
    }

    // Validate JSON-RPC 2.0
    if (request.jsonrpc !== '2.0') {
      this.sendError(res, -32600, 'Invalid Request');
      return;
    }

    // Route by method
    switch (request.method) {
      case 'tasks/send':
        await this.handleTasksSend(request, res);
        break;
      case 'tasks/get':
        await this.handleTasksGet(request, res);
        break;
      case 'tasks/cancel':
        await this.handleTasksCancel(request, res);
        break;
      default:
        this.sendError(res, -32601, `Method not found: ${request.method}`);
    }
  }

  private async handleTasksSend(
    request: A2ARequest,
    res: http.ServerResponse,
  ): Promise<void> {
    const params = request.params as {
      message?: A2AMessage;
      sessionId?: string;
    };

    if (!params.message) {
      this.sendError(res, -32602, 'Invalid params: message required');
      return;
    }

    // Check concurrent task limit
    if (this.activeTasks >= this.config.maxConcurrentTasks) {
      this.sendError(res, -32000, 'Too many concurrent tasks');
      return;
    }

    const taskId = randomUUID();
    const sessionId = params.sessionId || randomUUID();

    // Create task
    const task: Task = {
      id: taskId,
      sessionId,
      status: {
        state: 'working',
        timestamp: new Date().toISOString(),
      },
      artifacts: [],
      history: [params.message],
      metadata: {},
    };

    this.tasks.set(taskId, task);
    this.activeTasks++;

    // Process task asynchronously
    this.processTask(taskId, params.message).catch(err => {
      console.error(`Task ${taskId} failed:`, err);
      this.updateTaskState(taskId, 'failed');
      this.activeTasks--;
      this.failedTasks++;
    });

    // Return immediate response
    const response: A2AResponse = {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        taskId,
        sessionId,
        status: task.status,
      },
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  }

  private async processTask(
    taskId: string,
    message: A2AMessage,
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;

    try {
      const reply = await this.config.taskHandler(
        message,
        taskId,
        task.sessionId,
      );

      // Update task with result
      task.history.push(reply);
      task.status = {
        state: 'completed',
        timestamp: new Date().toISOString(),
        message: reply,
      };

      this.activeTasks--;
      this.completedTasks++;
    } catch (err) {
      this.updateTaskState(taskId, 'failed');
      this.activeTasks--;
      this.failedTasks++;
    }
  }

  private async handleTasksGet(
    request: A2ARequest,
    res: http.ServerResponse,
  ): Promise<void> {
    const params = request.params as { taskId?: string };

    if (!params.taskId) {
      this.sendError(res, -32602, 'Invalid params: taskId required');
      return;
    }

    const task = this.tasks.get(params.taskId);
    if (!task) {
      this.sendError(res, -32602, 'Task not found');
      return;
    }

    const response: A2AResponse = {
      jsonrpc: '2.0',
      id: request.id,
      result: task,
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  }

  private async handleTasksCancel(
    request: A2ARequest,
    res: http.ServerResponse,
  ): Promise<void> {
    const params = request.params as { taskId?: string };

    if (!params.taskId) {
      this.sendError(res, -32602, 'Invalid params: taskId required');
      return;
    }

    const task = this.tasks.get(params.taskId);
    if (!task) {
      this.sendError(res, -32602, 'Task not found');
      return;
    }

    this.updateTaskState(params.taskId, 'canceled');

    const response: A2AResponse = {
      jsonrpc: '2.0',
      id: request.id,
      result: task,
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private updateTaskState(taskId: string, state: TaskState): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = {
        ...task.status,
        state,
        timestamp: new Date().toISOString(),
      };
    }
  }

  private sendError(res: http.ServerResponse, code: number, message: string): void {
    const response: A2AResponse = {
      jsonrpc: '2.0',
      id: null as unknown as string,
      error: { code, message },
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString()));
      req.on('error', reject);
    });
  }
}

// ---------------------------------------------------------------------------
// Factory: Create A2A Server from Agent Card
// ---------------------------------------------------------------------------

export function createA2AServer(
  agentCard: Omit<AgentCard, 'url'>,
  taskHandler: A2ATaskHandler,
  config?: Partial<A2AServerConfig>,
): A2AServer {
  return new A2AServer({
    port: config?.port ?? 9100,
    host: config?.host,
    authToken: config?.authToken,
    taskHandler,
    agentCard,
    maxConcurrentTasks: config?.maxConcurrentTasks,
    taskTimeoutMs: config?.taskTimeoutMs,
  });
}
