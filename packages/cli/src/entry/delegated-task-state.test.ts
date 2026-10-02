import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentTaskService, StateDb } from '@dyna/core/cli';
import { StdioDelegatedTaskState } from './delegated-task-state.js';

const dirs: string[] = [];
const dbs: StateDb[] = [];

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'dyna-stdio-tasks-'));
  dirs.push(dir);
  const db = new StateDb(dir);
  dbs.push(db);
  return { dir, db, service: new AgentTaskService(db) };
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('StdioDelegatedTaskState', () => {
  it('persists delegated task lifecycle and reloads terminal results from StateDb', () => {
    const { dir, service } = setup();
    const store = new StdioDelegatedTaskState(service);
    const task = store.start({
      taskId: 'agent_test', sessionId: 'session-a', agent: 'researcher', task: 'Find release notes',
      controller: new AbortController(),
    });
    expect(task.status).toBe('running');
    store.complete(task.taskId, 'session-a', { content: 'Found notes' });

    const reopenedDb = new StateDb(dir);
    dbs.push(reopenedDb);
    const reopened = new StdioDelegatedTaskState(new AgentTaskService(reopenedDb));
    expect(reopened.list('session-a')).toEqual([expect.objectContaining({
      taskId: 'agent_test', agent: 'researcher', status: 'completed', task: 'Find release notes',
      result: { content: 'Found notes' },
    })]);
    expect(reopened.get('agent_test', 'session-a')).toMatchObject({ status: 'completed', result: { content: 'Found notes' } });
    expect(reopened.get('agent_test', 'session-b')).toBeNull();
  });

  it('keeps only live cancellation handles in memory and persists cancellation', () => {
    const { service } = setup();
    const store = new StdioDelegatedTaskState(service);
    const controller = new AbortController();
    store.start({ taskId: 'agent_cancel', sessionId: 'session-a', agent: 'worker', task: 'Wait', controller });

    expect(store.cancel('agent_cancel', 'session-a')).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(store.get('agent_cancel', 'session-a')).toMatchObject({ status: 'cancelled', error: 'Cancelled by user.' });
    expect(store.cancel('agent_cancel', 'session-a')).toBe(false);
  });
});
