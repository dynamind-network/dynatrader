import { describe, expect, it, beforeEach, vi } from 'vitest';
import { AgentLoop } from '../src/core/agent-loop.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';

class FakeRpcClient {
  handlers = new Map<string, Array<(params: unknown) => void>>();
  call: (method: string, params?: unknown) => Promise<any> = vi.fn(
    async (): Promise<unknown> => ({})
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

function makeLoop(client: FakeRpcClient, onEvent = vi.fn()) {
  return new AgentLoop(
    {},
    { model: 'test', systemPrompt: 'test', maxTokens: 1000, maxTurns: 4, tools: [] },
    new ToolRegistry(),
    { rpcClient: client, onEvent }
  );
}

describe('AgentLoop tool execution', () => {
  let client: FakeRpcClient;
  let onEvent: ReturnType<typeof vi.fn>;
  let loop: AgentLoop;

  beforeEach(() => {
    client = new FakeRpcClient();
    onEvent = vi.fn();
    loop = makeLoop(client, onEvent);
  });

  it('records a successful execution in the ledger', () => {
    client.emit('tool.start', { toolCallId: 'call-1', toolName: 'read', args: { path: 'a.txt' } });
    client.emit('tool.complete', {
      toolCallId: 'call-1',
      toolName: 'read',
      result: 'file contents',
      durationMs: 15,
      success: true,
    });

    const ledger = loop.getToolExecutionLedger();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      toolName: 'read',
      input: { path: 'a.txt' },
      durationMs: 15,
      status: 'success',
    });
    expect(ledger[0].result).toEqual({
      success: true,
      output: 'file contents',
      summary: '',
    });
  });

  it('serializes non-string tool results and passes strings through', () => {
    client.emit('tool.start', { toolCallId: 'c1', toolName: 'search', args: {} });
    client.emit('tool.complete', {
      toolCallId: 'c1',
      toolName: 'search',
      result: { hits: 3 },
      durationMs: 5,
      success: true,
    });
    expect(loop.getToolExecutionLedger()[0].result.output).toBe('{"hits":3}');

    client.emit('tool.start', { toolCallId: 'c2', toolName: 'read', args: { path: 'b' } });
    client.emit('tool.complete', {
      toolCallId: 'c2',
      toolName: 'read',
      result: 'plain text',
      durationMs: 5,
      success: true,
    });
    expect(loop.getToolExecutionLedger()[1].result.output).toBe('plain text');
  });

  it('records failed executions with error status and summary', () => {
    client.emit('tool.start', { toolCallId: 'call-1', toolName: 'write', args: { file_path: 'x' } });
    client.emit('tool.complete', {
      toolCallId: 'call-1',
      toolName: 'write',
      result: undefined,
      durationMs: 5,
      success: false,
      error: 'permission denied',
    });

    const record = loop.getToolExecutionLedger()[0];
    expect(record.status).toBe('error');
    expect(record.result).toEqual({
      success: false,
      output: 'permission denied',
      summary: 'permission denied',
    });
    expect(loop.getSessionStats()).toMatchObject({
      totalToolCalls: 1,
      failedToolCalls: 1,
    });
  });

  it('emits tool_start and tool_end events', () => {
    client.emit('tool.start', {
      toolCallId: 'call-1',
      toolName: 'glob',
      args: { pattern: '**/*.ts' },
    });
    client.emit('tool.complete', {
      toolCallId: 'call-1',
      toolName: 'glob',
      result: ['a.ts'],
      durationMs: 3,
      success: true,
    });

    expect(onEvent).toHaveBeenCalledWith({
      type: 'tool_start',
      toolName: 'glob',
      input: { pattern: '**/*.ts' },
    });
    expect(onEvent).toHaveBeenCalledWith({
      type: 'tool_end',
      toolName: 'glob',
      result: { success: true, output: '["a.ts"]', summary: '' },
    });
  });

  it('auto-checkpoints before file-modifying tool calls with the resolved file path', () => {
    const checkpoint = vi.fn();
    loop.setAutoCheckpoint(checkpoint);

    client.emit('tool.start', { toolCallId: 'c1', toolName: 'write', args: { file_path: 'src/a.ts' } });
    client.emit('tool.start', { toolCallId: 'c2', toolName: 'edit', args: { filePath: 'src/b.ts' } });
    client.emit('tool.start', {
      toolCallId: 'c3',
      toolName: 'multi_edit',
      args: { path: 'src/c.ts' },
    });
    client.emit('tool.start', { toolCallId: 'c4', toolName: 'read', args: { path: 'src/d.ts' } });

    expect(checkpoint).toHaveBeenCalledWith('before-write:src/a.ts');
    expect(checkpoint).toHaveBeenCalledWith('before-edit:src/b.ts');
    expect(checkpoint).toHaveBeenCalledWith('before-multi_edit:src/c.ts');
    expect(checkpoint).toHaveBeenCalledTimes(3);
  });

  it('falls back to an unknown path for file-modifying tools', () => {
    const checkpoint = vi.fn();
    loop.setAutoCheckpoint(checkpoint);

    client.emit('tool.start', { toolCallId: 'c1', toolName: 'write', args: {} });

    expect(checkpoint).toHaveBeenCalledWith('before-write:unknown');
  });

  it('ignores completions without a matching start', () => {
    client.emit('tool.complete', {
      toolCallId: 'ghost',
      toolName: 'read',
      result: 'x',
      durationMs: 1,
      success: true,
    });

    expect(loop.getToolExecutionLedger()).toHaveLength(0);
    expect(loop.getSessionStats()).toMatchObject({ totalToolCalls: 0 });
  });

  it('clears the ledger after clearConversation', () => {
    client.emit('tool.start', { toolCallId: 'c1', toolName: 'read', args: { path: 'a' } });
    client.emit('tool.complete', {
      toolCallId: 'c1',
      toolName: 'read',
      result: 'ok',
      durationMs: 1,
      success: true,
    });
    expect(loop.getToolExecutionLedger()).toHaveLength(1);

    loop.clearConversation();
    expect(loop.getToolExecutionLedger()).toHaveLength(0);
  });
});