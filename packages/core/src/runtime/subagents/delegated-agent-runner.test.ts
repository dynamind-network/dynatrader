import { describe, expect, it, vi } from 'vitest';
import { runDelegatedAgent } from './delegated-agent-runner';

describe('runDelegatedAgent', () => {
  it('runs a fresh child AgentCore chat with the resolved agent instructions and restricted tools', async () => {
    const read = { name: 'read' };
    const write = { name: 'write' };
    const chat = vi.fn(async (_message: string, _options: unknown) => ({ content: 'child result', usage: { totalTokens: 7 } }));
    const childCore = { chat };
    const core = {
      listAvailableTools: () => [read, write, { name: 'delegate_task' }, { name: 'agent_task_status' }],
      createRestrictedChild: vi.fn((_allowedTools: string[]) => childCore),
    };
    const manifest = {
      name: 'researcher',
      instructions: 'Research carefully.',
      profiles: ['base'],
      tools: { allow: ['read'], deny: [] },
    };
    const registry = { get: vi.fn(async () => manifest) };

    const result = await runDelegatedAgent(core as never, registry as never, [], {
      task: 'Find evidence',
      agent: 'researcher',
      context: { source: 'parent' },
    });

    expect(core.createRestrictedChild).toHaveBeenCalledWith(expect.arrayContaining(['read']));
    const allowed = core.createRestrictedChild.mock.calls[0][0];
    expect(allowed).toContain('read');
    expect(allowed).not.toContain('write');
    expect(allowed).not.toContain('delegate_task');
    expect(chat).toHaveBeenCalledWith(expect.stringContaining('Find evidence'), expect.objectContaining({
      systemInstructions: 'Research carefully.',
      sessionId: expect.stringMatching(/^subagent-researcher-/),
    }));
    expect(result).toMatchObject({ agent: 'researcher', content: 'child result', usage: { totalTokens: 7 } });
  });

  it('uses the configured manager when no agent name is specified', async () => {
    const manager = { name: 'main', type: 'manager', reportsTo: '', instructions: 'Lead.', profiles: ['base'], tools: { allow: [], deny: [] } };
    const core = {
      listAvailableTools: () => [{ name: 'read' }],
      createRestrictedChild: () => ({ chat: vi.fn(async () => ({ content: 'ok' })) }),
    };
    const registry = { getAll: vi.fn(async () => [manager]) };
    await expect(runDelegatedAgent(core as never, registry as never, [], { task: 'Do it' }))
      .resolves.toMatchObject({ agent: 'main', content: 'ok' });
  });

  it('resolves plugin declared tools through the shared profile capability map', async () => {
    const chat = vi.fn(async () => ({ content: 'ok' }));
    const core = {
      listAvailableTools: () => [{ name: 'read' }, { name: 'plugin_market_scan' }],
      createRestrictedChild: vi.fn(() => ({ chat })),
    };
    const manifest = { name: 'market-researcher', instructions: 'Research.', profiles: ['trading'], tools: { allow: ['*'], deny: [] } };
    const registry = { get: vi.fn(async () => manifest) };
    await runDelegatedAgent(core as never, registry as never, ['trading'], { task: 'scan', agent: manifest.name }, { trading: ['plugin_market_scan'] });

    expect(core.createRestrictedChild).toHaveBeenCalledWith(expect.arrayContaining(['plugin_market_scan']));
  });
});
