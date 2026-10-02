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

describe('AgentLoop tool loop detection', () => {
  let client: FakeRpcClient;
  let onEvent: ReturnType<typeof vi.fn>;
  let loop: AgentLoop;

  beforeEach(() => {
    client = new FakeRpcClient();
    onEvent = vi.fn();
    loop = makeLoop(client, onEvent);
  });

  it('warns when the exact same tool call is repeated', () => {
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

  it('does not warn when consecutive tool calls differ', () => {
    client.emit('tool.start', { toolCallId: 'call-1', toolName: 'read', args: { path: 'a' } });
    client.emit('tool.start', { toolCallId: 'call-2', toolName: 'read', args: { path: 'b' } });
    client.emit('tool.start', { toolCallId: 'call-3', toolName: 'read', args: { path: 'c' } });

    expect(loop.getSessionStats().loopWarnings).toBe(0);
    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'loop_warning' })
    );
  });

  it('normalizes key order when serializing tool arguments', () => {
    client.emit('tool.start', {
      toolCallId: 'call-1',
      toolName: 'read',
      args: { path: 'a', line: 1 },
    });
    client.emit('tool.start', {
      toolCallId: 'call-2',
      toolName: 'read',
      args: { line: 1, path: 'a' },
    });

    expect(loop.getSessionStats().loopWarnings).toBe(1);
  });

  it('emits exactly one warning per repeated signature', () => {
    client.emit('tool.start', { toolCallId: 'call-1', toolName: 'read', args: { path: 'a' } });
    client.emit('tool.start', { toolCallId: 'call-2', toolName: 'read', args: { path: 'a' } });
    client.emit('tool.start', { toolCallId: 'call-3', toolName: 'read', args: { path: 'a' } });

    expect(loop.getSessionStats().loopWarnings).toBe(1);
  });

  it('counts one warning for each distinct repeated signature', () => {
    client.emit('tool.start', { toolCallId: 'c1', toolName: 'read', args: { path: 'a' } });
    client.emit('tool.start', { toolCallId: 'c2', toolName: 'read', args: { path: 'a' } });

    client.emit('tool.start', { toolCallId: 'c3', toolName: 'glob', args: { pattern: '**/*.ts' } });
    client.emit('tool.start', {
      toolCallId: 'c4',
      toolName: 'glob',
      args: { pattern: '**/*.ts' },
    });

    expect(loop.getSessionStats().loopWarnings).toBe(2);
  });

  it('resets loop tracking after clearConversation', () => {
    client.emit('tool.start', { toolCallId: 'call-1', toolName: 'read', args: { path: 'a' } });
    client.emit('tool.start', { toolCallId: 'call-2', toolName: 'read', args: { path: 'a' } });
    expect(loop.getSessionStats().loopWarnings).toBe(1);

    loop.clearConversation();
    expect(loop.getSessionStats().loopWarnings).toBe(0);

    client.emit('tool.start', { toolCallId: 'call-3', toolName: 'read', args: { path: 'a' } });
    client.emit('tool.start', { toolCallId: 'call-4', toolName: 'read', args: { path: 'a' } });
    expect(loop.getSessionStats().loopWarnings).toBe(1);
  });
});