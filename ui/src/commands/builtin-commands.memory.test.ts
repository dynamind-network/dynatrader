import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCommandRegistry, registerBuiltinCommands } from './index.js';

describe('/memory command', () => {
  afterEach(() => getCommandRegistry().clear());

  it('searches persistent runtime memory in its default scope', async () => {
    registerBuiltinCommands();
    const onMemorySearch = vi.fn().mockResolvedValue({
      count: 1,
      scope: 'agent_memory',
      query: 'risk limit',
      results: [{ id: 'mem-1', score: 0.9, timestamp: '2026-09-29T10:00:00.000Z', payload: { text: 'Risk limit is 5%' } }],
    });
    const command = getCommandRegistry().get('memory')!;
    const output = await command.handler('search risk limit', { cwd: process.cwd(), onMessage: vi.fn(), onMemorySearch });
    expect(onMemorySearch).toHaveBeenCalledWith('agent_memory', 'risk limit');
    expect(output).toContain('Risk limit is 5%');
  });

  it('writes entries to the runtime memory store', async () => {
    registerBuiltinCommands();
    const onMemoryWrite = vi.fn().mockResolvedValue({ id: 'mem-2', scope: 'project', kind: 'decision' });
    const command = getCommandRegistry().get('memory')!;
    const output = await command.handler('add project decision Keep the risk gate', {
      cwd: process.cwd(), onMessage: vi.fn(), onMemoryWrite,
    });
    expect(onMemoryWrite).toHaveBeenCalledWith({
      scope: 'project', kind: 'decision', payload: { text: 'Keep the risk gate' }, summary: 'Keep the risk gate',
    });
    expect(output).toContain('mem-2');
  });
});
