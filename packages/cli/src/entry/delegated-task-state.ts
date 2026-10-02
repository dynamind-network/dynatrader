import type { AgentTaskService } from '@dyna/core/cli';

export type DelegatedTaskStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface DelegatedTaskView {
  taskId: string;
  agent: string;
  task: string;
  status: DelegatedTaskStatus;
  createdAt: string;
  completedAt?: string;
  result?: unknown;
  error?: string;
}

/** Stdio keeps cancellation handles in memory; task identity and outcomes live in StateDb. */
export class StdioDelegatedTaskState {
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly tasks: AgentTaskService) {}

  start(input: { taskId: string; sessionId: string; agent: string; task: string; controller: AbortController }): DelegatedTaskView {
    this.controllers.set(input.taskId, input.controller);
    return this.write({
      taskId: input.taskId, sessionId: input.sessionId, agent: input.agent, task: input.task,
      status: 'running', createdAt: new Date().toISOString(),
    });
  }

  list(sessionId: string): DelegatedTaskView[] {
    return this.tasks.list({ scope: 'session', scopeId: sessionId, includeArchived: true, limit: 500 })
      .filter((task) => task.metadata['source'] === 'delegation')
      .map((task) => toView(task.id, task.title, task.description, task.metadata, task.createdAt, task.completedAt));
  }

  get(taskId: string, sessionId: string): DelegatedTaskView | null {
    const task = this.tasks.get(taskId);
    if (!task || task.scope !== 'session' || task.scopeId !== sessionId || task.metadata['source'] !== 'delegation') return null;
    return toView(task.id, task.title, task.description, task.metadata, task.createdAt, task.completedAt);
  }

  complete(taskId: string, sessionId: string, result: unknown): void {
    const current = this.get(taskId, sessionId);
    if (!current || current.status === 'cancelled') return;
    this.write({ ...current, sessionId, status: 'completed', result, completedAt: new Date().toISOString() });
    this.controllers.delete(taskId);
  }

  fail(taskId: string, sessionId: string, error: string): void {
    const current = this.get(taskId, sessionId);
    if (!current || current.status === 'cancelled') return;
    this.write({ ...current, sessionId, status: 'failed', error, completedAt: new Date().toISOString() });
    this.controllers.delete(taskId);
  }

  cancel(taskId: string, sessionId: string): boolean {
    const current = this.get(taskId, sessionId);
    if (!current || current.status !== 'running') return false;
    const controller = this.controllers.get(taskId);
    if (!controller) return false;
    this.write({ ...current, sessionId, status: 'cancelled', error: 'Cancelled by user.', completedAt: new Date().toISOString() });
    this.controllers.delete(taskId);
    controller.abort();
    return true;
  }

  private write(input: DelegatedTaskView & { sessionId: string }): DelegatedTaskView {
    const status = input.status === 'completed' ? 'done'
      : input.status === 'failed' ? 'blocked'
      : input.status === 'cancelled' ? 'archived' : 'running';
    this.tasks.syncExternalTask({
      id: input.taskId,
      sessionId: input.sessionId,
      title: input.task.slice(0, 120) || `Delegated task ${input.taskId}`,
      description: input.task,
      status,
      metadata: {
        source: 'delegation',
        agent: input.agent,
        task: input.task,
        delegatedStatus: input.status,
        createdAt: input.createdAt,
        ...(input.completedAt ? { completedAt: input.completedAt } : {}),
        ...(input.result !== undefined ? { result: input.result } : {}),
        ...(input.error ? { error: input.error } : {}),
      },
    });
    return input;
  }
}

function toView(
  id: string,
  title: string,
  description: string,
  metadata: Record<string, unknown>,
  createdAt: number,
  completedAt: number | null,
): DelegatedTaskView {
  const status = metadata['delegatedStatus'];
  return {
    taskId: id,
    agent: typeof metadata['agent'] === 'string' ? metadata['agent'] : 'coding-worker',
    task: typeof metadata['task'] === 'string' ? metadata['task'] : description || title,
    status: status === 'completed' || status === 'failed' || status === 'cancelled' ? status : 'running',
    createdAt: typeof metadata['createdAt'] === 'string' ? metadata['createdAt'] : new Date(createdAt).toISOString(),
    ...(typeof metadata['completedAt'] === 'string' ? { completedAt: metadata['completedAt'] }
      : completedAt ? { completedAt: new Date(completedAt).toISOString() } : {}),
    ...(metadata['result'] !== undefined ? { result: metadata['result'] } : {}),
    ...(typeof metadata['error'] === 'string' ? { error: metadata['error'] } : {}),
  };
}
