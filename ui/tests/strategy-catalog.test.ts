import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

function createTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dynamind-home-'));
}

describe('strategy catalog', () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  afterEach(() => {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
  });

  it('loads workspace strategy templates from the user config directory', async () => {
    const home = createTempHome();
    process.env.HOME = home;
    process.env.USERPROFILE = home;

    const strategyDir = path.join(home, '.dynamind', 'strategy-templates');
    fs.mkdirSync(strategyDir, { recursive: true });
    fs.writeFileSync(
      path.join(strategyDir, 'trend.json'),
      JSON.stringify({
        id: 'trend',
        name: 'Trend Follow',
        category: 'trend-following',
        backtest: { engine: 'momentum' },
      }),
      'utf-8'
    );
    fs.writeFileSync(path.join(strategyDir, 'invalid.json'), JSON.stringify({ name: '' }), 'utf-8');
    fs.writeFileSync(
      path.join(home, '.dynamind', 'config.json'),
      JSON.stringify({
        strategyEngines: {
          trend: 'momentum',
          alt_trend: 'rsi_breakout',
        },
      }),
      'utf-8'
    );

    const { listWorkspaceStrategyTemplatesSync, resolveWorkspaceBacktestEngine } =
      await import('../src/tools/strategy-catalog.js');
    const templates = listWorkspaceStrategyTemplatesSync();

    expect(templates).toHaveLength(1);
    expect(templates[0]?.id).toBe('trend');
    expect(templates[0]?.name).toBe('Trend Follow');
    expect(resolveWorkspaceBacktestEngine('trend')).toBe('momentum');
    expect(resolveWorkspaceBacktestEngine('alt_trend')).toBe('rsi_breakout');
  });
});
