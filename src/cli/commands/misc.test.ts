import { afterEach, describe, expect, it, vi } from 'vitest';
import packageJson from '../../../package.json';
import { cmdVersion } from './misc';

describe('cmdVersion', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports the version declared by the package', () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      output.push(args.join(' '));
    });

    cmdVersion('/tmp/dynatrader-workspace');

    expect(output.join('\n')).toContain(`DynaTrader v${packageJson.version}`);
  });
});
