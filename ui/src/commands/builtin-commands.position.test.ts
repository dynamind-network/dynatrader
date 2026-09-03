import { describe, it, expect, beforeEach } from 'vitest';
import { registerBuiltinCommands } from './builtin-commands.js';
import { getCommandRegistry } from './command-registry.js';
import type { CommandContext } from './command-registry.js';

describe('/position command', () => {
  beforeEach(() => {
    getCommandRegistry().clear();
    registerBuiltinCommands();
  });

  it('returns usage message when no symbol provided', async () => {
    const registry = getCommandRegistry();
    const context: CommandContext = {
      cwd: '/test',
      onMessage: () => {},
    };

    const result = await registry.execute('position', '', context);
    expect(typeof result === 'string' ? result : result.content).toContain('Usage: /position <symbol>');
  });

  it('returns "No position found" when position does not exist', async () => {
    const registry = getCommandRegistry();
    const context: CommandContext = {
      cwd: '/test',
      onMessage: () => {},
    };

    const result = await registry.execute('position', 'BTC', context);
    expect(typeof result === 'string' ? result : result.content).toBe('No position found for BTC');
  });

  it('returns position card artifact when position exists', async () => {
    const registry = getCommandRegistry();
    const mockPosition = {
      symbol: 'BTC',
      side: 'long' as const,
      size: 1.5,
      entryPrice: 45000,
      currentPrice: 47000,
      pnl: 3000,
      pnlPercent: 6.67,
      leverage: 10,
      liquidationPrice: 40500,
    };

    const context: CommandContext = {
      cwd: '/test',
      getPosition: () => mockPosition,
      onMessage: () => {},
    };

    const result = await registry.execute('position', 'BTC', context);
    expect(typeof result).toBe('object');
    if (typeof result === 'string') {
      throw new Error('Expected object result');
    }
    expect(result.content).toBe('Position for BTC');
    expect(result.artifact.kind).toBe('position-card');
    expect(result.artifact.symbol).toBe('BTC');
    expect(result.artifact.side).toBe('long');
    expect(result.artifact.size).toBe(1.5);
  });
});
