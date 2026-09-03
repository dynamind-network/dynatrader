import type { ExchangeAdapter, OrderIntent } from '@dyna/contracts';

export interface BrokerBalanceSnapshot {
  broker: string;
  balance: Record<string, unknown>;
  error?: string;
}

export interface BrokerMarketSnapshot {
  broker: string;
  markets: Record<string, unknown>;
  error?: string;
}

/** Read-only portfolio aggregation across configured broker adapters. */
export class BrokerAggregator {
  private readonly brokers: Map<string, ExchangeAdapter>;

  constructor(adapters: Iterable<ExchangeAdapter>) {
    this.brokers = new Map(Array.from(adapters, (adapter) => [adapter.id, adapter]));
  }

  listBrokers(): string[] { return [...this.brokers.keys()]; }

  getBroker(id: string): ExchangeAdapter | undefined { return this.brokers.get(id); }

  async balances(): Promise<{ totalEquity: number; totalCash: number; brokers: BrokerBalanceSnapshot[] }> {
    const snapshots = await Promise.all([...this.brokers].map(async ([broker, adapter]): Promise<BrokerBalanceSnapshot> => {
      try { return { broker, balance: await adapter.balances() }; }
      catch (error) { return { broker, balance: {}, error: error instanceof Error ? error.message : String(error) }; }
    }));
    return { totalEquity: sumNumeric(snapshots, ['equity', 'totalValue', 'net_assets', 'netAssets']), totalCash: sumNumeric(snapshots, ['cash', 'availableCash', 'buy_power', 'buyPower']), brokers: snapshots };
  }

  async fetchMarkets(brokerId?: string): Promise<BrokerMarketSnapshot[]> {
    const targets = brokerId
      ? [[brokerId, this.brokers.get(brokerId)] as const].filter((e): e is readonly [string, ExchangeAdapter] => e[1] !== undefined)
      : [...this.brokers];

    return Promise.all(targets.map(async ([broker, adapter]): Promise<BrokerMarketSnapshot> => {
      try { return { broker, markets: await adapter.fetchMarkets() }; }
      catch (error) { return { broker, markets: {}, error: error instanceof Error ? error.message : String(error) }; }
    }));
  }

  async fetchOHLCV(req: { symbol: string; timeframe: string; since?: number; limit?: number; brokerId?: string }): Promise<Array<[number, number, number, number, number, number]>> {
    const adapter = req.brokerId
      ? this.brokers.get(req.brokerId)
      : [...this.brokers.values()][0];

    if (!adapter) throw new Error(`No broker available${req.brokerId ? `: ${req.brokerId}` : ''}`);

    return adapter.fetchOHLCV({
      symbol: req.symbol,
      timeframe: req.timeframe,
      since: req.since,
      limit: req.limit,
    });
  }

  async placeOrder(intent: OrderIntent): Promise<{ broker: string; orderId: string; raw?: unknown }> {
    const adapter = this.brokers.get(intent.venue);
    if (!adapter) throw new Error(`Broker not configured: ${intent.venue}`);
    const result = await adapter.placeOrder(intent);
    return { broker: adapter.id, ...result };
  }

  async cancelOrder(req: { orderId: string; symbol: string; brokerId: string }): Promise<void> {
    const adapter = this.brokers.get(req.brokerId);
    if (!adapter) throw new Error(`Broker not configured: ${req.brokerId}`);
    await adapter.cancelOrder({ orderId: req.orderId, symbol: req.symbol });
  }
}

function sumNumeric(snapshots: BrokerBalanceSnapshot[], keys: string[]): number {
  return snapshots.reduce((total, snapshot) => {
    for (const key of keys) {
      const value = Number(snapshot.balance[key]);
      if (Number.isFinite(value)) return total + value;
    }
    return total;
  }, 0);
}
