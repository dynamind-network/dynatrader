import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMarketDataProvider } from './market-data.js';

afterEach(() => vi.unstubAllGlobals());

describe('DynaMind market data provider', () => {
  it('reports request source, endpoint, and bounded timeout duration', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new DOMException('The operation was aborted', 'TimeoutError');
    }));
    const provider = createMarketDataProvider({ baseUrl: 'https://api.example.test', timeoutMs: 60_000 });

    await expect(provider.getPrice('BTC/USDT')).rejects.toThrow(
      'DynaMind API request timed out after 25000ms (/api/v1/price/BTC%2FUSDT)',
    );
  });
});
