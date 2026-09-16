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
  const configuredIds = Array.isArray(config.exchangeIds)
    ? config.exchangeIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : [];
  const exchangeIds = configuredIds.length > 0
    ? configuredIds
    : [config.exchangeId as string | undefined, config.adapterName as string | undefined].filter(
      (id, index, ids): id is string => typeof id === 'string' && id.trim().length > 0 && ids.indexOf(id) === index,
    );
  const adapters = new Map<string, ExchangeAdapter>();
  for (const exchangeId of exchangeIds.length > 0 ? exchangeIds : [undefined]) {
    const adapter = createExchangeAdapter({
      mode: config.mode as string | undefined,
      exchangeId,
      adapterName: config.adapterName as string | undefined,
      auth,
    });
    if (adapter) adapters.set(adapter.id, adapter);
  }
  const exchange = adapters.values().next().value as ExchangeAdapter | undefined;
  if (!exchange) throw new Error('No exchange configured for builtin exchange plugin');
  const marketData = createMarketDataProvider(exchange);
  return {
    id: 'exchange',
    version: '1.0.0',
    description: 'Builtin exchange adapter and offline-capable market data provider',
    capabilities: ['exchange', 'exchange_adapters', 'market_data'],
    init(ctx) {
      ctx.registerService('exchange', exchange);
      ctx.registerService('exchange_adapters', adapters);
      ctx.registerService('market_data', marketData);
    },
  };
}

export default createExchangePlugin;
