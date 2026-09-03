import { describe, expect, it } from 'vitest';
import type { ExchangeAdapter } from '@dyna/contracts';
import { BrokerAggregator } from './broker-aggregator';

function broker(id: string, balance: Record<string, unknown>): ExchangeAdapter {
  return { id, capabilities: async () => ({}), fetchMarkets: async () => ({}), fetchOHLCV: async () => [], balances: async () => balance, placeOrder: async () => ({ orderId: `${id}-1` }), cancelOrder: async () => {} };
}

describe('BrokerAggregator', () => {
  it('aggregates balances without hiding broker errors', async () => {
    const result = await new BrokerAggregator([broker('alpaca', { equity: 100, cash: 40 }), broker('longbridge', { net_assets: '50', buy_power: '25' })]).balances();
    expect(result).toMatchObject({ totalEquity: 150, totalCash: 65, brokers: [{ broker: 'alpaca' }, { broker: 'longbridge' }] });
  });

  it('routes an order by venue', async () => {
    const result = await new BrokerAggregator([broker('ibkr', {})]).placeOrder({ venue: 'ibkr', symbol: 'AAPL', side: 'buy', type: 'market', quantity: 1, strategyId: 'test', mode: 'paper' });
    expect(result).toMatchObject({ broker: 'ibkr', orderId: 'ibkr-1' });
  });
});
