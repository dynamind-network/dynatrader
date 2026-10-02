import { describe, expect, it, vi } from 'vitest';
import { IBKRAdapter } from './ibkr-adapter';

describe('IBKRAdapter', () => {
  it('requires an account id', () => expect(() => new IBKRAdapter()).toThrow('IBKR_ACCOUNT_ID'));

  it('maps a limit order to the Client Portal API', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(JSON.stringify([{ order_id: 42 }]), { status: 200 }));
    const adapter = new IBKRAdapter({ accountId: 'DU123', baseUrl: 'https://ibkr.test/v1/api', contractIds: { AAPL: 265598 }, fetchImpl: fetchMock });
    const result = await adapter.placeOrder({ venue: 'ibkr', symbol: 'AAPL', side: 'buy', type: 'limit', quantity: 2, price: 190, strategyId: 'test', mode: 'paper' });
    expect(result.orderId).toBe('42');
    expect(fetchMock).toHaveBeenCalledWith('https://ibkr.test/v1/api/iserver/account/DU123/orders', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string).orders[0]).toMatchObject({ acctId: 'DU123', conid: 265598, side: 'BUY', orderType: 'LMT', price: 190 });
  });
});
