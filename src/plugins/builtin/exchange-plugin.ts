import type { ExchangeAdapter } from '../../types';
import { createExchangeAdapter } from '../../market/exchange/exchange-factory';
import type { DynaPlugin, MarketDataProvider } from '../types';

function createMarketDataProvider(exchange: ExchangeAdapter): MarketDataProvider {
  return {
    async fetchUniverse() {
      const markets = await exchange.fetchMarkets();
      return Object.keys(markets);
    },
    async getPrice(symbol) {
      const candles = await exchange.fetchOHLCV({ symbol, timeframe: '1m', limit: 1 });
      const close = candles.at(-1)?.[4];
      if (typeof close !== 'number') throw new Error(`No price available for ${symbol}`);
      return close;
    },
    async getOHLCV(symbol, timeframe, limit = 120) {
      return (await exchange.fetchOHLCV({ symbol, timeframe, limit })).map(([timestamp, open, high, low, close, volume]) => ({ timestamp, open, high, low, close, volume }));
    },
    async getOrderBook() { return { bids: [], asks: [], timestamp: Date.now() }; },
    async get24hVolume() { return 0; },
  };
}

export function createExchangePlugin(config: Record<string, unknown>): DynaPlugin {
  const auth = (config.auth as Record<string, unknown> | undefined) ?? {};
  const exchange = createExchangeAdapter({
    mode: config.mode as string | undefined,
    exchangeId: config.exchangeId as string | undefined,
    adapterName: config.adapterName as string | undefined,
    auth,
  });
  if (!exchange) throw new Error('No exchange configured for builtin exchange plugin');
  const marketData = createMarketDataProvider(exchange);
  return {
    id: 'exchange',
    version: '1.0.0',
    description: 'Builtin exchange adapter and offline-capable market data provider',
    capabilities: ['exchange', 'market_data'],
    init(ctx) {
      ctx.registerService('exchange', exchange);
      ctx.registerService('market_data', marketData);
    },
  };
}

export default createExchangePlugin;
