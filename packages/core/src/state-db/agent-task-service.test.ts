import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateDb } from './state-db';
import { AgentTaskService } from './agent-task-service';
import { KanbanTaskCompatibilityAdapter } from './kanban-compat';
import { KanbanBoard } from '../orchestration/workspace/kanban-board';
import { TodoTool } from '../runtime/tools/tools/todo-tool';

const dirs: string[] = [];
const dbs: StateDb[] = [];
const boards: KanbanBoard[] = [];

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'dyna-agent-tasks-'));
  dirs.push(dir);
  const db = new StateDb(dir); dbs.push(db);
  return { dir, db, service: new AgentTaskService(db) };
}

afterEach(() => {
  for (const board of boards.splice(0)) board.close();
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('AgentTaskService', () => {
  it('keeps session and project tasks isolated and persists status changes', () => {
    const { service } = setup();
    const sessionTask = service.create({ scope: 'session', scopeId: 's1', title: 'Current turn' });
    service.create({ scope: 'session', scopeId: 's2', title: 'Other session' });
    const projectTask = service.create({ scope: 'project', scopeId: 'project-a', title: 'Shared work' });

    expect(service.list({ scope: 'session', scopeId: 's1' }).map((task) => task.id)).toEqual([sessionTask.id]);
    expect(service.list({ scope: 'project', scopeId: 'project-a' }).map((task) => task.id)).toEqual([projectTask.id]);
    expect(service.update(sessionTask.id, { status: 'done' }).completedAt).not.toBeNull();
    expect(service.list({ scope: 'session', scopeId: 's1' })[0]?.status).toBe('done');
    expect(service.list({ scope: 'session', scopeId: 's1', includeArchived: true })).toHaveLength(1);
  });

  it('rejects blank task names and unknown statuses', () => {
    const { service } = setup();
    expect(() => service.create({ scope: 'session', scopeId: 's1', title: '  ' })).toThrow('Task title');
    const task = service.create({ scope: 'session', scopeId: 's1', title: 'A task' });
    expect(() => service.update(task.id, { status: 'unknown' as never })).toThrow('Invalid task status');
  });

  it('serves the todo tool and derives session scope from execution context', async () => {
    const { service } = setup();
    const tool = new TodoTool(service);
    const added = await tool.execute({ tool: 'todo', args: { action: 'add', title: 'Inspect release' } }, { sessionId: 'turn-1' });
    expect(added.success).toBe(true);
    const listed = await tool.execute({ tool: 'todo', args: { action: 'list' } }, { sessionId: 'turn-1' });
    expect((listed.data as { tasks: unknown[] }).tasks).toHaveLength(1);
    const missingSession = await tool.execute({ tool: 'todo', args: { action: 'list' } });
    expect(missingSession.success).toBe(false);
  });

  it('lets a delegated task manager mirror lifecycle into the same session task store', () => {
    const { service } = setup();
    const started = service.syncExternalTask({ id: 'delegate-1', sessionId: 'turn-1', title: 'Inspect tests', status: 'running' });
    const finished = service.syncExternalTask({ id: 'delegate-1', sessionId: 'turn-1', title: 'Inspect tests', status: 'done', metadata: { result: 'passed' } });
    expect(started.id).toBe(finished.id);
    expect(finished.status).toBe('done');
    expect(finished.metadata).toMatchObject({ source: 'delegation', result: 'passed' });
    expect(service.list({ scope: 'session', scopeId: 'turn-1' })).toHaveLength(1);
  });

  it('preserves claim leases, heartbeat, and expiry-aware reassignment', () => {
    const { service } = setup();
    const task = service.create({ scope: 'project', scopeId: 'p1', title: 'Claim me', status: 'ready' });
    const claim = service.claimTask(task.id, 'agent-a');
    expect(claim.success).toBe(true);
    expect(service.claimTask(task.id, 'agent-b').success).toBe(false);
    expect(service.heartbeatClaim(task.id, 'wrong-token')).toBe(false);
    expect(service.heartbeatClaim(task.id, claim.lockToken!)).toBe(true);
    service.update(task.id, { claimExpires: Date.now() - 1 });
    expect(service.claimTask(task.id, 'agent-b').success).toBe(true);
  });

  it('holds ready tasks until dependencies are complete and escalates recurring blocks', () => {
    const { service } = setup();
    const dependency = service.create({ scope: 'project', scopeId: 'p1', title: 'Dependency', status: 'todo' });
    const task = service.create({ scope: 'project', scopeId: 'p1', title: 'Dependent', status: 'ready' });
    service.addDependency(task.id, dependency.id);
    expect(service.dispatchTask('project', 'p1', 'worker')).toBeNull();
    service.transition(dependency.id, 'done');
    expect(service.dispatchTask('project', 'p1', 'worker')?.id).toBe(task.id);
    service.blockTask(task.id, 'first failure');
    expect(service.blockTask(task.id, 'second failure').status).toBe('triage');
  });

  it('imports legacy Kanban tasks, comments, events, and task links without removing source records', () => {
    const { dir, service } = setup();
    const board = new KanbanBoard(dir); boards.push(board);
    const a = board.createTask({ workspaceId: 'project-a', title: 'Legacy A', status: 'todo', priority: 'high' });
    const b = board.createTask({ workspaceId: 'project-a', title: 'Legacy B', status: 'blocked' });
    board.addComment(a.id, 'Keep this note');
    board.linkTasks(a.id, b.id, 'depends on');
    board.transitionTask(a.id, 'review', 'tester');
    const adapter = new KanbanTaskCompatibilityAdapter(service);

    expect(adapter.importBoard(board, 'project-a')).toEqual({ imported: 2, skipped: 0 });
    expect(adapter.importBoard(board, 'project-a')).toEqual({ imported: 0, skipped: 2 });
    const imported = service.get(a.id)!;
    expect(imported.scope).toBe('project');
    expect(imported.metadata.legacyKanban).toMatchObject({ claimLock: null, blockRecurrenceCount: 0 });
    expect(service.listComments(a.id)).toHaveLength(1);
    expect(service.rawLinks(a.id)).toHaveLength(1);
    expect(service.rawEvents(a.id).some((event) => event.event_type === 'status_change')).toBe(true);
    expect(board.getTask(a.id)).not.toBeNull();
  });

  it('exposes a Kanban-compatible facade over the canonical task service', () => {
    const { service } = setup();
    const facade = new KanbanTaskCompatibilityAdapter(service);
    const task = facade.createTask({ workspaceId: 'project-a', title: 'Facade task', status: 'ready' });
    expect(facade.getTask(task.id)?.workspaceId).toBe('project-a');
    expect(facade.claimTask(task.id, 'worker').success).toBe(true);
    expect(facade.transitionTask(task.id, 'running').status).toBe('running');
    expect(facade.listTasks({ workspaceId: 'project-a' })).toHaveLength(1);
  });
});
