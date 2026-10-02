import type { KanbanBoard } from '../orchestration/workspace/kanban-board';
import type { BlockKind, Task, TaskComment, TaskEvent, TaskLink, TaskPriority, TaskStatus } from '../orchestration/workspace/kanban-board';
import type { AgentTaskService } from './agent-task-service';

/**
 * One-way, repeat-safe import bridge from the legacy KanbanBoard database.
 * The legacy board remains intact until all callers have migrated. Full task
 * details plus comments, activity, and relationships are retained in StateDb.
 */
export class KanbanTaskCompatibilityAdapter {
  constructor(private readonly tasks: AgentTaskService) {}

  createTask(spec: { workspaceId: string; title: string; description?: string; status?: TaskStatus; priority?: TaskPriority; tags?: string[]; assignedTo?: string }): Task {
    return asKanbanTask(this.tasks.create({ scope: 'project', scopeId: spec.workspaceId, title: spec.title,
      description: spec.description, status: spec.status ?? 'triage', priority: spec.priority,
      tags: spec.tags, assignedTo: spec.assignedTo ?? null }));
  }

  getTask(id: string): Task | null { const task = this.tasks.get(id); return task?.scope === 'project' ? asKanbanTask(task) : null; }

  listTasks(filters?: { workspaceId?: string; status?: TaskStatus; priority?: TaskPriority; tag?: string }): Task[] {
    if (!filters?.workspaceId) return [];
    return this.tasks.list({ scope: 'project', scopeId: filters.workspaceId, status: filters.status, includeArchived: true })
      .filter((task) => (!filters.priority || task.priority === filters.priority) && (!filters.tag || task.tags.includes(filters.tag)))
      .map(asKanbanTask);
  }

  updateTask(id: string, updates: Partial<Omit<Task, 'id' | 'createdAt'>>): Task {
    const task = this.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    return asKanbanTask(this.tasks.update(id, {
      title: updates.title, description: updates.description, status: updates.status,
      priority: updates.priority, tags: updates.tags, assignedTo: updates.assignedTo,
      claimLock: updates.claimLock, claimExpires: updates.claimExpires, blockKind: updates.blockKind,
      blockRecurrenceCount: updates.blockRecurrenceCount, heartbeatAt: updates.heartbeatAt,
    }));
  }

  deleteTask(id: string): void { this.assertProjectTask(id); if (!this.tasks.delete(id)) throw new Error(`Task not found: ${id}`); }

  transitionTask(id: string, status: TaskStatus, actor = 'agent'): Task { this.assertProjectTask(id); return asKanbanTask(this.tasks.transition(id, status, actor)); }

  claimTask(id: string, assignee: string): { success: boolean; lockToken?: string; error?: string } {
    if (!this.getTask(id)) return { success: false, error: `Task not found: ${id}` };
    return this.tasks.claimTask(id, assignee);
  }

  heartbeat(id: string): void { this.assertProjectTask(id); this.tasks.heartbeat(id); }

  heartbeatClaim(id: string, lockToken: string): boolean { this.assertProjectTask(id); return this.tasks.heartbeatClaim(id, lockToken); }

  blockTask(id: string, reason: string, actor = 'system', kind: BlockKind = 'transient'): Task | null {
    const task = this.getTask(id);
    return task ? asKanbanTask(this.tasks.blockTask(id, reason, actor, kind)) : null;
  }

  unblockTask(id: string, actor = 'agent'): Task { this.assertProjectTask(id); return asKanbanTask(this.tasks.unblockTask(id, actor)); }

  linkTasks(sourceId: string, targetId: string, label = ''): void { this.assertProjectTask(sourceId); this.assertProjectTask(targetId); this.tasks.linkTasks(sourceId, targetId, label); }
  unlinkTasks(sourceId: string, targetId: string): void { this.assertProjectTask(sourceId); this.assertProjectTask(targetId); this.tasks.unlinkTasks(sourceId, targetId); }
  addDependency(taskId: string, dependencyTaskId: string, label = ''): void { this.assertProjectTask(taskId); this.assertProjectTask(dependencyTaskId); this.tasks.addDependency(taskId, dependencyTaskId, label); }
  getTaskLinks(taskId: string): Task[] { return this.tasks.getTaskLinks(taskId).filter((task) => task.scope === 'project').map(asKanbanTask); }
  getTaskLinkDetails(taskId: string): TaskLink[] { return this.tasks.getTaskLinkDetails(taskId); }
  addComment(taskId: string, body: string, author = 'agent'): TaskComment {
    this.assertProjectTask(taskId);
    this.tasks.addComment(taskId, body, author);
    return this.tasks.listComments(taskId).at(-1)!;
  }
  listComments(taskId: string): TaskComment[] { this.assertProjectTask(taskId); return this.tasks.listComments(taskId); }
  getTaskEvents(taskId: string): TaskEvent[] { this.assertProjectTask(taskId); return this.tasks.rawEvents(taskId); }
  checkStaleTasks(workspaceId?: string): string[] { return this.tasks.checkStaleTasks('project', workspaceId); }
  dispatchTask(workspaceId: string, assignee: string): Task | null {
    const task = this.tasks.dispatchTask('project', workspaceId, assignee);
    return task ? asKanbanTask(task) : null;
  }
  close(): void { /* StateDb lifecycle is owned by the runtime, not this facade. */ }

  private assertProjectTask(id: string): Task {
    const task = this.getTask(id);
    if (!task) throw new Error(`Project task not found: ${id}`);
    return task;
  }

  importBoard(board: KanbanBoard, workspaceId: string): { imported: number; skipped: number } {
    return this.importTasks(board, board.listTasks({ workspaceId }), workspaceId);
  }

  /** Import every task in this workspace-owned legacy DB into one project scope. */
  importAllBoard(board: KanbanBoard, workspaceId: string): { imported: number; skipped: number } {
    return this.importTasks(board, board.listTasks(), workspaceId);
  }

  private importTasks(board: KanbanBoard, legacyTasks: Task[], workspaceId: string): { imported: number; skipped: number } {
    const legacyIds = new Set(legacyTasks.map((task) => task.id));
    let imported = 0;
    let skipped = 0;

    for (const task of legacyTasks) {
      if (this.tasks.get(task.id)) { skipped++; continue; }
      this.tasks.create({
        id: task.id,
        scope: 'project',
        scopeId: workspaceId,
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        tags: task.tags,
        assignedTo: task.assignedTo,
        claimLock: task.claimLock,
        claimExpires: task.claimExpires,
        blockKind: task.blockKind,
        blockRecurrenceCount: task.blockRecurrenceCount,
        heartbeatAt: task.heartbeatAt,
        // Preserve fields not part of the common task contract too.
        metadata: { legacyKanban: task },
      });
      for (const comment of board.listComments(task.id)) {
        this.tasks.addImportedComment(task.id, { body: comment.body, author: comment.author, createdAt: comment.created_at });
      }
      for (const event of board.getTaskEvents(task.id)) {
        this.tasks.addImportedEvent(task.id, {
          eventType: event.event_type,
          oldValue: event.old_value,
          newValue: event.new_value,
          actor: event.actor,
          createdAt: event.created_at,
        });
      }
      imported++;
    }
    for (const task of legacyTasks) {
      if (!this.tasks.get(task.id)) continue;
      for (const link of board.getTaskLinkDetails(task.id)) {
        if (legacyIds.has(link.target_id) && this.tasks.get(link.target_id) && !this.tasks.hasLink(task.id, link.target_id)) {
          this.tasks.addLink(task.id, link.target_id, link.label);
        }
      }
    }
    return { imported, skipped };
  }
}

function asKanbanTask(task: import('./agent-task-service').AgentTask): Task {
  return {
    id: task.id, workspaceId: task.scopeId, title: task.title, description: task.description,
    status: task.status as TaskStatus, priority: task.priority, tags: task.tags,
    assignedTo: task.assignedTo, claimLock: task.claimLock, claimExpires: task.claimExpires,
    blockKind: task.blockKind, blockRecurrenceCount: task.blockRecurrenceCount,
    createdAt: task.createdAt, updatedAt: task.updatedAt, resolvedAt: task.completedAt, heartbeatAt: task.heartbeatAt,
  };
}
