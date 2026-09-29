import { describe, expect, it, vi } from 'vitest';
import { AgentLoop } from '../src/core/agent-loop.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';

class FakeRpcClient {
  handlers = new Map<string, Array<(params: unknown) => void>>();
  call = vi.fn(async (method: string) => {
    if (method === 'conversation.compact') {
      return { compacted: true, message: 'Compacted 12 messages.', messageCount: 4 };
    }
    if (method === 'agent.delegate') return { agent: 'general', result: { answer: 42 } };
    if (method === 'tool.policy.set') return { configured: true, availableTools: ['read'] };
    if (method === 'agent.delegate.start') return { task: { taskId: 'task-1' } };
    if (method === 'agent.delegate.cancel') return { cancelled: true };
    if (method === 'agent.delegate.list')
      return {
        tasks: [
          {
            taskId: 'task-1',
            agent: 'general',
            task: 'inspect',
            status: 'running',
            createdAt: 'now',
          },
        ],
      };
    if (method === 'approval.resolve') return { resolved: true };
    return {};
  });
  on(event: string, handler: (params: unknown) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }
  off() {}
  close() {}
  emit(event: string, params: unknown) {
    for (const handler of this.handlers.get(event) ?? []) handler(params);
  }
}

function makeLoop(client: FakeRpcClient, onEvent = vi.fn()) {
  return new AgentLoop(
    {},
    { model: 'test', systemPrompt: 'test', maxTokens: 1000, maxTurns: 4, tools: [] },
    new ToolRegistry(),
    { rpcClient: client, onEvent }
  );
}

describe('AgentLoop JSON-RPC adapter', () => {
  it('delegates manual compaction to DynaTrader', async () => {
    const client = new FakeRpcClient();
    const loop = makeLoop(client);

    await expect(loop.compact()).resolves.toEqual({
      success: true,
      message: 'Compacted 12 messages.',
    });
    expect(client.call).toHaveBeenCalledWith('conversation.compact');
  });

  it('preserves failed tool results in the ledger and UI event', () => {
    const client = new FakeRpcClient();
    const onEvent = vi.fn();
    const loop = makeLoop(client, onEvent);

    client.emit('tool.start', { toolCallId: 'call-1', toolName: 'write', args: { path: 'x' } });
    client.emit('tool.complete', {
      toolCallId: 'call-1',
      toolName: 'write',
      result: { success: false, error: 'denied' },
      durationMs: 8,
      success: false,
      error: 'denied',
    });

    expect(loop.getSessionStats()).toMatchObject({ totalToolCalls: 1, failedToolCalls: 1 });
    expect(loop.getToolExecutionLedger()[0]).toMatchObject({ status: 'error', toolName: 'write' });
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tool_end',
        result: expect.objectContaining({ success: false }),
      })
    );
  });

  it('delegates subagent work to the DynaTrader runtime', async () => {
    const client = new FakeRpcClient();
    const loop = makeLoop(client);

    await expect(loop.delegateTask('general', 'inspect the repository')).resolves.toEqual({
      answer: 42,
    });
    expect(client.call).toHaveBeenCalledWith('agent.delegate', {
      agent: 'general',
      task: 'inspect the repository',
      context: undefined,
    });
  });

  it('configures tool allow and deny lists in the DynaTrader runtime SDK', async () => {
    const client = new FakeRpcClient();
    const loop = makeLoop(client);

    await expect(loop.configureToolPolicy(['read', 'glob'], ['glob'])).resolves.toEqual(['read']);
    expect(client.call).toHaveBeenCalledWith('tool.policy.set', {
      allowedTools: ['read', 'glob'],
      disallowedTools: ['glob'],
    });
  });

  it('starts background delegation and announces task lifecycle updates', async () => {
    const client = new FakeRpcClient();
    const onEvent = vi.fn();
    const loop = makeLoop(client, onEvent);

    await expect(loop.startDelegatedTask('general', 'inspect')).resolves.toBe('task-1');
    client.emit('agent.task.update', {
      task: { taskId: 'task-1', agent: 'general', status: 'completed', result: 'done' },
    });

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'text', content: expect.stringContaining('task-1') })
    );
  });

  it('lists and cancels delegated runtime tasks', async () => {
    const client = new FakeRpcClient();
    const loop = makeLoop(client);
    await expect(loop.listDelegatedTasks()).resolves.toHaveLength(1);
    await expect(loop.cancelDelegatedTask('task-1')).resolves.toBe(true);
    expect(client.call).toHaveBeenCalledWith('agent.delegate.cancel', { taskId: 'task-1' });
  });

  it('returns Terminal approval decisions to the runtime', async () => {
    const client = new FakeRpcClient();
    const approval = vi.fn(async () => true);
    new AgentLoop(
      {},
      { model: 'test', systemPrompt: 'test', maxTokens: 1000, maxTurns: 4, tools: [] },
      new ToolRegistry(),
      {
        rpcClient: client,
        onApprovalRequired: approval,
      }
    );
    client.emit('approval.request', {
      requestId: 'approval-1',
      action: 'write',
      summary: 'Write file',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.call).toHaveBeenCalledWith('approval.resolve', {
      requestId: 'approval-1',
      approved: true,
    });
  });

  it('emits a loop warning when the exact same tool call repeats', () => {
    const client = new FakeRpcClient();
    const onEvent = vi.fn();
    const loop = makeLoop(client, onEvent);

    client.emit('tool.start', { toolCallId: 'call-1', toolName: 'read', args: { path: 'a' } });
    client.emit('tool.start', { toolCallId: 'call-2', toolName: 'read', args: { path: 'a' } });

    expect(loop.getSessionStats().loopWarnings).toBe(1);
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'loop_warning',
        message: expect.stringContaining('Repeated tool call detected for read'),
      })
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'text',
        content: expect.stringContaining('Repeated tool call detected for read'),
      })
    );
  });
});
