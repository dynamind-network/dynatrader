import { describe, expect, it, vi } from 'vitest';
import { createTradingTools } from './trading-tools';

describe('agent trading tools', () => {
  it('uses the configured market-data provider and exposes quota failures from scans', async () => {
    const getOHLCV = vi.fn().mockRejectedValue(new Error('DynaMind API rate limit reached. Retry after 60 seconds.'));
    const fetchMarkets = vi.fn();
    const tools = createTradingTools({
      exchange: { id: 'paper-venue', fetchMarkets } as any,
      marketDataProvider: {
        fetchUniverse: vi.fn().mockResolvedValue(['BTC/USD']),
        getOHLCV,
      } as any,
      marketDataSource: 'dynamind-api',
      paperEngine: {} as any,
      executionRouter: { execute: vi.fn() } as any,
      defaultMode: 'research',
      getRiskLimits: () => undefined,
    });

    const scan = tools.find((tool) => tool.definition.name === 'scan_market')!;
    const response = await scan.execute({ tool: 'scan_market', args: { timeframe: '1h' } } as any);

    expect(getOHLCV).toHaveBeenCalledWith('BTC/USD', '1h', 60);
    expect(fetchMarkets).not.toHaveBeenCalled();
    expect(response).toMatchObject({ success: false, error: expect.stringContaining('rate limit reached') });
  });

  it('fails closed when explicit trading limits are missing', async () => {
    const tools = createTradingTools({
      exchange: { id: 'paper-venue' } as any,
      paperEngine: {} as any,
      executionRouter: { execute: vi.fn() } as any,
      defaultMode: 'paper',
      getRiskLimits: () => undefined,
      getEquity: vi.fn(),
    });

    const propose = tools.find((tool) => tool.definition.name === 'propose_order')!;
    const response = await propose.execute({
      tool: 'propose_order',
      args: { symbol: 'BTC/USDT', timeframe: '1h', side: 'buy', quantity: 1 },
    } as any);

    expect(response.success).toBe(false);
    expect(response.error).toContain('maxPositionPct');
  });
});
