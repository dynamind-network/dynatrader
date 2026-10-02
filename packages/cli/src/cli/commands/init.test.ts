import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatInitCredentialPresence, loadInitExchangeContext, validateInitAnswers, writeConfigYaml } from './init';

const tempDirs: string[] = [];
const answers = {
  exchange: 'binance', tradingMode: 'paper', riskLevel: 'conservative',
  modelProvider: 'openai', modelName: 'gpt-4o-mini', enableTelegram: false, enableDiscord: false,
};
async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dynatrader-init-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe('init validation', () => {
  it('configured exchange IDs override answer and environment fallback', async () => {
    const dir = await workspace();
    await writeFile(join(dir, 'config.yaml'), 'exchange:\n  ids: [binance, kraken]\n');
    const env = { EXCHANGE_ID: 'coinbase', EXCHANGE_API_KEY: 'key', EXCHANGE_SECRET: 'secret' };
    const context = await loadInitExchangeContext(dir, { ...answers, exchange: 'kraken' }, env);
    expect(context).toEqual({ exchangeId: 'binance', exchangeIds: ['binance', 'kraken'] });
    expect(formatInitCredentialPresence(context.exchangeId, env, context.exchangeIds).some((status) => status.includes('generic'))).toBe(false);
  }, 15_000);
  it('preserves non-empty configured IDs while filtering whitespace-only entries', async () => {
    const dir = await workspace();
    await writeFile(join(dir, 'config.yaml'), 'exchange:\n  ids: ["  binance  ", "   ", kraken]\n');
    expect(await loadInitExchangeContext(dir, answers, {})).toEqual({ exchangeId: 'binance', exchangeIds: ['  binance  ', 'kraken'] });
  });
  it('uses configured workspace IDs unchanged for validation and credential status', async () => {
    const dir = await workspace();
    await writeFile(join(dir, 'config.yaml'), 'exchange:\n  ids: [binance, kraken]\n');
    const context = await loadInitExchangeContext(dir, answers, { EXCHANGE_API_KEY: 'key', EXCHANGE_SECRET: 'secret' });
    expect(context).toEqual({ exchangeId: 'binance', exchangeIds: ['binance', 'kraken'] });
    expect(validateInitAnswers({ ...answers, tradingMode: 'live' }, { EXCHANGE_API_KEY: 'key', EXCHANGE_SECRET: 'secret' }, context.exchangeIds).some((issue) => issue.level === 'error')).toBe(true);
    expect(formatInitCredentialPresence(context.exchangeId, { EXCHANGE_API_KEY: 'key', EXCHANGE_SECRET: 'secret' }, context.exchangeIds).some((status) => status.includes('generic'))).toBe(false);
  });
  it('falls back to selected answer or EXCHANGE_ID when workspace IDs are missing or empty', async () => {
    const dir = await workspace();
    await writeFile(join(dir, 'config.yaml'), 'exchange:\n  ids: []\n');
    expect(await loadInitExchangeContext(dir, answers, {})).toEqual({ exchangeId: 'binance', exchangeIds: ['binance'] });
    expect(await loadInitExchangeContext(dir, { ...answers, exchange: '' }, { EXCHANGE_ID: 'kraken' })).toEqual({ exchangeId: 'kraken', exchangeIds: ['kraken'] });
  });
  it('falls back when exchange section is null', async () => {
    const dir = await workspace();
    await writeFile(join(dir, 'config.yaml'), 'exchange: null\n');
    expect(await loadInitExchangeContext(dir, answers, {})).toEqual({ exchangeId: 'binance', exchangeIds: ['binance'] });
    expect(await loadInitExchangeContext(dir, { ...answers, exchange: '' }, { EXCHANGE_ID: 'kraken' })).toEqual({ exchangeId: 'kraken', exchangeIds: ['kraken'] });
  });
  it('rejects timestamp YAML root before using init context', async () => {
    const dir = await workspace();
    await writeFile(join(dir, 'config.yaml'), '2026-09-28\n');
    await expect(loadInitExchangeContext(dir, answers, {})).rejects.toThrow(/Invalid workspace config root/);
  });
  it.each([
    ['scalar workspace', 'workspace: oops\\n'],
    ['sequence workspace', 'workspace:\n  - oops\n'],
    ['scalar runtime', 'runtime: oops\\n'],
    ['sequence runtime', 'runtime:\n  - oops\n'],
    ['scalar models', 'models: oops\\n'],
    ['sequence models', 'models:\n  - oops\n'],
  ])('rejects %s before using init context', async (_shape, config) => {
    const dir = await workspace();
    await writeFile(join(dir, 'config.yaml'), config);
    await expect(loadInitExchangeContext(dir, answers, {})).rejects.toThrow(/Invalid workspace (workspace|runtime|models) config/);
  });
  it.each([
    ['null workspace', 'workspace: null\n'],
    ['absent workspace', 'exchange: null\n'],
    ['null runtime', 'runtime: null\n'],
    ['null models', 'models: null\n'],
  ])('supports %s when loading init context', async (_shape, config) => {
    const dir = await workspace();
    await writeFile(join(dir, 'config.yaml'), config);
    await expect(loadInitExchangeContext(dir, answers, {})).resolves.toEqual({ exchangeId: 'binance', exchangeIds: ['binance'] });
  });
  it('fails closed on malformed existing config', async () => {
    const dir = await workspace();
    await writeFile(join(dir, 'config.yaml'), 'exchange: [broken\n');
    await expect(loadInitExchangeContext(dir, answers, { EXCHANGE_API_KEY: 'key', EXCHANGE_SECRET: 'secret' })).rejects.toThrow();
  });
  it('names missing live venue credentials from the injected environment', () => {
    const issues = validateInitAnswers({ ...answers, tradingMode: 'live' }, {});
    expect(issues.some((issue) => issue.level === 'error' && issue.detail.includes('BINANCE_API_KEY') && issue.detail.includes('BINANCE_SECRET'))).toBe(true);
  });
  it('requires an exchange when neither answers nor EXCHANGE_ID provides one', () => {
    const issues = validateInitAnswers({ ...answers, exchange: '', tradingMode: 'live' }, {});
    expect(issues.some((issue) => issue.level === 'error' && issue.title.includes('Exchange is required'))).toBe(true);
  });
  it('does not accept generic aliases for a configured multi-exchange set', () => {
    const env = { EXCHANGE_API_KEY: 'key', EXCHANGE_SECRET: 'secret' };
    expect(validateInitAnswers({ ...answers, tradingMode: 'live' }, env, ['binance', 'kraken']).some((issue) => issue.level === 'error')).toBe(true);
  });
  it('accepts generic aliases for a configured single-exchange set', () => {
    const env = { EXCHANGE_API_KEY: 'key', EXCHANGE_SECRET: 'secret' };
    expect(validateInitAnswers({ ...answers, tradingMode: 'live' }, env, ['binance']).some((issue) => issue.level === 'error')).toBe(false);
  });
  it('configured IDs take precedence over EXCHANGE_ID in credential status', () => {
    const status = formatInitCredentialPresence('', { EXCHANGE_ID: 'coinbase' }, ['binance', 'kraken']);
    expect(status).toContain('BINANCE_API_KEY=[missing]');
    expect(status).not.toContain('COINBASE_API_KEY=[missing]');
  });
  it('does not warn about shadow target when an effective environment venue exists', () => {
    const issues = validateInitAnswers({ ...answers, exchange: '', tradingMode: 'shadow' }, { EXCHANGE_ID: 'binance' });
    expect(issues.some((issue) => issue.title.includes('Shadow mode still needs'))).toBe(false);
  });
  it('does not warn about shadow target when configured IDs exist', () => {
    const issues = validateInitAnswers({ ...answers, exchange: '', tradingMode: 'shadow' }, {}, ['binance', 'kraken']);
    expect(issues.some((issue) => issue.title.includes('Shadow mode still needs'))).toBe(false);
  });
  it('uses EXCHANGE_ID fallback venue in credential status', () => {
    const status = formatInitCredentialPresence('', { EXCHANGE_ID: 'binance' });
    expect(status).toContain('BINANCE_API_KEY=[missing]');
    expect(status).toContain('BINANCE_SECRET=[missing]');
  });
  it('uses EXCHANGE_ID fallback venue for credential validation', () => {
    const issues = validateInitAnswers({ ...answers, exchange: '', tradingMode: 'live' }, { EXCHANGE_ID: 'binance' });
    expect(issues.some((issue) => issue.level === 'error' && issue.detail.includes('BINANCE_API_KEY') && issue.detail.includes('BINANCE_SECRET'))).toBe(true);
  });
  it.each(['paper', 'backtest', 'shadow'])('does not require live credentials in %s mode', (tradingMode) => {
    expect(validateInitAnswers({ ...answers, tradingMode }, {}).some((issue) => issue.level === 'error')).toBe(false);
  });
  it('warns when model configuration is still blank', () => {
    const issues = validateInitAnswers({ ...answers, modelProvider: '', modelName: '' });
    expect(issues.some((issue) => issue.level === 'warning' && issue.title.includes('Model provider'))).toBe(true);
    expect(issues.some((issue) => issue.level === 'warning' && issue.title.includes('Model name'))).toBe(true);
  });
});

describe('init config writer', () => {
  it('uses first configured exchange ID when answer is blank and preserves IDs', async () => {
    const dir = await workspace();
    const path = join(dir, 'config.yaml');
    await writeFile(path, 'exchange:\n  ids: [binance, kraken]\n');
    await writeConfigYaml(dir, { ...answers, exchange: '' });
    const content = await readFile(path, 'utf8');
    expect(content).toContain('id: binance');
    expect(content).toContain('ids:\n    - binance\n    - kraken');
  });
  it('refuses legacy credentials without changing original bytes', async () => {
    const dir = await workspace();
    const path = join(dir, 'config.yaml');
    const original = 'exchange:\n  id: binance\n  apiKey: sentinel-api-key\n  secret: sentinel-secret\n';
    await writeFile(path, original);
    await expect(writeConfigYaml(dir, answers)).rejects.toThrow(/apiKey.*secret.*manually/i);
    expect(await readFile(path, 'utf8')).toBe(original);
  });
  it('refuses nested legacy credentials only inside exchange without changing original bytes', async () => {
    const dir = await workspace();
    const path = join(dir, 'config.yaml');
    const original = 'exchange:\n  id: binance\n  auth:\n    apiKey: nested-sentinel-key\n  credentials:\n    secret: nested-sentinel-secret\nmodels:\n  apiKey: unrelated-sentinel\n';
    await writeFile(path, original);
    await expect(writeConfigYaml(dir, answers)).rejects.toThrow(/apiKey.*secret.*manually/i);
    expect(await readFile(path, 'utf8')).toBe(original);
  });
  it.each(['privateKey', 'accessToken', 'sessionToken', 'passphrase'])('refuses exchange %s without changing original bytes', async (key) => {
    const dir = await workspace();
    const path = join(dir, 'config.yaml');
    const original = `exchange:\n  auth:\n    ${key}: nested-sentinel-value\n`;
    await writeFile(path, original);
    await expect(writeConfigYaml(dir, answers)).rejects.toThrow(new RegExp(`${key}.*manually`, 'i'));
    expect(await readFile(path, 'utf8')).toBe(original);
  });
  it('ignores model credential-like keys outside exchange and writes config', async () => {
    const dir = await workspace();
    const path = join(dir, 'config.yaml');
    await writeFile(path, 'models:\n  apiKey: synthetic-model-key\n  secret: synthetic-model-secret\n');

    await expect(writeConfigYaml(dir, answers)).resolves.toBeUndefined();
    const content = await readFile(path, 'utf8');
    expect(content).toContain('apiKey: synthetic-model-key');
    expect(content).toContain('secret: synthetic-model-secret');
    expect(content).toContain('id: binance');
    expect(content).toContain('provider: openai');
  });
  it('writes clean config without credential fields', async () => {
    const dir = await workspace();
    await writeConfigYaml(dir, answers);
    const content = await readFile(join(dir, 'config.yaml'), 'utf8');
    expect(content).not.toMatch(/^\s*(apiKey|secret):/m);
    expect(content).toContain('id: binance');
  });
  it.each([
    ['scalar root', 'hello\n'],
    ['sequence root', '- one\n- two\n'],
    ['timestamp root', '2026-09-28\n'],
    ['scalar exchange', 'exchange: hello\n'],
    ['sequence exchange', 'exchange:\n  - one\n'],
    ['scalar workspace', 'workspace: oops\n'],
    ['sequence workspace', 'workspace:\n  - oops\n'],
    ['scalar runtime', 'runtime: oops\n'],
    ['sequence runtime', 'runtime:\n  - oops\n'],
    ['scalar models', 'models: oops\n'],
    ['sequence models', 'models:\n  - oops\n'],
  ])('refuses %s YAML without changing original bytes', async (_shape, original) => {
    const dir = await workspace();
    const path = join(dir, 'config.yaml');
    await writeFile(path, original);
    await expect(writeConfigYaml(dir, answers)).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe(original);
  });
  it('preserves malformed existing config bytes and rejects instead of replacing it', async () => {
    const dir = await workspace();
    const path = join(dir, 'config.yaml');
    const original = 'exchange: [broken\n';
    await writeFile(path, original);
    await expect(writeConfigYaml(dir, answers)).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe(original);
  });
  it('does not revisit aliased exchange objects while scanning for legacy credentials', async () => {
    const dir = await workspace();
    await writeFile(join(dir, 'config.yaml'), `exchange: &exchange\n  id: binance\n  self: *exchange\n  apiKey: synthetic-cycle-key\n`);
    await expect(writeConfigYaml(dir, answers)).rejects.toThrow(/apiKey.*manually/i);
  });
});
