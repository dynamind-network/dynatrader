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

  it('only enables the bundled API when configured', () => {
    expect(bundledRows({})).toEqual([]);
    expect(bundledRows({ DYNAMIND_API_URL: 'https://api.example.test' })).toEqual([
      expect.objectContaining({
        id: 'dynamind-api',
        entry: 'bundled:dynamind-api',
        config: { baseUrl: 'https://api.example.test' },
      }),
    ]);
  });
});
