import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCommandRegistry, registerBuiltinCommands } from './index.js';
import type { CommandContext } from './command-registry.js';

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    cwd: process.cwd(),
    onMessage: vi.fn(),
    ...overrides,
  };
}

describe('/goal command', () => {
  beforeEach(() => {
    getCommandRegistry().clear();
    registerBuiltinCommands();
  });

  it('awaits persistent operations before reporting success', async () => {
    const calls: string[] = [];
    const ctx = context({
      onGoalSet: async (objective) => { await Promise.resolve(); calls.push(`set:${objective}`); },
      onGoalPause: async () => { await Promise.resolve(); calls.push('pause'); },
      onGoalResume: async () => { await Promise.resolve(); calls.push('resume'); },
      onGoalComplete: async () => { await Promise.resolve(); calls.push('complete'); },
      onGoalClear: async () => { await Promise.resolve(); calls.push('clear'); },
    });
    const registry = getCommandRegistry();

    await expect(registry.execute('goal', 'set Ship release', ctx)).resolves.toBe('Goal set: "Ship release"');
    await expect(registry.execute('goal', 'pause', ctx)).resolves.toBe('Goal paused.');
    await expect(registry.execute('goal', 'resume', ctx)).resolves.toBe('Goal resumed.');
    await expect(registry.execute('goal', 'complete', ctx)).resolves.toBe('Goal marked as complete.');
    await expect(registry.execute('goal', 'clear', ctx)).resolves.toBe('Goal cleared.');
    expect(calls).toEqual(['set:Ship release', 'pause', 'resume', 'complete', 'clear']);
  });

  it('shows the current goal and never reports success when an operation is unavailable or fails', async () => {
    const registry = getCommandRegistry();
    const goal = { objective: 'Ship release', status: 'active', progress: { stepsCompleted: 1, totalSteps: 3 } };
    await expect(registry.execute('goal', 'status', context({ onGoalGet: async () => goal })))
      .resolves.toContain('Active goal: "Ship release"');
    await expect(registry.execute('goal', 'set Ship release', context()))
      .resolves.toContain('unavailable');
    await expect(registry.execute('goal', 'pause', context({ onGoalPause: () => { throw new Error('storage failed'); } })))
      .resolves.toBe('Command /goal failed: storage failed');
  });
});
