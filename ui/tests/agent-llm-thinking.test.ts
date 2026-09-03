import { describe, expect, it, beforeEach, vi } from 'vitest';
import { AgentLoop, AgentState } from '../src/core/agent-loop.js';
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

describe('AgentLoop streaming and lifecycle events', () => {
  let client: FakeRpcClient;
  let onEvent: ReturnType<typeof vi.fn>;
  let loop: AgentLoop;

  beforeEach(() => {
    client = new FakeRpcClient();
    onEvent = vi.fn();
    loop = makeLoop(client, onEvent);
  });

  it('forwards thinking events from the runtime', () => {
    client.emit('thinking', { content: 'Let me reason about this.' });

    expect(onEvent).toHaveBeenCalledWith({
      type: 'thinking',
      content: 'Let me reason about this.',
    });
  });

  it('forwards streaming deltas as partial events', () => {
    client.emit('message.delta', { content: 'First' });
    client.emit('message.delta', { content: ' chunk' });

    expect(onEvent).toHaveBeenCalledWith({ type: 'partial', content: 'First' });
    expect(onEvent).toHaveBeenCalledWith({ type: 'partial', content: ' chunk' });
  });

  it('forwards runtime errors as error events', () => {
    client.emit('error', { message: 'Model timed out' });

    expect(onEvent).toHaveBeenCalledWith({ type: 'error', error: 'Model timed out' });
  });

  it('resolves run() with the final response', async () => {
    const result = await loop.run('Hello world', context);

    expect(result).toBe('Final answer');
  });

  it('emits a done event with the final response', async () => {
    await loop.run('Hello world', context);

    expect(onEvent).toHaveBeenCalledWith({ type: 'done', finalResponse: 'Final answer' });
  });

  it('records the user and assistant messages in the conversation', async () => {
    await loop.run('Hello world', context);

    expect(loop.getConversation()).toEqual([
      { role: 'user', content: 'Hello world' },
      { role: 'assistant', content: 'Final answer' },
    ]);
  });

  it('submits the prompt to the runtime with session context', async () => {
    await loop.run('Hello world', context);

    expect(client.call).toHaveBeenCalledWith(
      'prompt.submit',
      expect.objectContaining({ message: 'Hello world', sessionId: 'conv-1' })
    );
  });

  it('returns to IDLE and stops running after a run completes', async () => {
    expect(loop.currentState).toBe(AgentState.IDLE);
    await loop.run('Hello world', context);

    expect(loop.currentState).toBe(AgentState.IDLE);
    expect(loop.running).toBe(false);
  });
});