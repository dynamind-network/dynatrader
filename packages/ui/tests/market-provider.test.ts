import { describe, expect, it } from 'vitest';
import { initProviders } from '../src/config/providers.js';
import {
  buildMarketUrl,
  getMarketDepthPath,
  getMarketKlinesPath,
  getMarketTicker24hrPath,
  getMarketTickerPricePath,
} from '../src/config/market-provider.js';

describe('market provider helper', () => {
  it('builds URLs from the configured market provider', () => {
    initProviders({
      market: {
        rest: 'https://api.binance.com/api',
        klines: '/candles',
        ticker24hr: '/tickers',
        tickerPrice: '/price',
        depth: '/book',
      },
    });

    expect(getMarketKlinesPath()).toBe('/candles');
    expect(getMarketTicker24hrPath()).toBe('/tickers');
    expect(getMarketTickerPricePath()).toBe('/price');
    expect(getMarketDepthPath()).toBe('/book');
    expect(
      buildMarketUrl(getMarketKlinesPath(), { symbol: 'BTCUSDT', interval: '1h', limit: 24 })
    ).toBe('https://api.binance.com/api/candles?symbol=BTCUSDT&interval=1h&limit=24');
  });
});
