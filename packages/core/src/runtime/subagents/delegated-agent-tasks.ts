import { randomUUID } from 'node:crypto';
import type { ToolCall, ToolHandler, ToolResult, ToolExecutionContext } from '@dyna/contracts';

export type DelegatedTaskStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface DelegatedTaskSnapshot {
  task_id: string;
  agent: string;
  task: string;
  status: DelegatedTaskStatus;
  result?: unknown;
  error?: string;
  created_at: string;
  updated_at: string;
}

export interface DelegatedAgentTasksOptions {
  onChange?: (task: DelegatedTaskSnapshot, ownerSessionId?: string) => void | Promise<void>;
}

interface TaskRecord extends DelegatedTaskSnapshot {
  ownerSessionId?: string;
  controller: AbortController;
  promise?: Promise<unknown>;
  lifecycle?: Promise<void>;
}

export class DelegatedAgentTasks {
  private readonly tasks = new Map<string, TaskRecord>();

  constructor(options: DelegatedAgentTasksOptions = {}) {
    this.onChange = options.onChange;
  }

  private readonly onChange?: DelegatedAgentTasksOptions['onChange'];

  async run(
    request: { task: string; agent: string; executionMode: 'sync' | 'async'; sessionId?: string; signal?: AbortSignal },
    execute: (signal: AbortSignal) => Promise<unknown>,
  ): Promise<unknown> {
    if (request.executionMode === 'sync') return execute(request.signal ?? new AbortController().signal);

    const id = randomUUID();
    const now = new Date().toISOString();
    const controller = new AbortController();
    const record: TaskRecord = {
      task_id: id,
      agent: request.agent,
      task: request.task,
      status: 'running',
      created_at: now,
      updated_at: now,
      ownerSessionId: request.sessionId,
      controller,
    };
    this.tasks.set(id, record);
    this.publish(record);
    record.promise = execute(controller.signal).then((result) => {
      record.result = result;
      if (!controller.signal.aborted) record.status = 'completed';
      record.updated_at = new Date().toISOString();
      this.publish(record);
      return result;
    }).catch((error: unknown) => {
      record.error = error instanceof Error ? error.message : String(error);
      record.status = controller.signal.aborted ? 'cancelled' : 'failed';
      record.updated_at = new Date().toISOString();
      this.publish(record);
      throw error;
    }).finally(() => {
      record.updated_at = new Date().toISOString();
    });
    // Mark the rejection as observed while preserving it for status/result retrieval.
    void record.promise.catch(() => undefined);
    return { task_id: id, status: 'running', agent: request.agent };
  }

  list(ownerSessionId?: string): DelegatedTaskSnapshot[] {
    return [...this.tasks.values()]
      .filter((task) => !ownerSessionId || task.ownerSessionId === ownerSessionId)
      .map((task) => this.snapshot(task));
  }

  get(taskId: string, ownerSessionId?: string): DelegatedTaskSnapshot | undefined {
    const task = this.tasks.get(taskId);
    if (!task || (ownerSessionId && task.ownerSessionId !== ownerSessionId)) return undefined;
    return this.snapshot(task);
  }

  cancel(taskId: string, ownerSessionId?: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || (ownerSessionId && task.ownerSessionId !== ownerSessionId) || task.status !== 'running') return false;
    task.controller.abort(new Error('Delegated task cancelled by user'));
    task.status = 'cancelled';
    task.updated_at = new Date().toISOString();
    this.publish(task);
    return true;
  }

  private publish(task: TaskRecord): void {
    if (!this.onChange) return;
    const snapshot = this.snapshot(task);
    task.lifecycle = (task.lifecycle ?? Promise.resolve()).then(async () => {
      try {
        await this.onChange!(snapshot, task.ownerSessionId);
      } catch {
        // Persistence and observers must not interrupt the child task lifecycle.
      }
    });
  }

  private snapshot(task: TaskRecord): DelegatedTaskSnapshot {
    return {
      task_id: task.task_id,
      agent: task.agent,
      task: task.task,
      status: task.status,
      ...(task.result !== undefined ? { result: task.result } : {}),
      ...(task.error ? { error: task.error } : {}),
      created_at: task.created_at,
      updated_at: task.updated_at,
    };
  }
}

function result(data: unknown, started: number): ToolResult {
  return { success: true, data, durationMs: Date.now() - started, truncated: false };
}

function fail(error: string, started: number): ToolResult {
  return { success: false, error, durationMs: Date.now() - started, truncated: false };
}

function owner(context?: ToolExecutionContext): string | undefined {
  return context?.sessionId;
}

export function createDelegatedTaskControlTools(tasks: DelegatedAgentTasks): ToolHandler[] {
  const definitions = [
    {
      name: 'agent_task_list',
      description: 'List delegated child-agent tasks for this session, including completed results.',
      inputSchema: {},
      execute: async (_call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult> => result(tasks.list(owner(context)), Date.now()),
    },
    {
      name: 'agent_task_status',
      description: 'Get the status, result, or error for a delegated child-agent task.',
      inputSchema: { task_id: 'string' },
      execute: async (call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult> => {
        const started = Date.now();
        const task = tasks.get(String(call.args.task_id ?? ''), owner(context));
        return task ? result(task, started) : fail('Task not found for this session.', started);
      },
    },
    {
      name: 'agent_task_cancel',
      description: 'Cancel a running delegated child-agent task.',
      inputSchema: { task_id: 'string' },
      execute: async (call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult> => {
        const started = Date.now();
        const cancelled = tasks.cancel(String(call.args.task_id ?? ''), owner(context));
        return cancelled ? result({ cancelled: true }, started) : fail('Task not found for this session or is no longer running.', started);
      },
    },
  ];

  return definitions.map((definition) => ({
    definition: {
      name: definition.name,
      description: definition.description,
      category: 'session',
      inputSchema: definition.inputSchema,
      outputSchema: { result: 'object' },
      permissionsRequired: ['session.read'],
      sideEffects: definition.name === 'agent_task_cancel' ? ['cancels_agent'] : [],
      riskLevel: definition.name === 'agent_task_cancel' ? 'medium' : 'low',
      timeoutMs: 5_000,
      readOnly: definition.name !== 'agent_task_cancel',
    },
    execute: definition.execute,
  } as ToolHandler));
}
