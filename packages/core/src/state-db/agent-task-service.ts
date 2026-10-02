import { randomUUID } from 'node:crypto';
import type { StateDb } from './state-db';
import type { AgentTaskBlockKind, AgentTaskPriority, AgentTaskRow, AgentTaskScope, AgentTaskStatus } from './types';

export interface AgentTask {
  id: string;
  scope: AgentTaskScope;
  scopeId: string;
  title: string;
  description: string;
  status: AgentTaskStatus;
  priority: AgentTaskPriority;
  tags: string[];
  assignedTo: string | null;
  claimLock: string | null;
  claimExpires: number | null;
  blockKind: AgentTaskBlockKind | null;
  blockRecurrenceCount: number;
  heartbeatAt: number | null;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface AgentTaskListFilter {
  scope: AgentTaskScope;
  scopeId: string;
  status?: AgentTaskStatus;
  includeArchived?: boolean;
  limit?: number;
}

const VALID_STATUSES = new Set<AgentTaskStatus>(['triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done', 'archived', 'in_progress']);
const VALID_PRIORITIES = new Set<AgentTaskPriority>(['low', 'medium', 'high', 'critical']);

function parseRow(row: AgentTaskRow): AgentTask {
  return {
    id: row.id, scope: row.scope, scopeId: row.scope_id, title: row.title,
    description: row.description, status: row.status, priority: row.priority,
    tags: JSON.parse(row.tags) as string[], assignedTo: row.assigned_to,
    claimLock: row.claim_lock, claimExpires: row.claim_expires, blockKind: row.block_kind,
    blockRecurrenceCount: row.block_recurrence_count, heartbeatAt: row.heartbeat_at,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at,
  };
}

/** Canonical persisted todo/task state shared by agent tools and UI adapters. */
export class AgentTaskService {
  constructor(private readonly stateDb: StateDb) {}

  list(filter: AgentTaskListFilter): AgentTask[] {
    validateScope(filter.scope, filter.scopeId);
    const where = ['scope = ?', 'scope_id = ?'];
    const args: unknown[] = [filter.scope, filter.scopeId];
    if (filter.status) {
      if (!VALID_STATUSES.has(filter.status)) throw new Error(`Invalid task status: ${filter.status}`);
      where.push('status = ?'); args.push(filter.status);
    } else if (!filter.includeArchived) {
      where.push("status != 'archived'");
    }
    const limit = Math.max(1, Math.min(500, Math.floor(filter.limit ?? 100)));
    const rows = this.stateDb.raw.prepare(`SELECT * FROM agent_tasks WHERE ${where.join(' AND ')} ORDER BY CASE WHEN status IN ('done','archived') THEN 1 ELSE 0 END, updated_at DESC LIMIT ?`).all(...args, limit) as AgentTaskRow[];
    return rows.map(parseRow);
  }

  /** Cross-session inventory for trusted runtime services (not model-facing tools). */
  listAllSessionTasks(limit = 500): AgentTask[] {
    const safeLimit = Math.max(1, Math.min(2000, Math.floor(limit)));
    const rows = this.stateDb.raw.prepare("SELECT * FROM agent_tasks WHERE scope='session' ORDER BY updated_at DESC LIMIT ?")
      .all(safeLimit) as AgentTaskRow[];
    return rows.map(parseRow);
  }

  get(id: string): AgentTask | null {
    const row = this.stateDb.raw.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(id) as AgentTaskRow | undefined;
    return row ? parseRow(row) : null;
  }

  create(input: {
    scope: AgentTaskScope; scopeId: string; title: string; description?: string;
    status?: AgentTaskStatus; priority?: AgentTaskPriority; tags?: string[];
    assignedTo?: string | null; metadata?: Record<string, unknown>; id?: string;
    claimLock?: string | null; claimExpires?: number | null; blockKind?: AgentTaskBlockKind | null;
    blockRecurrenceCount?: number; heartbeatAt?: number | null;
  }): AgentTask {
    validateScope(input.scope, input.scopeId);
    const title = input.title.trim();
    if (!title) throw new Error('Task title must not be empty');
    const status = input.status ?? 'todo';
    const priority = input.priority ?? 'medium';
    if (!VALID_STATUSES.has(status)) throw new Error(`Invalid task status: ${status}`);
    if (!VALID_PRIORITIES.has(priority)) throw new Error(`Invalid task priority: ${priority}`);
    const now = Date.now();
    const id = input.id ?? randomUUID();
    this.stateDb.withRetry(() => {
      this.stateDb.raw.prepare(`INSERT INTO agent_tasks (id,scope,scope_id,title,description,status,priority,tags,assigned_to,claim_lock,claim_expires,block_kind,block_recurrence_count,heartbeat_at,metadata,created_at,updated_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, input.scope, input.scopeId, title, input.description ?? '', status, priority,
          JSON.stringify(input.tags ?? []), input.assignedTo ?? null, input.claimLock ?? null, input.claimExpires ?? null,
          input.blockKind ?? null, input.blockRecurrenceCount ?? 0, input.heartbeatAt ?? null, JSON.stringify(input.metadata ?? {}), now, now,
          status === 'done' ? now : null);
      this.recordEvent(id, 'created', null, status, 'agent');
    });
    return this.get(id)!;
  }

  update(id: string, updates: {
    title?: string; description?: string; status?: AgentTaskStatus; priority?: AgentTaskPriority;
    tags?: string[]; assignedTo?: string | null; metadata?: Record<string, unknown>;
    claimLock?: string | null; claimExpires?: number | null; blockKind?: AgentTaskBlockKind | null;
    blockRecurrenceCount?: number; heartbeatAt?: number | null;
  }, actor = 'agent'): AgentTask {
    const current = this.get(id);
    if (!current) throw new Error(`Task not found: ${id}`);
    if (updates.status && !VALID_STATUSES.has(updates.status)) throw new Error(`Invalid task status: ${updates.status}`);
    if (updates.priority && !VALID_PRIORITIES.has(updates.priority)) throw new Error(`Invalid task priority: ${updates.priority}`);
    if (updates.title !== undefined && !updates.title.trim()) throw new Error('Task title must not be empty');
    const nextStatus = updates.status ?? current.status;
    const now = Date.now();
    this.stateDb.withRetry(() => {
      this.stateDb.raw.prepare(`UPDATE agent_tasks SET title=?,description=?,status=?,priority=?,tags=?,assigned_to=?,claim_lock=?,claim_expires=?,block_kind=?,block_recurrence_count=?,heartbeat_at=?,metadata=?,updated_at=?,completed_at=? WHERE id=?`)
        .run(updates.title?.trim() ?? current.title, updates.description ?? current.description, nextStatus,
          updates.priority ?? current.priority, JSON.stringify(updates.tags ?? current.tags),
          updates.assignedTo === undefined ? current.assignedTo : updates.assignedTo,
          updates.claimLock === undefined ? current.claimLock : updates.claimLock,
          updates.claimExpires === undefined ? current.claimExpires : updates.claimExpires,
          updates.blockKind === undefined ? current.blockKind : updates.blockKind,
          updates.blockRecurrenceCount ?? current.blockRecurrenceCount,
          updates.heartbeatAt === undefined ? current.heartbeatAt : updates.heartbeatAt,
          JSON.stringify(updates.metadata ?? current.metadata), now,
          nextStatus === 'done' || nextStatus === 'archived' ? (current.completedAt ?? now) : current.completedAt, id);
      if (updates.status && updates.status !== current.status) this.recordEvent(id, 'status_change', current.status, updates.status, actor);
    });
    return this.get(id)!;
  }

  transition(id: string, status: AgentTaskStatus, actor = 'agent'): AgentTask {
    return this.update(id, { status }, actor);
  }

  claimTask(id: string, assignee: string, leaseMs = 300_000): { success: boolean; lockToken?: string; error?: string } {
    const task = this.get(id);
    if (!task) return { success: false, error: `Task not found: ${id}` };
    if (!assignee.trim()) return { success: false, error: 'Assignee must not be empty' };
    if (task.assignedTo && task.assignedTo !== assignee && task.claimExpires && task.claimExpires > Date.now()) {
      return { success: false, error: `Task ${id} is already claimed by ${task.assignedTo}` };
    }
    const token = randomUUID();
    const expires = Date.now() + leaseMs;
    const changed = this.stateDb.withRetry(() => this.stateDb.raw.prepare(
      `UPDATE agent_tasks SET assigned_to=?,claim_lock=?,claim_expires=?,updated_at=?
       WHERE id=? AND (assigned_to IS NULL OR assigned_to=? OR claim_expires IS NULL OR claim_expires<=?)`,
    ).run(assignee, token, expires, Date.now(), id, assignee, Date.now()).changes > 0);
    if (!changed) return { success: false, error: `Task ${id} is already claimed` };
    this.recordEvent(id, 'claim', null, assignee, assignee);
    return { success: true, lockToken: token };
  }

  heartbeat(id: string): void {
    const now = Date.now();
    const changed = this.stateDb.raw.prepare('UPDATE agent_tasks SET heartbeat_at=?,updated_at=? WHERE id=?').run(now, now, id).changes;
    if (!changed) throw new Error(`Task not found: ${id}`);
  }

  heartbeatClaim(id: string, lockToken: string, leaseMs = 300_000): boolean {
    const now = Date.now();
    return this.stateDb.raw.prepare('UPDATE agent_tasks SET heartbeat_at=?,claim_expires=?,updated_at=? WHERE id=? AND claim_lock=?')
      .run(now, now + leaseMs, now, id, lockToken).changes > 0;
  }

  blockTask(id: string, reason: string, actor = 'system', blockKind: AgentTaskBlockKind = 'transient'): AgentTask {
    const task = this.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    const count = task.blockRecurrenceCount + 1;
    const now = Date.now();
    const escalated = count >= 2;
    const status: AgentTaskStatus = escalated ? 'triage' : 'blocked';
    this.stateDb.withRetry(() => {
      this.stateDb.raw.prepare('UPDATE agent_tasks SET status=?,block_kind=?,block_recurrence_count=?,updated_at=? WHERE id=?')
        .run(status, blockKind, count, now, id);
      this.recordEvent(id, 'blocked', task.status, `blocked: ${reason}`, actor);
      if (escalated) this.recordEvent(id, 'escalated', 'blocked', 'triage', actor);
    });
    return this.get(id)!;
  }

  unblockTask(id: string, actor = 'agent'): AgentTask {
    const task = this.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    if (task.status !== 'blocked') throw new Error(`Task ${id} is not blocked`);
    const event = this.stateDb.raw.prepare("SELECT old_value FROM agent_task_events WHERE task_id=? AND event_type='blocked' ORDER BY created_at DESC LIMIT 1").get(id) as { old_value: string | null } | undefined;
    const previous = (event?.old_value as AgentTaskStatus | null) ?? 'triage';
    this.update(id, { status: previous }, actor);
    this.recordEvent(id, 'unblocked', 'blocked', previous, actor);
    return this.get(id)!;
  }

  linkTasks(sourceId: string, targetId: string, label = ''): void { this.addLink(sourceId, targetId, label); }

  addDependency(taskId: string, dependencyTaskId: string, label = ''): void {
    const source = this.get(taskId);
    const dependency = this.get(dependencyTaskId);
    if (!source || !dependency) throw new Error('Both dependency tasks must exist');
    if (source.scope !== dependency.scope || source.scopeId !== dependency.scopeId) throw new Error('Dependencies must be in the same task scope');
    this.addLink(taskId, dependencyTaskId, `depends:${label}`);
  }

  unlinkTasks(sourceId: string, targetId: string): void {
    this.stateDb.raw.prepare('DELETE FROM agent_task_links WHERE (source_id=? AND target_id=?) OR (source_id=? AND target_id=?)')
      .run(sourceId, targetId, targetId, sourceId);
  }

  getTaskLinks(taskId: string): AgentTask[] {
    const rows = this.stateDb.raw.prepare('SELECT t.* FROM agent_tasks t JOIN agent_task_links l ON l.target_id=t.id WHERE l.source_id=? ORDER BY t.title').all(taskId) as AgentTaskRow[];
    return rows.map(parseRow);
  }

  getTaskLinkDetails(taskId: string): Array<{ source_id: string; target_id: string; label: string; created_at: number }> { return this.rawLinks(taskId); }

  canRun(taskId: string): boolean {
    const dependencies = this.stateDb.raw.prepare("SELECT t.status FROM agent_task_links l JOIN agent_tasks t ON t.id=l.target_id WHERE l.source_id=? AND (l.label LIKE 'depends:%' OR l.label LIKE '%depend%')").all(taskId) as Array<{ status: AgentTaskStatus }>;
    return dependencies.every((task) => task.status === 'done' || task.status === 'archived');
  }

  checkStaleTasks(scope?: AgentTaskScope, scopeId?: string): string[] {
    const cutoff = Date.now() - 600_000;
    const where = ["status='running'", '(heartbeat_at IS NULL OR heartbeat_at < ?)'];
    const params: unknown[] = [cutoff];
    if (scope) { where.push('scope=?'); params.push(scope); }
    if (scopeId) { where.push('scope_id=?'); params.push(scopeId); }
    const rows = this.stateDb.raw.prepare(`SELECT id FROM agent_tasks WHERE ${where.join(' AND ')}`).all(...params) as Array<{ id: string }>;
    for (const row of rows) this.blockTask(row.id, 'Circuit breaker: task heartbeat timeout', 'system', 'transient');
    return rows.map((row) => row.id);
  }

  dispatchTask(scope: AgentTaskScope, scopeId: string, assignee: string): AgentTask | null {
    const ready = this.list({ scope, scopeId, status: 'ready', limit: 500 })
      .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.createdAt - b.createdAt);
    for (const task of ready) {
      if (!this.canRun(task.id)) continue;
      const claim = this.claimTask(task.id, assignee);
      if (claim.success) return this.transition(task.id, 'running', assignee);
    }
    return null;
  }

  /** Upsert a session task whose lifecycle is owned by another Core service (for example delegation). */
  syncExternalTask(input: {
    id: string; sessionId: string; title: string; description?: string;
    status: AgentTaskStatus; metadata?: Record<string, unknown>;
  }): AgentTask {
    const existing = this.get(input.id);
    if (existing && (existing.scope !== 'session' || existing.scopeId !== input.sessionId)) {
      throw new Error(`Task ID is already owned by a different scope: ${input.id}`);
    }
    const metadata = { ...(existing?.metadata ?? {}), ...(input.metadata ?? {}), source: 'delegation' };
    if (existing) return this.update(input.id, { title: input.title, description: input.description, status: input.status, metadata }, 'delegation');
    return this.create({ id: input.id, scope: 'session', scopeId: input.sessionId, title: input.title,
      description: input.description, status: input.status, metadata });
  }

  delete(id: string): boolean {
    return this.stateDb.withRetry(() => this.stateDb.raw.prepare('DELETE FROM agent_tasks WHERE id = ?').run(id).changes > 0);
  }

  addComment(taskId: string, body: string, author = 'agent'): void {
    if (!this.get(taskId)) throw new Error(`Task not found: ${taskId}`);
    const text = body.trim();
    if (!text) throw new Error('Comment body must not be empty');
    this.stateDb.raw.prepare('INSERT INTO agent_task_comments (id,task_id,author,body,created_at) VALUES (?,?,?,?,?)').run(randomUUID(), taskId, author, text, Date.now());
  }

  addImportedComment(taskId: string, comment: { body: string; author?: string; createdAt?: number }): void {
    if (!this.get(taskId)) throw new Error(`Task not found: ${taskId}`);
    this.stateDb.raw.prepare('INSERT INTO agent_task_comments (id,task_id,author,body,created_at) VALUES (?,?,?,?,?)')
      .run(randomUUID(), taskId, comment.author ?? 'agent', comment.body, comment.createdAt ?? Date.now());
  }

  addImportedEvent(taskId: string, event: { eventType: string; oldValue?: string | null; newValue?: string | null; actor?: string; createdAt?: number }): void {
    this.stateDb.raw.prepare('INSERT INTO agent_task_events (id,task_id,event_type,old_value,new_value,actor,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(randomUUID(), taskId, event.eventType, event.oldValue ?? null, event.newValue ?? null, event.actor ?? 'agent', event.createdAt ?? Date.now());
  }

  listComments(taskId: string): Array<{ id: string; task_id: string; author: string; body: string; created_at: number }> {
    return this.stateDb.raw.prepare('SELECT * FROM agent_task_comments WHERE task_id = ? ORDER BY created_at').all(taskId) as Array<{ id: string; task_id: string; author: string; body: string; created_at: number }>;
  }

  rawLinks(taskId: string): Array<{ source_id: string; target_id: string; label: string; created_at: number }> {
    return this.stateDb.raw.prepare('SELECT * FROM agent_task_links WHERE source_id = ? ORDER BY target_id').all(taskId) as Array<{ source_id: string; target_id: string; label: string; created_at: number }>;
  }

  rawEvents(taskId: string): Array<{ id: string; task_id: string; event_type: string; old_value: string | null; new_value: string | null; actor: string; created_at: number }> {
    return this.stateDb.raw.prepare('SELECT * FROM agent_task_events WHERE task_id = ? ORDER BY created_at').all(taskId) as Array<{ id: string; task_id: string; event_type: string; old_value: string | null; new_value: string | null; actor: string; created_at: number }>;
  }

  addLink(sourceId: string, targetId: string, label = ''): void {
    if (sourceId === targetId) throw new Error('Cannot link a task to itself');
    if (!this.get(sourceId) || !this.get(targetId)) throw new Error('Both linked tasks must exist');
    const now = Date.now();
    this.stateDb.raw.prepare('INSERT OR IGNORE INTO agent_task_links (source_id,target_id,label,created_at) VALUES (?,?,?,?)').run(sourceId,targetId,label,now);
    this.stateDb.raw.prepare('INSERT OR IGNORE INTO agent_task_links (source_id,target_id,label,created_at) VALUES (?,?,?,?)').run(targetId,sourceId,label,now);
  }

  hasLink(sourceId: string, targetId: string): boolean {
    return Boolean(this.stateDb.raw.prepare('SELECT 1 FROM agent_task_links WHERE source_id=? AND target_id=?').get(sourceId, targetId));
  }

  private recordEvent(taskId: string, eventType: string, oldValue: string | null, newValue: string | null, actor: string): void {
    this.stateDb.raw.prepare('INSERT INTO agent_task_events (id,task_id,event_type,old_value,new_value,actor,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(randomUUID(), taskId, eventType, oldValue, newValue, actor, Date.now());
  }
}

function validateScope(scope: AgentTaskScope, scopeId: string): void {
  if (scope !== 'session' && scope !== 'project') throw new Error('Task scope must be session or project');
  if (!scopeId?.trim()) throw new Error(`${scope} scope requires a scopeId`);
}

function priorityRank(priority: AgentTaskPriority): number {
  return priority === 'critical' ? 0 : priority === 'high' ? 1 : priority === 'medium' ? 2 : 3;
}
