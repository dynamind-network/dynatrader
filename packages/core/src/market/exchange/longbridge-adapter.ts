import { randomUUID } from 'node:crypto';
import type { ExchangeAdapter, OrderIntent } from '@dyna/contracts';

export interface LongbridgeAdapterConfig {
  accessToken?: string;
  baseUrl?: string;
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

/** Longbridge OpenAPI HTTP adapter for US/HK stock trading and quotes. */
export class LongbridgeAdapter implements ExchangeAdapter {
  readonly id = 'longbridge';
  private readonly accessToken: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>;

  constructor(config: LongbridgeAdapterConfig = {}) {
    this.accessToken = config.accessToken ?? process.env['LONGBRIDGE_ACCESS_TOKEN'] ?? process.env['LONGBRIDGE_TOKEN'] ?? '';
    if (!this.accessToken) throw new Error('Longbridge access token required: set LONGBRIDGE_ACCESS_TOKEN');
    this.baseUrl = (config.baseUrl ?? process.env['LONGBRIDGE_HTTP_URL'] ?? 'https://openapi.longbridge.com').replace(/\/$/, '');
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async capabilities(): Promise<Record<string, unknown>> { return { id: this.id, name: 'Longbridge', tradingMode: 'live-account-configured-at-provider', has: { spot: true, orders: true, OHLCV: true, cancelAllOrders: false } }; }
  async fetchMarkets(): Promise<Record<string, unknown>> { return { total: 0, markets: [], note: 'Longbridge markets are symbol-driven; quote permissions determine availability.' }; }

  async fetchOHLCV(req: { symbol: string; timeframe: string; since?: number; limit?: number }): Promise<Array<[number, number, number, number, number, number]>> {
    const data = await this.request<{ symbol?: string; candlesticks?: Array<Record<string, unknown>> }>('/v1/quote/candlestick', { method: 'GET', query: { symbol: normalizeSymbol(req.symbol), period: mapPeriod(req.timeframe), count: String(Math.min(req.limit ?? 100, 1000)), adjust_type: '0', ...(req.since ? { start_at: String(Math.floor(req.since / 1000)) } : {}) } });
    return (data.candlesticks ?? []).map((bar) => [Number(bar.timestamp ?? 0) * (Number(bar.timestamp ?? 0) < 10_000_000_000 ? 1000 : 1), Number(bar.open ?? 0), Number(bar.high ?? 0), Number(bar.low ?? 0), Number(bar.close ?? 0), Number(bar.volume ?? 0)]);
  }

  async balances(): Promise<Record<string, unknown>> { return await this.request<Record<string, unknown>>('/v1/asset/account'); }

  async placeOrder(intent: OrderIntent): Promise<{ orderId: string; raw?: unknown }> {
    if (intent.type === 'stop' || intent.type === 'stop-limit') throw new Error('Longbridge adapter does not map stop orders through the generic ExchangeAdapter contract');
    const response = await this.request<Record<string, unknown>>('/v1/trade/order', { method: 'POST', body: { symbol: normalizeSymbol(intent.symbol), order_type: intent.type === 'market' ? 'MO' : 'LO', side: intent.side === 'buy' ? 'Buy' : 'Sell', submitted_quantity: String(intent.quantity), ...(intent.price !== undefined ? { submitted_price: String(intent.price) } : {}), time_in_force: intent.type === 'market' ? 'Day' : 'GTC', client_request_id: randomUUID() } });
    const orderId = response.order_id ?? response.orderId ?? (response.data as Record<string, unknown> | undefined)?.order_id;
    if (orderId === undefined) throw new Error('Longbridge returned an order without an id');
    return { orderId: String(orderId), raw: response };
  }

  async cancelOrder(req: { orderId: string; symbol: string }): Promise<void> { await this.request('/v1/trade/order', { method: 'DELETE', body: { order_id: req.orderId } }); }

  private async request<T>(path: string, options: { method?: string; query?: Record<string, string>; body?: unknown } = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
    const response = await this.fetchImpl(url, { method: options.method ?? 'GET', headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${this.accessToken}` }, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
    if (!response.ok) throw new Error(`Longbridge API error ${response.status}: ${await response.text().catch(() => 'Unknown error')}`);
    if (options.method === 'DELETE') return undefined as T;
    const payload = await response.json() as { code?: number; msg?: string; data?: T } & T;
    if (typeof payload.code === 'number' && payload.code !== 0) throw new Error(`Longbridge API error ${payload.code}: ${payload.msg ?? 'request failed'}`);
    return (payload.data ?? payload) as T;
  }
}

function normalizeSymbol(symbol: string): string { return symbol.includes('.') ? symbol.toUpperCase() : `${symbol.toUpperCase()}.US`; }
function mapPeriod(timeframe: string): string { return ({ '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240', '1d': '1000' } as Record<string, string>)[timeframe] ?? (() => { throw new Error(`Unsupported Longbridge timeframe: ${timeframe}`); })(); }
