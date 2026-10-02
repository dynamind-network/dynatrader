import { describe, expect, it } from 'vitest';
import { createDelegatedTaskControlTools, DelegatedAgentTasks } from './delegated-agent-tasks';

describe('DelegatedAgentTasks', () => {
  it('tracks async completion and scopes task controls to the owning session', async () => {
    const changes: Array<{ status: string; owner?: string }> = [];
    const manager = new DelegatedAgentTasks({ onChange: (task, owner) => { changes.push({ status: task.status, owner }); } });
    let finish!: (value: unknown) => void;
    const started = await manager.run({ task: 'research', agent: 'researcher', executionMode: 'async', sessionId: 'parent-a' },
      () => new Promise((resolve) => { finish = resolve; }));
    const id = (started as { task_id: string }).task_id;

    expect(manager.get(id, 'parent-b')).toBeUndefined();
    expect(manager.get(id, 'parent-a')).toMatchObject({ status: 'running', task_id: id });

    finish({ content: 'done' });
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.get(id, 'parent-a')).toMatchObject({ status: 'completed', result: { content: 'done' } });
    expect(changes).toEqual([{ status: 'running', owner: 'parent-a' }, { status: 'completed', owner: 'parent-a' }]);
  });

  it('cancels a running child using its abort signal and exposes the controls as tools', async () => {
    const manager = new DelegatedAgentTasks();
    let signal: AbortSignal | undefined;
    const started = await manager.run({ task: 'long job', agent: 'worker', executionMode: 'async', sessionId: 'parent' },
      (childSignal) => {
        signal = childSignal;
        return new Promise((_resolve, reject) => childSignal.addEventListener('abort', () => reject(childSignal.reason), { once: true }));
      });
    const id = (started as { task_id: string }).task_id;
    const tools = createDelegatedTaskControlTools(manager);
    const cancelTool = tools.find((tool) => tool.definition.name === 'agent_task_cancel')!;
    const statusTool = tools.find((tool) => tool.definition.name === 'agent_task_status')!;

    const cancelled = await cancelTool.execute({ tool: 'agent_task_cancel', args: { task_id: id } }, { sessionId: 'parent' } as never);
    await Promise.resolve();
    expect(cancelled.success).toBe(true);
    expect(signal?.aborted).toBe(true);
    const status = await statusTool.execute({ tool: 'agent_task_status', args: { task_id: id } }, { sessionId: 'parent' } as never);
    expect(status).toMatchObject({ success: true, data: { status: 'cancelled' } });
  });
});
