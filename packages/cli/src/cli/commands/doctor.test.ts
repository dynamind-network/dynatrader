import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkExchange, fixConfigStructure } from './doctor';

const workspaces: string[] = [];
const originalEnv = { ...process.env };

afterEach(async () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function workspace(config: Record<string, unknown>): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dynatrader-doctor-'));
  workspaces.push(path);
  await writeFile(join(path, 'config.yaml'), `exchange:\n${Object.entries(config.exchange as object ?? {}).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`).join('\n')}\nruntime:\n  mode: ${String((config.runtime as Record<string, unknown> | undefined)?.mode ?? 'paper')}\n`);
  return path;
}

function message(path: string): string {
  return checkExchange(path).checks.find((item) => item.name === 'API keys configured')!.message;
}

describe('doctor exchange credential diagnostics', () => {
  it('uses venue environment credentials and reports presence without values', async () => {
    const path = await workspace({ exchange: { id: 'binance' }, runtime: { mode: 'live' } });
    process.env.BINANCE_API_KEY = 'synthetic-secret-key';
    process.env.BINANCE_SECRET = 'synthetic-secret-value';
    expect(message(path)).toContain('keys found');
    expect(message(path)).not.toContain('synthetic-');
  }, 30_000);

  it('uses the first configured exchange.ids entry and not legacy config credential values', async () => {
    const path = await workspace({ exchange: { ids: ['binance', 'kraken'], apiKey: 'synthetic-config-key', secret: 'synthetic-config-secret' }, runtime: { mode: 'live' } });
    process.env.BINANCE_API_KEY = 'key';
    process.env.BINANCE_SECRET = 'secret';
    expect(message(path)).toContain('binance keys found');
    expect(message(path)).not.toContain('synthetic-');
  });

  it('uses EXCHANGE_ID when config has no exchange ID', async () => {
    const path = await workspace({ exchange: {}, runtime: { mode: 'live' } });
    process.env.EXCHANGE_ID = 'binance';
    process.env.BINANCE_API_KEY = 'key';
    process.env.BINANCE_SECRET = 'secret';
    expect(message(path)).toContain('binance keys found');
  });

  it('allows a null exchange section and uses EXCHANGE_ID in live mode', async () => {
    const path = await mkdtemp(join(tmpdir(), 'dynatrader-doctor-null-'));
    workspaces.push(path);
    await writeFile(join(path, 'config.yaml'), 'exchange:\nruntime:\n  mode: live\n');
    process.env.EXCHANGE_ID = 'binance';
    process.env.BINANCE_API_KEY = 'key';
    process.env.BINANCE_SECRET = 'secret';
    expect(message(path)).toContain('binance keys found');
  });

  it('accepts generic aliases only for singleton CCXT and ignores them for native or multi-venue', async () => {
    process.env.EXCHANGE_API_KEY = 'generic-key';
    process.env.EXCHANGE_SECRET = 'generic-secret';
    const single = await workspace({ exchange: { id: 'binance' }, runtime: { mode: 'live' } });
    expect(message(single)).toContain('keys found');
    const multi = await workspace({ exchange: { ids: ['binance', 'kraken'] }, runtime: { mode: 'live' } });
    expect(message(multi)).toContain('keys missing');
    const native = await workspace({ exchange: { id: 'hyperliquid' }, runtime: { mode: 'live' } });
    expect(message(native)).toContain('keys missing');
  });

  it('fails closed when a live mode has no effective venue ID', async () => {
    const path = await workspace({ exchange: {}, runtime: { mode: 'live' } });
    process.env.BINANCE_API_KEY = 'key';
    process.env.BINANCE_SECRET = 'secret';
    expect(checkExchange(path).checks.find((item) => item.name === 'API keys configured')).toMatchObject({
      ok: false,
      message: expect.stringContaining('EXCHANGE_ID'),
    });
  });

  it.each(['paper', 'backtest', 'shadow', 'research'])('keeps credentials optional in %s mode', async (mode) => {
    const path = await workspace({ exchange: { id: 'binance' }, runtime: { mode } });
    expect(message(path)).toContain('keys optional');
  });

  it.each(['live', 'micro_live'])('requires environment credentials in %s mode', async (mode) => {
    const path = await workspace({ exchange: { id: 'binance', apiKey: 'synthetic-config-key', secret: 'synthetic-config-secret' }, runtime: { mode } });
    expect(message(path)).toContain('keys missing');
    expect(message(path)).not.toContain('synthetic-');
  });

  it.each([
    ['malformed YAML', 'exchange: [\nruntime:\n  mode: paper\n'],
    ['timestamp root', '2026-09-27T00:00:00.000Z'],
    ['invalid exchange shape', 'exchange: nope\nruntime:\n  mode: paper\n'],
    ['invalid workspace shape', 'exchange:\n  id: binance\nruntime:\n  mode: live\nworkspace: nope\n'],
  ])('fails closed with a config diagnostic for %s even with valid live credentials', async ([, contents]) => {
    const path = await mkdtemp(join(tmpdir(), 'dynatrader-doctor-invalid-'));
    workspaces.push(path);
    await writeFile(join(path, 'config.yaml'), contents);
    process.env.EXCHANGE_ID = 'binance';
    process.env.BINANCE_API_KEY = 'key';
    process.env.BINANCE_SECRET = 'secret';
    expect(checkExchange(path).checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'exchange config', ok: false, message: expect.stringMatching(/invalid|malformed|must be/) }),
      expect.objectContaining({ name: 'API keys configured', ok: false, message: expect.stringContaining('invalid config') }),
    ]));
  });

  it('does not synthesize legacy credential fields while fixing config structure', async () => {
    const path = await mkdtemp(join(tmpdir(), 'dynatrader-doctor-fix-'));
    workspaces.push(path);
    await writeFile(join(path, 'config.yaml'), 'exchange:\n  id: binance\n  custom: preserve-me\n');
    await fixConfigStructure(path, { exchange: { id: 'binance', custom: 'preserve-me' } });
    const fixed = await readFile(join(path, 'config.yaml'), 'utf-8');
    expect(fixed).toContain('preserve-me');
    expect(fixed).not.toMatch(/^\s*(apiKey|secret):/m);
  });
});
