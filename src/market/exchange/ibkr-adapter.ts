import type { ExchangeAdapter, OrderIntent } from '@dyna/contracts';

export interface IBKRAdapterConfig {
  accountId?: string;
  baseUrl?: string;
  sessionToken?: string;
  contractIds?: Record<string, number>;
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

/**
 * Interactive Brokers Client Portal REST adapter.
 *
 * The Client Portal Gateway must be running separately; this adapter deliberately
 * does not attempt to manage TWS/Gateway processes or credentials.
 */
export class IBKRAdapter implements ExchangeAdapter {
  readonly id = 'ibkr';
  private readonly accountId: string;
  private readonly baseUrl: string;
  private readonly sessionToken?: string;
  private readonly contractIds: Record<string, number>;
  private readonly fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>;

  constructor(config: IBKRAdapterConfig = {}) {
    this.accountId = config.accountId ?? process.env['IBKR_ACCOUNT_ID'] ?? '';
    if (!this.accountId) throw new Error('IBKR account required: set IBKR_ACCOUNT_ID');
    this.baseUrl = (config.baseUrl ?? process.env['IBKR_BASE_URL'] ?? 'https://localhost:5000/v1/api').replace(/\/$/, '');
    this.sessionToken = config.sessionToken ?? process.env['IBKR_SESSION_TOKEN'];
    this.contractIds = config.contractIds ?? parseContractIds(process.env['IBKR_CONTRACT_IDS']);
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async capabilities(): Promise<Record<string, unknown>> {
    return { id: this.id, name: 'Interactive Brokers', tradingMode: 'paper-or-live-configured-at-gateway', has: { spot: true, orders: true, OHLCV: true, cancelAllOrders: true } };
  }

  async fetchMarkets(): Promise<Record<string, unknown>> {
    return { total: Object.keys(this.contractIds).length, markets: Object.entries(this.contractIds).map(([symbol, conid]) => ({ symbol, conid, type: 'spot', status: 'active' })) };
  }

  async fetchOHLCV(req: { symbol: string; timeframe: string; since?: number; limit?: number }): Promise<Array<[number, number, number, number, number, number]>> {
    const conid = this.contractId(req.symbol);
    const params = new URLSearchParams({ conid: String(conid), period: mapPeriod(req.timeframe, req.since), bar: mapBar(req.timeframe) });
    const data = await this.request<Record<string, unknown>>(`/iserver/marketdata/history?${params.toString()}`);
    const rows = Array.isArray(data.data) ? data.data : [];
    return rows.slice(-(req.limit ?? rows.length)).map((row) => {
      const item = row as Record<string, unknown>;
      return [Number(item.t ?? 0), Number(item.o ?? 0), Number(item.h ?? 0), Number(item.l ?? 0), Number(item.c ?? 0), Number(item.v ?? 0)];
    });
  }

  async balances(): Promise<Record<string, unknown>> {
    return await this.request<Record<string, unknown>>(`/portfolio/${encodeURIComponent(this.accountId)}/ledger`);
  }

  async placeOrder(intent: OrderIntent): Promise<{ orderId: string; raw?: unknown }> {
    // Map order types to IBKR order types
    let orderType: string;
    switch (intent.type) {
      case 'market':
        orderType = 'MKT';
        break;
      case 'limit':
        orderType = 'LMT';
        break;
      case 'stop':
        orderType = 'STP';
        break;
      case 'stop-limit':
        orderType = 'STPLMT';
        break;
      default:
        orderType = 'MKT';
    }

    const order: Record<string, unknown> = {
      acctId: this.accountId,
      conid: this.contractId(intent.symbol),
      side: intent.side.toUpperCase(),
      orderType,
      quantity: intent.quantity,
      tif: intent.type === 'market' ? 'DAY' : 'GTC',
    };

    // Add price parameters based on order type
    if (intent.type === 'limit' || intent.type === 'stop-limit') {
      if (intent.limitPrice !== undefined) order.price = intent.limitPrice;
      else if (intent.price !== undefined) order.price = intent.price;
    }
    if (intent.type === 'stop' || intent.type === 'stop-limit') {
      if (intent.stopPrice !== undefined) order.stopPrice = intent.stopPrice;
      else if (intent.price !== undefined) order.stopPrice = intent.price;
    }

    const body = { orders: [{ ...order }] };
    const response = await this.request<unknown>(`/iserver/account/${encodeURIComponent(this.accountId)}/orders`, { method: 'POST', body });
    const first = Array.isArray(response) ? response[0] as Record<string, unknown> | undefined : response as Record<string, unknown>;
    const orderId = first?.order_id ?? first?.orderId ?? first?.id;
    if (orderId === undefined) throw new Error('IBKR returned an order without an id');
    return { orderId: String(orderId), raw: response };
  }

  async cancelOrder(req: { orderId: string; symbol: string }): Promise<void> {
    await this.request(`/iserver/account/${encodeURIComponent(this.accountId)}/order/${encodeURIComponent(req.orderId)}`, { method: 'DELETE' });
  }

  private contractId(symbol: string): number {
    const conid = this.contractIds[symbol] ?? this.contractIds[symbol.toUpperCase()];
    if (!conid) throw new Error(`IBKR contract id not configured for ${symbol}; set IBKR_CONTRACT_IDS or pass contractIds`);
    return conid;
  }

  private async request<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { method: options.method ?? 'GET', headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(this.sessionToken ? { Authorization: `Bearer ${this.sessionToken}` } : {}) }, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
    if (!response.ok) throw new Error(`IBKR API error ${response.status}: ${await response.text().catch(() => 'Unknown error')}`);
    if (options.method === 'DELETE') return undefined as T;
    return await response.json() as T;
  }
}

function parseContractIds(value?: string): Record<string, number> {
  if (!value) return {};
  try { return Object.fromEntries(Object.entries(JSON.parse(value) as Record<string, unknown>).map(([key, id]) => [key, Number(id)] as [string, number]).filter(([, id]) => Number.isFinite(id) && id > 0)); } catch { throw new Error('IBKR_CONTRACT_IDS must be a JSON object mapping symbols to numeric contract ids'); }
}

function mapBar(timeframe: string): string { return ({ '1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min', '1h': '1hour', '4h': '4hour', '1d': '1day' } as Record<string, string>)[timeframe] ?? (() => { throw new Error(`Unsupported IBKR timeframe: ${timeframe}`); })(); }
function mapPeriod(timeframe: string, since?: number): string { if (since) return `${Math.max(1, Math.ceil((Date.now() - since) / 86_400_000))}d`; return timeframe === '1d' ? '1y' : '1m'; }
