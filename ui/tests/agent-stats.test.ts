import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { AgentLoop } from '../src/core/agent-loop.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import type { ToolExecutionContext } from '../src/core/types.js';

class FakeRpcClient {
  handlers = new Map<string, Array<(params: unknown) => void>>();
  call: (method: string, params?: unknown) => Promise<any> = vi.fn(
    async (method: string) => {
      if (method === 'prompt.submit') {
        return {
          content: 'Final answer',
          state: 'idle',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          durationMs: 10,
          compacted: false,
        };
      }
      return {};
    }
  );
  on(event: string, handler: (params: unknown) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }
  off() {}
  close() {}
  emit(event: string, params: unknown) {
    for (const handler of this.handlers.get(event) ?? []) handler(params);
  }
}

const context: ToolExecutionContext = {
  workingDirectory: process.cwd(),
  conversationId: 'conv-1',
  isSubagent: false,
};

function makeLoop(client: FakeRpcClient, onEvent = vi.fn()) {
  return new AgentLoop(
    {},
    { model: 'test', systemPrompt: 'test', maxTokens: 1000, maxTurns: 4, tools: [] },
    new ToolRegistry(),
    { rpcClient: client, onEvent }
  );
}

describe('AgentLoop session stats', () => {
  let client: FakeRpcClient;
  let loop: AgentLoop;

  beforeEach(() => {
    client = new FakeRpcClient();
    loop = makeLoop(client);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with an empty stats object', () => {
    expect(loop.getSessionStats()).toEqual({
      totalToolCalls: 0,
      successfulToolCalls: 0,
      failedToolCalls: 0,
      totalDurationMs: 0,
      loopWarnings: 0,
    });
  });

  it('counts successful and failed tool executions', () => {
    client.emit('tool.start', { toolCallId: 'c1', toolName: 'read', args: { path: 'a' } });
    client.emit('tool.complete', {
      toolCallId: 'c1',
      toolName: 'read',
      result: 'x',
      durationMs: 1,
      success: true,
    });
    client.emit('tool.start', { toolCallId: 'c2', toolName: 'write', args: { filePath: 'b' } });
    client.emit('tool.complete', {
      toolCallId: 'c2',
      toolName: 'write',
      result: undefined,
      durationMs: 1,
      success: false,
      error: 'denied',
    });

    expect(loop.getSessionStats()).toMatchObject({
      totalToolCalls: 2,
      successfulToolCalls: 1,
      failedToolCalls: 1,
    });
  });

  it('tracks ledger entries with success and error statuses', () => {
    client.emit('tool.start', { toolCallId: 'c1', toolName: 'read', args: { path: 'a' } });
    client.emit('tool.complete', {
      toolCallId: 'c1',
      toolName: 'read',
      result: 'ok',
      durationMs: 2,
      success: true,
    });
    client.emit('tool.start', { toolCallId: 'c2', toolName: 'write', args: { path: 'b' } });
    client.emit('tool.complete', {
      toolCallId: 'c2',
      toolName: 'write',
      result: undefined,
      durationMs: 3,
      success: false,
      error: 'failed',
    });

    const ledger = loop.getToolExecutionLedger();
    expect(ledger).toHaveLength(2);
    expect(ledger[0]).toMatchObject({ status: 'success', toolName: 'read' });
    expect(ledger[1]).toMatchObject({ status: 'error', toolName: 'write' });
  });

  it('returns a copy of the stats object', () => {
    const stats = loop.getSessionStats();
    stats.totalToolCalls = 99;
    expect(loop.getSessionStats().totalToolCalls).toBe(0);
  });

  it('records elapsed run time based on the system clock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);

    const runPromise = loop.run('hello', context);
    vi.setSystemTime(1000);
    const result = await runPromise;

    expect(result).toBe('Final answer');
    expect(loop.getSessionStats().totalDurationMs).toBe(1000);
  });

  it('resets stats and the ledger after clearConversation', () => {
    client.emit('tool.start', { toolCallId: 'c1', toolName: 'read', args: { path: 'a' } });
    client.emit('tool.complete', {
      toolCallId: 'c1',
      toolName: 'read',
      result: 'ok',
      durationMs: 1,
      success: true,
    });
    expect(loop.getSessionStats().totalToolCalls).toBe(1);

    loop.clearConversation();

    expect(loop.getSessionStats()).toEqual({
      totalToolCalls: 0,
      successfulToolCalls: 0,
      failedToolCalls: 0,
      totalDurationMs: 0,
      loopWarnings: 0,
    });
    expect(loop.getToolExecutionLedger()).toHaveLength(0);
  });
});