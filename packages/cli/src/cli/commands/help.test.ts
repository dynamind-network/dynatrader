import { describe, expect, it } from 'vitest';
import { CLI_COMMANDS, getCompletionScript } from './help';

describe('CLI help and completion metadata', () => {
  it('includes implemented session and shell completion commands', () => {
    expect(CLI_COMMANDS.map((command) => command.name)).toContain('sessions');
    expect(CLI_COMMANDS.map((command) => command.name)).toContain('completion');
    expect(CLI_COMMANDS.find((command) => command.name === 'sessions')?.subcommands).toEqual(expect.arrayContaining([
      expect.stringContaining('list'), expect.stringContaining('show'), expect.stringContaining('export'),
    ]));
  });

  it.each(['bash', 'zsh', 'powershell'])('generates a %s completion script from the command catalog', (shell) => {
    const script = getCompletionScript(shell);
    expect(script).toContain('dynatrader');
    expect(script).toContain('sessions');
    expect(script).toContain('completion');
  });

  it('rejects unsupported completion shells', () => {
    expect(() => getCompletionScript('fish')).toThrow(/Unsupported shell/);
  });
});
