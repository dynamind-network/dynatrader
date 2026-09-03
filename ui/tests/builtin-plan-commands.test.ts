import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCommandRegistry, registerBuiltinCommands } from '../src/commands/index.js';

describe('plan slash commands', () => {
  beforeEach(() => {
    getCommandRegistry().clear();
    registerBuiltinCommands();
  });
  it('enters and exits planning through command callbacks', async () => {
    const enter = vi.fn(async () => {});
    const exit = vi.fn(async () => {});
    const context = {
      cwd: process.cwd(),
      onMessage: vi.fn(),
      onEnterPlanMode: enter,
      onExitPlanMode: exit,
    };
    expect(await getCommandRegistry().execute('plan', 'fix auth', context)).toContain(
      'Planning mode enabled'
    );
    expect(enter).toHaveBeenCalledWith('fix auth');
    expect(await getCommandRegistry().execute('exit-plan', '', context)).toContain('submitted');
    expect(exit).toHaveBeenCalled();
  });

  it('compacts through the DynaTrader runtime and disconnects stored providers', async () => {
    const compact = vi.fn(async () => ({ success: true, message: 'Compacted 20 messages.' }));
    const disconnect = vi.fn(async () => true);
    const context = {
      cwd: process.cwd(),
      onMessage: vi.fn(),
      onCompact: compact,
      onDisconnectProvider: disconnect,
    };

    expect(await getCommandRegistry().execute('compact', '', context)).toBe(
      'Compacted 20 messages.'
    );
    expect(compact).toHaveBeenCalledOnce();
    expect(await getCommandRegistry().execute('disconnect', 'OpenAI', context)).toContain(
      'Disconnected openai'
    );
    expect(disconnect).toHaveBeenCalledWith('openai');
  });

  it('lists the tools exposed by the DynaTrader runtime instead of a local registry', async () => {
    const onListTools = vi.fn(async () => [
      { name: 'read', description: 'Read a file', category: 'filesystem' },
      { name: 'delegate_task', description: 'Delegate work', category: 'session' },
    ]);
    const output = await getCommandRegistry().execute('tools', '', {
      cwd: process.cwd(),
      onMessage: vi.fn(),
      onListTools,
    });
    expect(output).toContain('Available runtime tools (2)');
    expect(output).toContain('delegate_task [session]');
    expect(onListTools).toHaveBeenCalledOnce();
  });

  it('lists and cancels runtime-owned delegated tasks', async () => {
    const onListDelegatedTasks = vi.fn(async () => [
      {
        taskId: 'task-1',
        agent: 'general',
        task: 'inspect',
        status: 'running',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ]);
    const onCancelDelegatedTask = vi.fn(async () => true);
    const context = {
      cwd: process.cwd(),
      onMessage: vi.fn(),
      onListDelegatedTasks,
      onCancelDelegatedTask,
    };
    expect(await getCommandRegistry().execute('tasks', '', context)).toContain('task-1  [running]');
    expect(await getCommandRegistry().execute('tasks', 'cancel task-1', context)).toContain(
      'Cancelled delegated task'
    );
    expect(onCancelDelegatedTask).toHaveBeenCalledWith('task-1');
  });
});
