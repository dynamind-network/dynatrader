import { describe, expect, it, vi } from 'vitest';
import { AgentLoop } from '../src/core/agent-loop.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { ShellTool } from '../src/tools/shell.js';

class FakeRpcClient {
  handlers = new Map<string, Array<(params: unknown) => void>>();
  call = vi.fn(async (method: string) => {
    if (method === 'conversation.compact') {
      return { compacted: true, message: 'Compacted 12 messages.', messageCount: 4 };
    }
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

describe('shell context budget', () => {
  it('truncates model-facing shell output with a narrowing hint', () => {
    const tool = new ShellTool();
    const noisyOutput = Array.from({ length: 80 }, (_, index) => `line-${index + 1}`).join('\n');

    const result = (tool as any).formatStream(noisyOutput, 10, 200);

    expect(result.truncated).toBe(true);
    expect(result.text).toContain('output truncated; rerun with a narrower command if needed');
    expect(result.text).not.toContain('line-80');
  });
});

describe('tool outcome fallback preference', () => {
  it('prefers a successful file-tool summary over shell output', () => {
    const client = new FakeRpcClient();
    const loop = new AgentLoop(
      { deepseek: 'test-key' },
      {
        model: 'deepseek-chat',
        systemPrompt: 'Test prompt',
        maxTokens: 512,
        maxTurns: 4,
        tools: [],
      },
      new ToolRegistry(),
      { rpcClient: client }
    );

    client.emit('tool.start', {
      toolCallId: 'shell-1',
      toolName: 'shell',
      args: { command: 'pwd' },
    });
    client.emit('tool.complete', {
      toolCallId: 'shell-1',
      toolName: 'shell',
      result: { success: true, output: '$ pwd\nExit code: 0\nSTDOUT:\n/workspace' },
      durationMs: 5,
      success: true,
    });

    client.emit('tool.start', {
      toolCallId: 'write-1',
      toolName: 'write',
      args: { path: 'btc-tracker.html' },
    });
    client.emit('tool.complete', {
      toolCallId: 'write-1',
      toolName: 'write',
      result: 'Created file btc-tracker.html',
      durationMs: 5,
      success: true,
    });

    const ledger = loop.getToolExecutionLedger();
    expect(ledger.map((record) => record.toolName)).toEqual(['shell', 'write']);
    // The noisy shell episode is retained in the ledger…
    expect(ledger[0].result.output).toContain('Exit code: 0');
    // …but the successful file-tool summary is the preserved outcome.
    expect(ledger[1].status).toBe('success');
    expect(ledger[1].result.output).toBe('Created file btc-tracker.html');
    expect(loop.getSessionStats()).toMatchObject({ totalToolCalls: 2, failedToolCalls: 0 });
  });
});
