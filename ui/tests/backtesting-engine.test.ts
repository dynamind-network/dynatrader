import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BacktestingEngineTool } from '../src/tools/backtesting-engine.js';

function createTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dynamind-backtest-home-'));
}

describe('BacktestingEngineTool', () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  afterEach(() => {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
  });

  it('resolves workspace strategy aliases without code-owned naming', async () => {
    const home = createTempHome();
    process.env.HOME = home;
    process.env.USERPROFILE = home;

    const dynamindDir = path.join(home, '.dynamind');
    fs.mkdirSync(dynamindDir, { recursive: true });
    fs.writeFileSync(
      path.join(dynamindDir, 'config.json'),
      JSON.stringify({
        strategyEngines: {
          breakout: 'momentum',
        },
      }),
      'utf-8'
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        [0, '1', '1', '1', '1', '1', 0, '1'],
        [1, '1', '2', '1', '2', '1', 0, '1'],
        [2, '2', '3', '2', '3', '1', 0, '1'],
        [3, '3', '4', '3', '4', '1', 0, '1'],
        [4, '4', '5', '4', '5', '1', 0, '1'],
        [5, '5', '6', '5', '6', '1', 0, '1'],
      ],
    } as Response);

    try {
      const tool = new BacktestingEngineTool();
      const result = await tool.execute(
        { symbol: 'TEST', strategy: 'breakout', position_size: 0.1, leverage: 1 },
        {} as any
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('MOMENTUM');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
