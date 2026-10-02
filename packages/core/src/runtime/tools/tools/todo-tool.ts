import type { ToolCall, ToolResult, ToolHandler, ToolDefinition, ToolExecutionContext } from '@dyna/contracts';
import type { AgentTaskPriority, AgentTaskScope, AgentTaskStatus } from '../../../state-db/types';
import type { AgentTaskService } from '../../../state-db/agent-task-service';

export class TodoTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'todo',
    description: 'Read and manage the current session checklist or shared project tasks. Actions: list, add, update, delete.',
    category: 'analysis',
    inputSchema: {
      action: 'string', // list | add | update | delete
      scope: 'string?', // session | project; defaults to session
      scopeId: 'string?', // must match this runtime's project scope
      taskId: 'string?', title: 'string?', description: 'string?', status: 'string?',
      priority: 'string?', tags: 'string[]?', assignedTo: 'string?', includeArchived: 'boolean?',
    },
    outputSchema: { tasks: 'array?', task: 'object?', message: 'string?' },
    permissionsRequired: ['task.read'],
    sideEffects: ['task_persist'],
    riskLevel: 'low',
    timeoutMs: 5000,
  };

  constructor(private readonly service: AgentTaskService, private readonly projectScopeId?: string) {}

  async execute(call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult> {
    const start = Date.now();
    try {
      const action = String(call.args.action ?? 'list');
      const scope = (call.args.scope ?? 'session') as AgentTaskScope;
      const requestedProjectScope = typeof call.args.scopeId === 'string' ? call.args.scopeId : undefined;
      if (scope === 'project' && this.projectScopeId && requestedProjectScope && requestedProjectScope !== this.projectScopeId) {
        throw new Error('Project task scope must match the current workspace.');
      }
      const scopeId = scope === 'session' ? context?.sessionId : (this.projectScopeId ?? requestedProjectScope ?? '');
      if (!scopeId) throw new Error(scope === 'session' ? 'Session scope is unavailable: missing sessionId' : 'scopeId is required for project tasks');

      if (action === 'list') {
        const tasks = this.service.list({ scope, scopeId, includeArchived: call.args.includeArchived === true });
        return ok({ tasks }, start);
      }
      if (action === 'add') {
        const title = stringArg(call.args.title, 'title');
        const task = this.service.create({
          scope, scopeId, title,
          description: optionalString(call.args.description),
          status: optionalEnum<AgentTaskStatus>(call.args.status, ['triage','todo','scheduled','ready','running','blocked','review','done','archived','in_progress'], 'status'),
          priority: optionalEnum<AgentTaskPriority>(call.args.priority, ['low','medium','high','critical'], 'priority'),
          tags: Array.isArray(call.args.tags) ? call.args.tags.filter((tag): tag is string => typeof tag === 'string') : [],
          assignedTo: optionalString(call.args.assignedTo) ?? null,
        });
        return ok({ task }, start);
      }
      const taskId = stringArg(call.args.taskId, 'taskId');
      const existing = this.service.get(taskId);
      if (!existing || existing.scope !== scope || existing.scopeId !== scopeId) throw new Error(`Task not found in ${scope} scope: ${taskId}`);
      if (action === 'delete') {
        const deleted = this.service.delete(taskId);
        if (!deleted) throw new Error(`Task not found: ${taskId}`);
        return ok({ message: `Deleted task ${taskId}` }, start);
      }
      if (action === 'update') {
        const task = this.service.update(taskId, {
          title: optionalString(call.args.title),
          description: optionalString(call.args.description),
          status: optionalEnum<AgentTaskStatus>(call.args.status, ['triage','todo','scheduled','ready','running','blocked','review','done','archived','in_progress'], 'status'),
          priority: optionalEnum<AgentTaskPriority>(call.args.priority, ['low','medium','high','critical'], 'priority'),
          tags: Array.isArray(call.args.tags) ? call.args.tags.filter((tag): tag is string => typeof tag === 'string') : undefined,
          assignedTo: call.args.assignedTo === null ? null : optionalString(call.args.assignedTo),
        });
        return ok({ task }, start);
      }
      throw new Error('action must be one of: list, add, update, delete');
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - start, truncated: false };
    }
  }
}

function ok(data: Record<string, unknown>, start: number): ToolResult {
  return { success: true, data, durationMs: Date.now() - start, truncated: false };
}

function stringArg(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalEnum<T extends string>(value: unknown, values: readonly T[], name: string): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !values.includes(value as T)) throw new Error(`${name} must be one of: ${values.join(', ')}`);
  return value as T;
}
