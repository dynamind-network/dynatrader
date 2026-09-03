import { describe, expect, it, vi } from 'vitest';
import { AgentLoop } from '../src/core/agent-loop.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';

class FakeRpcClient {
  handlers = new Map<string, Array<(params: unknown) => void>>();
  call = vi.fn(async (_method: string) => ({}));
  on(event: string, handler: (params: unknown) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }
  off() {}
  close() {}
  emit(event: string, params: unknown) {
    for (const handler of this.handlers.get(event) ?? []) handler(params);
  }
}

function createLoop(client: FakeRpcClient, onEvent = vi.fn()) {
  return new AgentLoop(
    {},
    { model: 'test', systemPrompt: 'test', maxTokens: 1000, maxTurns: 4, tools: [] },
    new ToolRegistry(),
    { rpcClient: client, onEvent }
  );
}

describe('AgentLoop scheduling and loop detection', () => {
  it('preserves tool result ordering for parallelizable batches', () => {
    const client = new FakeRpcClient();
    const loop = createLoop(client);

    // Two parallelizable batch calls start together.
    client.emit('tool.start', { toolCallId: 'first', toolName: 'read', args: { path: 'a.ts' } });
    client.emit('tool.start', { toolCallId: 'second', toolName: 'glob', args: { pattern: '*.ts' } });

    // The fast batched call resolves first, the slower one second.
    client.emit('tool.complete', {
      toolCallId: 'second',
      toolName: 'glob',
      result: { success: true, output: 'b.ts' },
      durationMs: 5,
      success: true,
    });
    client.emit('tool.complete', {
      toolCallId: 'first',
      toolName: 'read',
      result: { success: true, output: 'export const a = 1' },
      durationMs: 40,
      success: true,
    });

    const ledger = loop.getToolExecutionLedger();
    // Results arrive in completion order, each attributed to its own call.
    expect(ledger.map((record) => record.toolName)).toEqual(['glob', 'read']);
    expect(ledger[0].status).toBe('success');
    expect(ledger[0].result.output).toContain('b.ts');
    expect(ledger[1].status).toBe('success');
    expect(ledger[1].result.output).toContain('a = 1');
    expect(loop.getSessionStats()).toMatchObject({ totalToolCalls: 2, failedToolCalls: 0 });
  });

  it('detects repeated tool loops with a single deduplicated warning', () => {
    const client = new FakeRpcClient();
    const onEvent = vi.fn();
    const loop = createLoop(client, onEvent);

    // Same tool call repeats across the batch; loop detection must fire once.
    for (let i = 0; i < 3; i++) {
      client.emit('tool.start', { toolCallId: `call-${i}`, toolName: 'read', args: { path: 'a.ts' } });
    }

    expect(loop.getSessionStats()).toMatchObject({ totalToolCalls: 3, loopWarnings: 1 });

    const loopWarnings = onEvent.mock.calls.filter(([event]) => event.type === 'loop_warning');
    expect(loopWarnings).toHaveLength(1);
    expect((loopWarnings[0][0] as { message: string }).message).toContain(
      'Repeated tool call detected for read'
    );
  });
});