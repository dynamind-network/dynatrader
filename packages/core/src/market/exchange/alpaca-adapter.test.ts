import { describe, expect, it, vi } from 'vitest';
import { AlpacaAdapter } from './alpaca-adapter';

describe('AlpacaAdapter risk snapshot', () => {
  it('normalizes equity change and active positions for live risk checks', async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/v2/account') {
        return new Response(JSON.stringify({ equity: '9700', last_equity: '10000' }), { status: 200 });
      }
      if (url.pathname === '/v2/positions') {
        return new Response(JSON.stringify([
          { symbol: 'AAPL', qty: '3' },
          { symbol: 'TSLA', qty: '0' },
          { symbol: 'SPY', qty: '-2' },
        ]), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    const adapter = new AlpacaAdapter({ apiKey: 'test-key', secretKey: 'test-secret', fetchImpl });

    const snapshot = await adapter.fetchRiskSnapshot();

    expect(snapshot.equity).toBe(9700);
    expect(snapshot.dailyPnlPct).toBeCloseTo(-0.03);
    expect(snapshot.openPositions).toEqual([
      { symbol: 'AAPL', quantity: 3 },
      { symbol: 'SPY', quantity: -2 },
    ]);
    expect(snapshot.asOf).toBeGreaterThan(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects snapshots without a valid previous-session equity baseline', async () => {
    const adapter = new AlpacaAdapter({
      apiKey: 'test-key',
      secretKey: 'test-secret',
      fetchImpl: async () => new Response(JSON.stringify({ equity: '10000' }), { status: 200 }),
    });

    await expect(adapter.fetchRiskSnapshot()).rejects.toThrow(/previous-session equity/i);
  });
});
