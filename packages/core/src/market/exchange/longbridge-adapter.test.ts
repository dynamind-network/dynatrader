import { describe, expect, it, vi } from 'vitest';
import { LongbridgeAdapter } from './longbridge-adapter';

describe('LongbridgeAdapter', () => {
  it('requires an OAuth access token', () => expect(() => new LongbridgeAdapter()).toThrow('LONGBRIDGE_ACCESS_TOKEN'));

  it('maps an order with an idempotency key', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(JSON.stringify({ code: 0, data: { order_id: 'lb-1' } }), { status: 200 }));
    const adapter = new LongbridgeAdapter({ accessToken: 'token', baseUrl: 'https://longbridge.test', fetchImpl: fetchMock });
    const result = await adapter.placeOrder({ venue: 'longbridge', symbol: 'AAPL.US', side: 'buy', type: 'market', quantity: 2, strategyId: 'test', mode: 'paper' });
    expect(result.orderId).toBe('lb-1');
    expect(fetchMock).toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://longbridge.test/v1/trade/order');
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer token' });
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)).toMatchObject({ symbol: 'AAPL.US', order_type: 'MO', side: 'Buy', submitted_quantity: '2' });
  });
});
