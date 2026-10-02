import { describe, expect, it } from 'vitest';
import { bundledRows, composePluginRows } from './composition';

describe('plugin composition', () => {
  it('applies ordered overrides and disabled tombstones', () => {
    const rows = composePluginRows(
      [
        [{ id: 'alpha', entry: 'first', config: { limit: 1 } }],
        [{ id: 'alpha', entry: 'second', config: { limit: 2 } }],
        [{ id: 'alpha', entry: 'disabled', enabled: false }],
      ],
      ['builtin', 'config', 'config'],
    );

    expect(rows).toEqual([]);
  });

  it('uses the hosted first-party API by default, with optional authentication', () => {
    expect(bundledRows({})).toEqual([
      expect.objectContaining({
        id: 'dynamind-api',
        entry: 'bundled:dynamind-api',
        config: { baseUrl: 'https://api.dynamind.network' },
      }),
    ]);
    expect(bundledRows({ DYNAMIND_API_KEY: 'test-key' })).toEqual([
      expect.objectContaining({
        id: 'dynamind-api',
        entry: 'bundled:dynamind-api',
        config: { baseUrl: 'https://api.dynamind.network', apiKey: 'test-key' },
      }),
    ]);
  });

  it('allows an explicit compatible API endpoint override', () => {
    expect(bundledRows({ DYNAMIND_API_URL: 'https://api.example.test' })).toEqual([
      expect.objectContaining({
        id: 'dynamind-api',
        config: { baseUrl: 'https://api.example.test' },
      }),
    ]);
  });

  it('allows users to disable the bundled provider or replace it in plugin config', () => {
    expect(composePluginRows(
      [bundledRows({}), [{ id: 'dynamind-api', entry: 'disabled', enabled: false }]],
      ['bundled', 'config'],
    )).toEqual([]);

    expect(composePluginRows(
      [bundledRows({}), [{ id: 'dynamind-api', entry: 'my-compatible-api', config: { baseUrl: 'https://api.example.test' } }]],
      ['bundled', 'config'],
    )).toEqual([
      expect.objectContaining({
        id: 'dynamind-api',
        entry: 'my-compatible-api',
        config: { baseUrl: 'https://api.example.test' },
      }),
    ]);
  });
});
