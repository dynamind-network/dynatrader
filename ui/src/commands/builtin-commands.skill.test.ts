import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registerBuiltinCommands } from './builtin-commands.js';
import { getCommandRegistry } from './command-registry.js';
import type { CommandContext } from './command-registry.js';

describe('/skill command', () => {
  beforeEach(() => {
    getCommandRegistry().clear();
    registerBuiltinCommands();
  });

  it('creates a generic skill scaffold without hardcoded persona text', async () => {
    const registry = getCommandRegistry();
    const createSkillDirectory = vi.fn().mockResolvedValue('/tmp/market-scout');
    const context: CommandContext = {
      cwd: '/test',
      onMessage: () => {},
      skillManager: {
        getSkill: vi.fn().mockReturnValue(undefined),
        createSkillDirectory,
      } as any,
    };

    const result = await registry.execute('skill', 'create market-scout', context);

    expect(createSkillDirectory).toHaveBeenCalledWith(
      'market-scout',
      'Skill for market-scout',
      expect.stringContaining('Describe the reusable workflow here.')
    );
    expect(createSkillDirectory).toHaveBeenCalledWith(
      'market-scout',
      expect.any(String),
      expect.not.stringContaining('specialist')
    );
    expect(typeof result === 'string' ? result : result.content).toContain(
      'Created skill "market-scout"'
    );
  });
});
