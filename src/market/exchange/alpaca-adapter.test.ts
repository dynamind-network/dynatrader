import { describe, expect, it, vi } from 'vitest';
import { AlpacaAdapter } from './alpaca-adapter';

function response(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }

describe('AlpacaAdapter', () => {
  it('requires credentials', () => expect(() => new AlpacaAdapter({ fetchImpl: vi.fn() as unknown as (input: string | URL, init?: RequestInit) => Promise<Response> })).toThrow('ALPACA_API_KEY'));

  it('normalizes bars and submits paper orders through REST', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/v2/stocks/bars')) return response({ bars: { BTCUSD: [{ t: '2026-01-01T00:00:00Z', o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }] } });
      if (url.endsWith('/v2/orders')) return response({ id: 'order-1', status: 'accepted' });
      return response({});
    });
    const adapter = new AlpacaAdapter({ apiKey: 'key', secretKey: 'secret', baseUrl: 'https://paper.test', dataUrl: 'https://data.test', fetchImpl: fetchMock as unknown as (input: string | URL, init?: RequestInit) => Promise<Response> });
    expect(await adapter.fetchOHLCV({ symbol: 'BTC/USD', timeframe: '1h', limit: 1 })).toEqual([[Date.parse('2026-01-01T00:00:00Z'), 1, 2, 0.5, 1.5, 10]]);
    const order = await adapter.placeOrder({ venue: 'alpaca', symbol: 'BTC/USD', side: 'buy', type: 'market', quantity: 2, strategyId: 's', mode: 'paper' });
    expect(order.orderId).toBe('order-1');
    expect(fetchMock).toHaveBeenCalledWith('https://paper.test/v2/orders', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string).symbol).toBe('BTCUSD');
  });
});
