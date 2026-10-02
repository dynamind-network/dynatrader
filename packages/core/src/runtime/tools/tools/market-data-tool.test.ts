import { describe, expect, it, vi } from 'vitest';
import { MarketDataTool } from './market-data-tool';

describe('MarketDataTool contract', () => {
  it('uses the selected market-data provider for prices and reports its source', async () => {
    const getPrice = vi.fn().mockResolvedValue(42);
    const fetchOHLCV = vi.fn();
    const tool = new MarketDataTool({
      exchange: { id: 'paper-venue', fetchOHLCV } as never,
      marketDataProvider: { getPrice } as never,
      marketDataSource: 'dynamind-api',
    });

    await expect(tool.execute({ tool: 'market_data', args: { action: 'price', symbol: 'BTC/USD' } })).resolves.toMatchObject({
      success: true,
      data: { source: 'dynamind-api', symbol: 'BTC/USD', price: 42 },
    });
    expect(getPrice).toHaveBeenCalledWith('BTC/USD');
    expect(fetchOHLCV).not.toHaveBeenCalled();
  });

  it('advertises only supported actions and explains portfolio balances', async () => {
    const tool = new MarketDataTool({
      exchange: {
        id: 'paper-venue',
        balances: vi.fn().mockResolvedValue({ USDT: 100 }),
      } as never,
    });

    expect(tool.definition.inputSchema.action).toEqual({
      type: 'string',
      enum: ['price', 'ohlcv', 'portfolio', 'markets'],
    });
    expect(tool.definition.description).toContain('Use portfolio to retrieve account balances');
    await expect(tool.execute({ tool: 'market_data', args: { action: 'balance' } })).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('Available: price, ohlcv, portfolio, markets'),
    });
  });

  it('reports venue HTTP 451 as a restricted-location failure without a retry suggestion', async () => {
    const tool = new MarketDataTool({
      exchange: {
        id: 'binance-testnet',
        balances: vi.fn().mockRejectedValue(new Error('HTTP 451 Unavailable For Legal Reasons: restricted location')),
      } as never,
    });

    await expect(tool.execute({ tool: 'market_data', args: { action: 'portfolio' } })).resolves.toMatchObject({
      success: false,
      error: 'binance-testnet rejected portfolio with HTTP 451 (restricted location). Venue access is unavailable from this host; no retry was attempted.',
    });
  });
});
