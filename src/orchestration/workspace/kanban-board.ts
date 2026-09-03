import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskStatus = "triage" | "todo" | "scheduled" | "ready" | "running" | "blocked" | "review" | "done" | "archived";
export type TaskPriority = "low" | "medium" | "high" | "critical";
export type BlockKind = "dependency" | "needs_input" | "capability" | "transient";
export type EntityKind = "asset" | "sector" | "theme" | "strategy" | "note";

export interface TaskRow {
  id: string;
  workspace_id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  tags: string; // JSON array
  assigned_to: string | null;
  claim_lock: string | null;
  claim_expires: number | null;
  block_kind: BlockKind | null;
  block_recurrence_count: number;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
  heartbeat_at: number | null;
}

export interface Task {
  id: string;
  workspaceId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  tags: string[];
  assignedTo: string | null;
  claimLock: string | null;
  claimExpires: number | null;
  blockKind: BlockKind | null;
  blockRecurrenceCount: number;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
  heartbeatAt: number | null;
}

export interface TaskLink {
  source_id: string;
  target_id: string;
  label: string;
  created_at: number;
}

export interface TaskComment {
  id: string;
  task_id: string;
  author: string;
  body: string;
  created_at: number;
}

export interface TaskEvent {
  id: string;
  task_id: string;
  event_type: string;
  old_value: string | null;
  new_value: string | null;
  actor: string;
  created_at: number;
}

export interface EntityRow {
  id: string;
  name: string;
  kind: EntityKind;
  description: string;
  tags: string; // JSON array
  metadata: string; // JSON object
  created_at: number;
  updated_at: number;
}

export interface TrackedEntity {
  id: string;
  name: string;
  kind: EntityKind;
  description: string;
  tags: string[];
  metadata: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export interface EntityLink {
  source_id: string;
  target_id: string;
  label: string;
  created_at: number;
}

export interface EntityGraph {
  nodes: TrackedEntity[];
  edges: EntityLink[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    tags: JSON.parse(row.tags) as string[],
    assignedTo: row.assigned_to,
    claimLock: row.claim_lock,
    claimExpires: row.claim_expires,
    blockKind: row.block_kind,
    blockRecurrenceCount: row.block_recurrence_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    heartbeatAt: row.heartbeat_at,
  };
}

function toEntity(row: EntityRow): TrackedEntity {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    description: row.description,
    tags: JSON.parse(row.tags) as string[],
    metadata: JSON.parse(row.metadata) as Record<string, string>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// KanbanBoard
// ---------------------------------------------------------------------------

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'triage' CHECK(status IN ('triage','todo','scheduled','ready','running','blocked','review','done','archived')),
    priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high','critical')),
    tags TEXT DEFAULT '[]',
    assigned_to TEXT,
    claim_lock TEXT,
    claim_expires INTEGER,
    block_kind TEXT CHECK(block_kind IN ('dependency','needs_input','capability','transient')),
    block_recurrence_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    resolved_at INTEGER,
    heartbeat_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS task_links (
    source_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    label TEXT DEFAULT '',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (source_id, target_id)
  );

  CREATE TABLE IF NOT EXISTS task_comments (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    author TEXT DEFAULT 'agent',
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS task_events (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    actor TEXT DEFAULT 'agent',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('asset','sector','theme','strategy','note')),
    description TEXT DEFAULT '',
    tags TEXT DEFAULT '[]',
    metadata TEXT DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS entity_links (
    source_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    label TEXT DEFAULT '',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (source_id, target_id)
  );

  CREATE INDEX IF NOT EXISTS idx_kanban_tasks_workspace ON tasks(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_kanban_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_kanban_tasks_priority ON tasks(priority);
  CREATE INDEX IF NOT EXISTS idx_kanban_task_comments_task ON task_comments(task_id);
  CREATE INDEX IF NOT EXISTS idx_kanban_task_events_task ON task_events(task_id);
  CREATE INDEX IF NOT EXISTS idx_kanban_entity_links_source ON entity_links(source_id);
  CREATE INDEX IF NOT EXISTS idx_kanban_entity_links_target ON entity_links(target_id);
`;

export class KanbanBoard {
  private db: Database.Database;

  constructor(workspacePath: string) {
    const dbPath = join(workspacePath, "kanban.db");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initSchema();
  }

  // ---------------------------------------------------------------------------
  // Schema initialization
  // ---------------------------------------------------------------------------

  private initSchema(): void {
    // Execute each statement separately since better-sqlite3 doesn't handle
    // multiple statements in one go by default
    const statements = SCHEMA.split(";").filter((s) => s.trim().length > 0);
    for (const stmt of statements) {
      this.db.exec(stmt + ";");
    }

    // Migration: add new columns if they don't exist
    const cols = this.db.pragma("table_info(tasks)") as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    if (!colNames.includes("claim_lock")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN claim_lock TEXT");
    }
    if (!colNames.includes("claim_expires")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN claim_expires INTEGER");
    }
    if (!colNames.includes("block_kind")) {
      this.db.exec(
        "ALTER TABLE tasks ADD COLUMN block_kind TEXT CHECK(block_kind IN ('dependency','needs_input','capability','transient'))",
      );
    }
    if (!colNames.includes("block_recurrence_count")) {
      this.db.exec(
        "ALTER TABLE tasks ADD COLUMN block_recurrence_count INTEGER NOT NULL DEFAULT 0",
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Task operations
  // ---------------------------------------------------------------------------

  createTask(spec: {
    workspaceId: string;
    title: string;
    description?: string;
    status?: TaskStatus;
    priority?: TaskPriority;
    tags?: string[];
    assignedTo?: string;
  }): Task {
    const id = randomUUID();
    const now = Date.now();

    const insert = this.db.prepare(`
      INSERT INTO tasks (id, workspace_id, title, description, status, priority, tags, assigned_to, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insert.run(
      id,
      spec.workspaceId,
      spec.title,
      spec.description ?? "",
      spec.status ?? "triage",
      spec.priority ?? "medium",
      JSON.stringify(spec.tags ?? []),
      spec.assignedTo ?? null,
      now,
      now,
    );

    return this.getTask(id)!;
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | TaskRow
      | undefined;
    if (!row) return null;
    return toTask(row);
  }

  listTasks(filters?: {
    workspaceId?: string;
    status?: TaskStatus;
    priority?: TaskPriority;
    tag?: string;
  }): Task[] {
    let sql = "SELECT * FROM tasks WHERE 1=1";
    const params: unknown[] = [];

    if (filters?.workspaceId) {
      sql += " AND workspace_id = ?";
      params.push(filters.workspaceId);
    }
    if (filters?.status) {
      sql += " AND status = ?";
      params.push(filters.status);
    }
    if (filters?.priority) {
      sql += " AND priority = ?";
      params.push(filters.priority);
    }
    if (filters?.tag) {
      // Match exact tag with JSON array quoting
      sql += " AND tags LIKE ?";
      params.push(`%"${filters.tag}"%`);
    }

    sql += " ORDER BY created_at DESC";

    const rows = this.db.prepare(sql).all(...params) as TaskRow[];
    return rows.map(toTask);
  }

  updateTask(
    id: string,
    updates: Partial<Omit<Task, "id" | "createdAt">>,
  ): Task {
    const existing = this.getTask(id);
    if (!existing) {
      throw new Error(`Task not found: ${id}`);
    }

    const now = Date.now();
    const sets: string[] = [];
    const params: unknown[] = [];

    if (updates.title !== undefined) {
      sets.push("title = ?");
      params.push(updates.title);
    }
    if (updates.description !== undefined) {
      sets.push("description = ?");
      params.push(updates.description);
    }
    if (updates.status !== undefined) {
      // Record status change event
      if (updates.status !== existing.status) {
        this.recordEvent({
          taskId: id,
          eventType: "status_change",
          oldValue: existing.status,
          newValue: updates.status,
          actor: "system",
        });
      }
      sets.push("status = ?");
      params.push(updates.status);

      if (updates.status === "done" || updates.status === "archived") {
        sets.push("resolved_at = ?");
        params.push(now);
      }
    }
    if (updates.priority !== undefined) {
      sets.push("priority = ?");
      params.push(updates.priority);
    }
    if (updates.tags !== undefined) {
      sets.push("tags = ?");
      params.push(JSON.stringify(updates.tags));
    }
    if (updates.assignedTo !== undefined) {
      sets.push("assigned_to = ?");
      params.push(updates.assignedTo);
    }
    if (updates.heartbeatAt !== undefined) {
      sets.push("heartbeat_at = ?");
      params.push(updates.heartbeatAt);
    }
    if (updates.claimLock !== undefined) {
      sets.push("claim_lock = ?");
      params.push(updates.claimLock);
    }
    if (updates.claimExpires !== undefined) {
      sets.push("claim_expires = ?");
      params.push(updates.claimExpires);
    }
    if (updates.blockKind !== undefined) {
      sets.push("block_kind = ?");
      params.push(updates.blockKind);
    }
    if (updates.blockRecurrenceCount !== undefined) {
      sets.push("block_recurrence_count = ?");
      params.push(updates.blockRecurrenceCount);
    }

    sets.push("updated_at = ?");
    params.push(now);
    params.push(id);

    this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(
      ...params,
    );

    return this.getTask(id)!;
  }

  deleteTask(id: string): void {
    const existing = this.getTask(id);
    if (!existing) {
      throw new Error(`Task not found: ${id}`);
    }
    // CASCADE will handle links, comments, and events
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  }

  transitionTask(id: string, newStatus: TaskStatus, actor = "agent"): Task {
    const existing = this.getTask(id);
    if (!existing) {
      throw new Error(`Task not found: ${id}`);
    }

    const now = Date.now();
    const oldStatus = existing.status;

    const updates: string[] = ["status = ?", "updated_at = ?"];
    const params: unknown[] = [newStatus, now];

    if (newStatus === "done" || newStatus === "archived") {
      updates.push("resolved_at = ?");
      params.push(now);
    }

    params.push(id);

    this.db
      .prepare(`UPDATE tasks SET ${updates.join(", ")} WHERE id = ?`)
      .run(...params);

    this.recordEvent({
      taskId: id,
      eventType: "status_change",
      oldValue: oldStatus,
      newValue: newStatus,
      actor,
    });

    return this.getTask(id)!;
  }

  claimTask(
    id: string,
    assignee: string,
  ): { success: boolean; lockToken?: string; error?: string } {
    const lockToken = randomUUID();
    const result = this.db.transaction(() => {
      const row = this.db
        .prepare(
          "SELECT assigned_to, claim_expires FROM tasks WHERE id = ?",
        )
        .get(id) as
        | { assigned_to: string | null; claim_expires: number | null }
        | undefined;

      if (!row) {
        return { success: false, error: `Task not found: ${id}` };
      }

      if (
        row.assigned_to !== null &&
        row.assigned_to !== assignee
      ) {
        // Check if claim has expired
        if (
          row.claim_expires &&
          row.claim_expires > Date.now()
        ) {
          return {
            success: false,
            error: `Task ${id} is already claimed by ${row.assigned_to}`,
          };
        }
      }

      const now = Date.now();
      this.db
        .prepare(
          "UPDATE tasks SET assigned_to = ?, claim_lock = ?, claim_expires = ?, updated_at = ? WHERE id = ?",
        )
        .run(assignee, lockToken, now + 300000, now, id);

      this.recordEvent({
        taskId: id,
        eventType: "claim",
        newValue: assignee,
        actor: assignee,
      });

      return { success: true, lockToken };
    })();

    return result;
  }

  heartbeat(id: string): void {
    const now = Date.now();
    const result = this.db
      .prepare("UPDATE tasks SET heartbeat_at = ? WHERE id = ?")
      .run(now, id);
    if (result.changes === 0) {
      throw new Error(`Task not found: ${id}`);
    }
  }

  heartbeatClaim(id: string, lockToken: string): boolean {
    const now = Date.now();
    const result = this.db
      .prepare(
        "UPDATE tasks SET heartbeat_at = ?, claim_expires = ?, updated_at = ? WHERE id = ? AND claim_lock = ?",
      )
      .run(now, now + 300000, now, id, lockToken);
    return result.changes > 0;
  }

  private static readonly BLOCK_RECURRENCE_LIMIT = 2;

  blockTask(
    id: string,
    reason: string,
    actor = "system",
    blockKind: BlockKind = "transient",
  ): Task | null {
    const existing = this.getTask(id);
    if (!existing) {
      throw new Error(`Task not found: ${id}`);
    }

    const now = Date.now();
    const previousStatus = existing.status;

    this.db
      .prepare(
        "UPDATE tasks SET status = ?, block_kind = ?, block_recurrence_count = block_recurrence_count + 1, updated_at = ? WHERE id = ?",
      )
      .run("blocked", blockKind, now, id);

    this.recordEvent({
      taskId: id,
      eventType: "blocked",
      oldValue: previousStatus,
      newValue: `blocked: ${reason}`,
      actor,
    });

    // Check recurrence count for escalation
    const task = this.getTask(id);
    if (
      task &&
      task.blockRecurrenceCount >=
        KanbanBoard.BLOCK_RECURRENCE_LIMIT
    ) {
      this.transitionTask(id, "triage", actor);
      this.recordEvent({
        taskId: id,
        eventType: "escalated",
        oldValue: "blocked",
        newValue: "triage",
        actor,
      });
    }

    return this.getTask(id);
  }

  unblockTask(id: string, actor = "agent"): Task {
    const existing = this.getTask(id);
    if (!existing) {
      throw new Error(`Task not found: ${id}`);
    }

    if (existing.status !== "blocked") {
      throw new Error(`Task ${id} is not blocked`);
    }

    // Find the previous status from the blocked event
    const blockEvent = this.db
      .prepare(
        "SELECT old_value FROM task_events WHERE task_id = ? AND event_type = 'blocked' ORDER BY created_at DESC LIMIT 1",
      )
      .get(id) as { old_value: string } | undefined;

    const previousStatus =
      (blockEvent?.old_value as TaskStatus) ?? "triage";

    const now = Date.now();

    this.db
      .prepare(
        "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?",
      )
      .run(previousStatus, now, id);

    this.recordEvent({
      taskId: id,
      eventType: "unblocked",
      oldValue: "blocked",
      newValue: previousStatus,
      actor,
    });

    return this.getTask(id)!;
  }

  // ---------------------------------------------------------------------------
  // Comment operations
  // ---------------------------------------------------------------------------

  addComment(
    taskId: string,
    body: string,
    author = "agent",
  ): TaskComment {
    const existing = this.getTask(taskId);
    if (!existing) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const id = randomUUID();
    const now = Date.now();

    this.db
      .prepare(
        "INSERT INTO task_comments (id, task_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, taskId, author, body, now);

    return {
      id,
      task_id: taskId,
      author,
      body,
      created_at: now,
    };
  }

  listComments(taskId: string): TaskComment[] {
    return this.db
      .prepare(
        "SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC",
      )
      .all(taskId) as TaskComment[];
  }

  // ---------------------------------------------------------------------------
  // Link operations
  // ---------------------------------------------------------------------------

  linkTasks(
    sourceId: string,
    targetId: string,
    label = "",
  ): void {
    if (sourceId === targetId) {
      throw new Error("Cannot link a task to itself");
    }

    const source = this.getTask(sourceId);
    if (!source) {
      throw new Error(`Source task not found: ${sourceId}`);
    }

    const target = this.getTask(targetId);
    if (!target) {
      throw new Error(`Target task not found: ${targetId}`);
    }

    const now = Date.now();

    // Insert both directions for bidirectional linking
    this.db
      .prepare(
        "INSERT OR IGNORE INTO task_links (source_id, target_id, label, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(sourceId, targetId, label, now);

    this.db
      .prepare(
        "INSERT OR IGNORE INTO task_links (source_id, target_id, label, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(targetId, sourceId, label, now);
  }

  unlinkTasks(sourceId: string, targetId: string): void {
    // Remove both directions
    this.db
      .prepare(
        "DELETE FROM task_links WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)",
      )
      .run(sourceId, targetId, targetId, sourceId);
  }

  getTaskLinks(taskId: string): Task[] {
    const rows = this.db
      .prepare(
        `SELECT t.* FROM tasks t
         INNER JOIN task_links tl ON (tl.target_id = t.id)
         WHERE tl.source_id = ?
         ORDER BY t.title`,
      )
      .all(taskId) as TaskRow[];
    return rows.map(toTask);
  }

  // ---------------------------------------------------------------------------
  // Entity operations
  // ---------------------------------------------------------------------------

  createEntity(spec: {
    name: string;
    kind: EntityKind;
    description?: string;
    tags?: string[];
    metadata?: Record<string, string>;
  }): TrackedEntity {
    const id = randomUUID();
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO entities (id, name, kind, description, tags, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        spec.name,
        spec.kind,
        spec.description ?? "",
        JSON.stringify(spec.tags ?? []),
        JSON.stringify(spec.metadata ?? {}),
        now,
        now,
      );

    return this.getEntity(id)!;
  }

  getEntity(id: string): TrackedEntity | null {
    const row = this.db.prepare("SELECT * FROM entities WHERE id = ?").get(
      id,
    ) as EntityRow | undefined;
    if (!row) return null;
    return toEntity(row);
  }

  listEntities(kind?: EntityKind): TrackedEntity[] {
    let sql = "SELECT * FROM entities";
    const params: unknown[] = [];

    if (kind) {
      sql += " WHERE kind = ?";
      params.push(kind);
    }

    sql += " ORDER BY name ASC";

    const rows = this.db.prepare(sql).all(...params) as EntityRow[];
    return rows.map(toEntity);
  }

  updateEntity(
    id: string,
    updates: Partial<Omit<TrackedEntity, "id" | "createdAt">>,
  ): TrackedEntity {
    const existing = this.getEntity(id);
    if (!existing) {
      throw new Error(`Entity not found: ${id}`);
    }

    const now = Date.now();
    const sets: string[] = [];
    const params: unknown[] = [];

    if (updates.name !== undefined) {
      sets.push("name = ?");
      params.push(updates.name);
    }
    if (updates.kind !== undefined) {
      sets.push("kind = ?");
      params.push(updates.kind);
    }
    if (updates.description !== undefined) {
      sets.push("description = ?");
      params.push(updates.description);
    }
    if (updates.tags !== undefined) {
      sets.push("tags = ?");
      params.push(JSON.stringify(updates.tags));
    }
    if (updates.metadata !== undefined) {
      sets.push("metadata = ?");
      params.push(JSON.stringify(updates.metadata));
    }

    sets.push("updated_at = ?");
    params.push(now);
    params.push(id);

    this.db
      .prepare(`UPDATE entities SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);

    return this.getEntity(id)!;
  }

  deleteEntity(id: string): void {
    const existing = this.getEntity(id);
    if (!existing) {
      throw new Error(`Entity not found: ${id}`);
    }
    // CASCADE will handle entity_links
    this.db.prepare("DELETE FROM entities WHERE id = ?").run(id);
  }

  searchEntities(query: string): TrackedEntity[] {
    const lower = `%${query.toLowerCase()}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM entities WHERE LOWER(name) LIKE ? OR LOWER(description) LIKE ? ORDER BY name ASC`,
      )
      .all(lower, lower) as EntityRow[];
    return rows.map(toEntity);
  }

  linkEntities(
    sourceId: string,
    targetId: string,
    label = "",
  ): EntityLink {
    if (sourceId === targetId) {
      throw new Error("Cannot link an entity to itself");
    }

    const source = this.getEntity(sourceId);
    if (!source) {
      throw new Error(`Entity not found: ${sourceId}`);
    }

    const target = this.getEntity(targetId);
    if (!target) {
      throw new Error(`Entity not found: ${targetId}`);
    }

    const now = Date.now();

    // Insert both directions for bidirectional linking
    this.db
      .prepare(
        "INSERT OR IGNORE INTO entity_links (source_id, target_id, label, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(sourceId, targetId, label, now);

    this.db
      .prepare(
        "INSERT OR IGNORE INTO entity_links (source_id, target_id, label, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(targetId, sourceId, label, now);

    return { source_id: sourceId, target_id: targetId, label, created_at: now };
  }

  unlinkEntities(sourceId: string, targetId: string): void {
    this.db
      .prepare(
        "DELETE FROM entity_links WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)",
      )
      .run(sourceId, targetId, targetId, sourceId);
  }

  getEntityLinks(entityId: string): EntityLink[] {
    return this.db
      .prepare(
        "SELECT * FROM entity_links WHERE source_id = ? OR target_id = ? ORDER BY created_at ASC",
      )
      .all(entityId, entityId) as EntityLink[];
  }

  getEntityGraph(): EntityGraph {
    const nodes = this.listEntities();
    const edges = this.db
      .prepare("SELECT * FROM entity_links ORDER BY created_at ASC")
      .all() as EntityLink[];
    return { nodes, edges };
  }

  // ---------------------------------------------------------------------------
  // Event operations
  // ---------------------------------------------------------------------------

  getTaskEvents(taskId: string): TaskEvent[] {
    return this.db
      .prepare(
        "SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC",
      )
      .all(taskId) as TaskEvent[];
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private recordEvent(event: {
    taskId: string;
    eventType: string;
    oldValue?: string;
    newValue?: string;
    actor?: string;
  }): void {
    const id = randomUUID();
    const now = Date.now();

    this.db
      .prepare(
        "INSERT INTO task_events (id, task_id, event_type, old_value, new_value, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        event.taskId,
        event.eventType,
        event.oldValue ?? null,
        event.newValue ?? null,
        event.actor ?? "agent",
        now,
      );
  }

  // ---------------------------------------------------------------------------
  // Circuit breaker / stale task detection
  // ---------------------------------------------------------------------------

  checkStaleTasks(): string[] {
    const cutoff = Date.now() - 600000; // 10 min
    const stale = this.db
      .prepare(
        "SELECT id FROM tasks WHERE status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < ?)",
      )
      .all(cutoff) as { id: string }[];

    for (const row of stale) {
      this.blockTask(
        row.id,
        "Circuit breaker: task heartbeat timeout",
        "system",
        "transient",
      );
    }
    return stale.map((r) => r.id);
  }

  // ---------------------------------------------------------------------------
  // FIFO dispatch
  // ---------------------------------------------------------------------------

  dispatchTask(assignee: string): Task | null {
    const row = this.db
      .prepare(
        `SELECT * FROM tasks WHERE status = 'ready' ORDER BY 
       CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END ASC,
       created_at ASC LIMIT 1`,
      )
      .get() as TaskRow | undefined;
    if (!row) return null;
    const claimed = this.claimTask(row.id, assignee);
    if (!claimed.success) return null;
    this.transitionTask(row.id, "running", assignee);
    return this.getTask(row.id);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  close(): void {
    this.db.close();
  }
}
