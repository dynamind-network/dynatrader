import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MCPBridge } from './mcp-bridge';
import type { MarketDataProvider, NewsProvider } from './types';

const { callMock } = vi.hoisted(() => ({ callMock: vi.fn() }));

vi.mock('../mcp/client', () => ({
  McpClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue([]),
    call: callMock,
    disconnect: vi.fn().mockResolvedValue(undefined),
  })),
}));

interface TestPlugin {
  init(context: { registerService(name: string, value: unknown): void }): void | Promise<void>;
}

function createBridge() {
  const services = new Map<string, unknown>();
  const registry = {
    register: vi.fn(async (plugin: TestPlugin) => {
      await plugin.init({ registerService: (name, value) => services.set(name, value) });
    }),
    unregister: vi.fn(async () => undefined),
  };
  return { bridge: new MCPBridge(registry as never), services };
}

async function connectMarketDataBridge() {
  const { bridge, services } = createBridge();
  await bridge.connect({
    name: 'quotes',
    transport: 'stdio',
    command: 'unused-in-test',
    capability: 'market_data',
    toolMapping: {
      methods: {
        fetchUniverse: 'fetch_universe',
        getPrice: 'get_price',
        getOHLCV: 'get_ohlcv',
        getOrderBook: 'get_orderbook',
        get24hVolume: 'get_24h_volume',
      },
    },
  });
  const marketData = services.get('market_data') as MarketDataProvider;
  return { bridge, marketData };
}

async function connectGenericBridge() {
  const { bridge, services } = createBridge();
  await bridge.connect({
    name: 'generic',
    transport: 'stdio',
    command: 'unused-in-test',
    capability: 'backtest',
    toolMapping: { methods: { run: 'run_backtest' } },
  });
  const provider = services.get('backtest') as {
    run(args: Record<string, unknown>): Promise<unknown>;
  };
  return { bridge, provider };
}

describe('MCPBridge result adaptation', () => {
  beforeEach(() => {
    callMock.mockReset();
    callMock.mockResolvedValue([{ type: 'text', text: JSON.stringify({ price: 42 }) }]);
  });

  it('rejects a universe response without symbols', async () => {
    callMock.mockResolvedValueOnce([{ type: 'text', text: JSON.stringify({ count: 4 }) }]);
    const { bridge, marketData } = await connectMarketDataBridge();

    try {
      await expect(marketData.fetchUniverse()).rejects.toThrow(
        'MCP market-data response must include a string array "symbols" field',
      );
    } finally {
      await bridge.disconnect('quotes');
    }
  });

  it('rejects a candle response without candles', async () => {
    callMock.mockResolvedValueOnce([{ type: 'text', text: JSON.stringify({ count: 4 }) }]);
    const { bridge, marketData } = await connectMarketDataBridge();

    try {
      await expect(marketData.getOHLCV('BTC/USDT', '1h')).rejects.toThrow(
        'MCP market-data response must include an array "candles" field',
      );
    } finally {
      await bridge.disconnect('quotes');
    }
  });

  it('rejects candles containing non-finite values', async () => {
    callMock.mockResolvedValueOnce([{
      type: 'text',
      text: JSON.stringify({ candles: [{ timestamp: 'bad', open: 1, high: 1, low: 1, close: 1, volume: 1 }] }),
    }]);
    const { bridge, marketData } = await connectMarketDataBridge();

    try {
      await expect(marketData.getOHLCV('BTC/USDT', '1h')).rejects.toThrow(
        'MCP market-data candle field "timestamp" must be finite',
      );
    } finally {
      await bridge.disconnect('quotes');
    }
  });

  it('converts numeric-string candle values to numbers', async () => {
    callMock.mockResolvedValueOnce([{
      type: 'text',
      text: JSON.stringify({
        candles: [{ timestamp: '1', open: '2', high: '3', low: '1', close: '2', volume: '4' }],
      }),
    }]);
    const { bridge, marketData } = await connectMarketDataBridge();

    try {
      await expect(marketData.getOHLCV('BTC/USDT', '1h')).resolves.toEqual([
        { timestamp: 1, open: 2, high: 3, low: 1, close: 2, volume: 4 },
      ]);
    } finally {
      await bridge.disconnect('quotes');
    }
  });

  it('rejects a price response without a finite numeric value', async () => {
    callMock.mockResolvedValueOnce([{ type: 'text', text: JSON.stringify({ quote: 42 }) }]);
    const { bridge, marketData } = await connectMarketDataBridge();

    try {
      await expect(marketData.getPrice('BTC/USDT')).rejects.toThrow(
        'MCP market-data response must include a finite numeric "price" field',
      );
    } finally {
      await bridge.disconnect('quotes');
    }
  });

  it('accepts an explicit zero price', async () => {
    callMock.mockResolvedValueOnce([{ type: 'text', text: JSON.stringify({ price: 0 }) }]);
    const { bridge, marketData } = await connectMarketDataBridge();

    try {
      await expect(marketData.getPrice('BTC/USDT')).resolves.toBe(0);
    } finally {
      await bridge.disconnect('quotes');
    }
  });

  it('rejects a 24-hour volume response without a finite numeric value', async () => {
    callMock.mockResolvedValueOnce([{ type: 'text', text: JSON.stringify({ traded: 42 }) }]);
    const { bridge, marketData } = await connectMarketDataBridge();

    try {
      await expect(marketData.get24hVolume('BTC/USDT')).rejects.toThrow(
        'MCP market-data response must include a finite numeric "volume" field',
      );
    } finally {
      await bridge.disconnect('quotes');
    }
  });

  it('accepts an explicit zero quote volume', async () => {
    callMock.mockResolvedValueOnce([{ type: 'text', text: JSON.stringify({ volume: 0 }) }]);
    const { bridge, marketData } = await connectMarketDataBridge();

    try {
      await expect(marketData.get24hVolume('BTC/USDT')).resolves.toBe(0);
    } finally {
      await bridge.disconnect('quotes');
    }
  });

  it('rejects an order-book response with missing sides', async () => {
    callMock.mockResolvedValueOnce([{ type: 'text', text: JSON.stringify({ timestamp: 123 }) }]);
    const { bridge, marketData } = await connectMarketDataBridge();

    try {
      await expect(marketData.getOrderBook('BTC/USDT')).rejects.toThrow(
        'MCP market-data response must include valid bids, asks, and timestamp',
      );
    } finally {
      await bridge.disconnect('quotes');
    }
  });

  it('accepts a valid order-book response', async () => {
    const orderBook = { bids: [[10, 1]], asks: [[11, 2]], timestamp: 123 };
    callMock.mockResolvedValueOnce([{ type: 'text', text: JSON.stringify(orderBook) }]);
    const { bridge, marketData } = await connectMarketDataBridge();

    try {
      await expect(marketData.getOrderBook('BTC/USDT')).resolves.toEqual(orderBook);
    } finally {
      await bridge.disconnect('quotes');
    }
  });

  it('rejects an order-book response with an invalid timestamp', async () => {
    callMock.mockResolvedValueOnce([{
      type: 'text',
      text: JSON.stringify({ bids: [], asks: [], timestamp: 'invalid' }),
    }]);
    const { bridge, marketData } = await connectMarketDataBridge();

    try {
      await expect(marketData.getOrderBook('BTC/USDT')).rejects.toThrow(
        'MCP market-data response must include valid bids, asks, and timestamp',
      );
    } finally {
      await bridge.disconnect('quotes');
    }
  });

  it('rejects order-book levels with values beyond the price and amount pair', async () => {
    callMock.mockResolvedValueOnce([{
      type: 'text',
      text: JSON.stringify({ bids: [[10, 1, 999]], asks: [], timestamp: 123 }),
    }]);
    const { bridge, marketData } = await connectMarketDataBridge();

    try {
      await expect(marketData.getOrderBook('BTC/USDT')).rejects.toThrow(
        'MCP market-data response must include valid bids, asks, and timestamp',
      );
    } finally {
      await bridge.disconnect('quotes');
    }
  });

  it('decodes JSON split across multiple MCP text blocks', async () => {
    callMock.mockResolvedValueOnce([
      { type: 'text', text: '{"price":' },
      { type: 'text', text: '42}' },
    ]);
    const { bridge, marketData } = await connectMarketDataBridge();

    try {
      await expect(marketData.getPrice('BTC/USDT')).resolves.toBe(42);
    } finally {
      await bridge.disconnect('quotes');
    }
  });

  it('decodes JSON text content before adapting the market-data result', async () => {
    const { bridge, services } = createBridge();
    await bridge.connect({
      name: 'quotes',
      transport: 'stdio',
      command: 'unused-in-test',
      capability: 'market_data',
      toolMapping: { methods: { getPrice: 'get_price' } },
    });

    const marketData = services.get('market_data') as { getPrice(symbol: string): Promise<number> };
    await expect(marketData.getPrice('BTC/USDT')).resolves.toBe(42);
    expect(callMock).toHaveBeenCalledWith('quotes', 'get_price', { symbol: 'BTC/USDT' });

    await bridge.disconnect('quotes');
  });

  it('preserves a single non-JSON text response', async () => {
    callMock.mockResolvedValueOnce([{ type: 'text', text: 'unstructured response' }]);
    const { bridge, provider } = await connectGenericBridge();

    try {
      await expect(provider.run({})).resolves.toBe('unstructured response');
    } finally {
      await bridge.disconnect('generic');
    }
  });

  it('preserves separate non-JSON text blocks unchanged', async () => {
    const content = [
      { type: 'text', text: 'first paragraph' },
      { type: 'text', text: 'second paragraph' },
    ];
    callMock.mockResolvedValueOnce(content);
    const { bridge, provider } = await connectGenericBridge();

    try {
      await expect(provider.run({})).resolves.toBe(content);
    } finally {
      await bridge.disconnect('generic');
    }
  });

  it('preserves mixed MCP content blocks unchanged', async () => {
    const content = [
      { type: 'text', text: '{"price":42}' },
      { type: 'image', data: 'opaque-image-content' },
    ];
    callMock.mockResolvedValueOnce(content);
    const { bridge, provider } = await connectGenericBridge();

    try {
      await expect(provider.run({})).resolves.toBe(content);
    } finally {
      await bridge.disconnect('generic');
    }
  });
});


async function connectNewsBridge() {
  const { bridge, services } = createBridge();
  await bridge.connect({
    name: 'news',
    transport: 'stdio',
    command: 'unused-in-test',
    capability: 'news',
    toolMapping: { methods: { getNews: 'get_news', getSentiment: 'get_sentiment' } },
  });
  return { bridge, news: services.get('news') as NewsProvider };
}

describe('MCPBridge news adaptation', () => {
  beforeEach(() => {
    callMock.mockReset();
    callMock.mockResolvedValue([{ type: 'text', text: JSON.stringify({ articles: [] }) }]);
  });

  it('decodes JSON text content and returns news articles', async () => {
    const articles = [{ title: 'Market update', url: 'https://example.com', source: 'wire', publishedAt: '2026-09-28T00:00:00Z' }];
    callMock.mockResolvedValueOnce([{ type: 'text', text: JSON.stringify({ articles }) }]);
    const { bridge, news } = await connectNewsBridge();
    try {
      await expect(news.getNews({ limit: 1 })).resolves.toEqual(articles);
      expect(callMock).toHaveBeenCalledWith('news', 'get_news', { options: { limit: 1 } });
    } finally { await bridge.disconnect('news'); }
  });

  it('accepts a direct array of valid articles', async () => {
    const articles = [{
      title: 'Market update',
      url: 'https://example.com',
      source: 'wire',
      publishedAt: '2026-09-28T00:00:00Z',
    }];
    callMock.mockResolvedValueOnce([{ type: 'text', text: JSON.stringify(articles) }]);
    const { bridge, news } = await connectNewsBridge();
    try {
      await expect(news.getNews()).resolves.toEqual(articles);
    } finally { await bridge.disconnect('news'); }
  });

  it('rejects articles missing required fields', async () => {
    callMock.mockResolvedValueOnce([{
      type: 'text',
      text: JSON.stringify({ articles: [{ title: 'Incomplete article' }] }),
    }]);
    const { bridge, news } = await connectNewsBridge();
    try {
      await expect(news.getNews()).rejects.toThrow('MCP news response contains an invalid article');
    } finally { await bridge.disconnect('news'); }
  });

  it('rejects a news response without an articles array', async () => {
    callMock.mockResolvedValueOnce([{ type: 'text', text: JSON.stringify({ items: [] }) }]);
    const { bridge, news } = await connectNewsBridge();
    try {
      await expect(news.getNews()).rejects.toThrow('MCP news response must include an articles array');
    } finally { await bridge.disconnect('news'); }
  });
});
