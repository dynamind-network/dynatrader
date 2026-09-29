import { describe, expect, it, vi } from 'vitest';
import { createTradingTools } from './trading-tools';

describe('agent trading tools', () => {
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
