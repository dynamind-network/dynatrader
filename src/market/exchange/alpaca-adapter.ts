import type { ExchangeAdapter, OrderIntent } from '@dyna/contracts';

export interface AlpacaAdapterConfig {
  apiKey?: string;
  secretKey?: string;
  baseUrl?: string;
  dataUrl?: string;
  paper?: boolean;
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

interface AlpacaBar { t: string; o: number; h: number; l: number; c: number; v: number; }

/** Alpaca Trading API adapter for paper and live account execution. */
export class AlpacaAdapter implements ExchangeAdapter {
  readonly id = 'alpaca';
  private readonly apiKey: string;
  private readonly secretKey: string;
  private readonly baseUrl: string;
  private readonly dataUrl: string;
  private readonly fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>;

  constructor(config: AlpacaAdapterConfig = {}) {
    this.apiKey = config.apiKey ?? process.env['ALPACA_API_KEY'] ?? '';
    this.secretKey = config.secretKey ?? process.env['ALPACA_SECRET_KEY'] ?? '';
    const paper = config.paper ?? process.env['ALPACA_PAPER'] !== 'false';
    this.baseUrl = (config.baseUrl ?? (paper ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets')).replace(/\/$/, '');
    this.dataUrl = (config.dataUrl ?? 'https://data.alpaca.markets').replace(/\/$/, '');
    this.fetchImpl = config.fetchImpl ?? fetch;
    if (!this.apiKey || !this.secretKey) throw new Error('Alpaca credentials required: set ALPACA_API_KEY and ALPACA_SECRET_KEY');
  }

  async capabilities(): Promise<Record<string, unknown>> {
    return { id: this.id, name: 'Alpaca', tradingMode: this.baseUrl.includes('paper-api') ? 'paper' : 'live', has: { spot: true, orders: true, OHLCV: true, cancelAllOrders: true } };
  }

  async fetchMarkets(): Promise<Record<string, unknown>> {
    const assets = await this.request<Array<Record<string, unknown>>>('/v2/assets?status=active& tradable=true'.replace(' ', ''), { base: 'trading' });
    return { total: assets.length, markets: assets.map((asset) => ({ symbol: String(asset.symbol ?? ''), baseCurrency: asset.base_currency, quoteCurrency: asset.quote_currency ?? 'USD', type: 'spot', status: asset.status, tradable: asset.tradable })) };
  }

  async fetchOHLCV(req: { symbol: string; timeframe: string; since?: number; limit?: number }): Promise<Array<[number, number, number, number, number, number]>> {
    const symbol = normalizeSymbol(req.symbol);
    const timeframe = mapTimeframe(req.timeframe);
    const params = new URLSearchParams({ symbols: symbol, timeframe, limit: String(Math.min(req.limit ?? 100, 10000)) });
    if (req.since) params.set('start', new Date(req.since).toISOString());
    const response = await this.request<{ bars?: Record<string, AlpacaBar[]> }>(`/v2/stocks/bars?${params.toString()}`, { base: 'data' });
    return (response.bars?.[symbol] ?? []).map((bar) => [Date.parse(bar.t), bar.o, bar.h, bar.l, bar.c, bar.v]);
  }

  async balances(): Promise<Record<string, unknown>> {
    const account = await this.request<Record<string, unknown>>('/v2/account');
    return { equity: Number(account.equity ?? 0), cash: Number(account.cash ?? 0), buyingPower: Number(account.buying_power ?? 0), status: account.status, raw: account };
  }

  async placeOrder(intent: OrderIntent): Promise<{ orderId: string; raw?: unknown }> {
    const body: Record<string, unknown> = {
      symbol: normalizeSymbol(intent.symbol), qty: String(intent.quantity), side: intent.side,
      time_in_force: intent.type === 'market' ? 'day' : 'gtc',
    };

    // Map order types properly
    switch (intent.type) {
      case 'market':
        body.type = 'market';
        break;
      case 'limit':
        body.type = 'limit';
        if (intent.price !== undefined) body.limit_price = intent.price;
        break;
      case 'stop':
        body.type = 'stop';
        if (intent.stopPrice !== undefined) body.stop_price = intent.stopPrice;
        else if (intent.price !== undefined) body.stop_price = intent.price;
        break;
      case 'stop-limit':
        body.type = 'stop_limit';
        if (intent.stopPrice !== undefined) body.stop_price = intent.stopPrice;
        else if (intent.price !== undefined) body.stop_price = intent.price;
        if (intent.limitPrice !== undefined) body.limit_price = intent.limitPrice;
        else if (intent.price !== undefined) body.limit_price = intent.price;
        break;
    }

    const order = await this.request<Record<string, unknown>>('/v2/orders', { method: 'POST', body });
    if (!order.id) throw new Error('Alpaca returned an order without an id');
    return { orderId: String(order.id), raw: order };
  }

  async cancelOrder(req: { orderId: string; symbol: string }): Promise<void> {
    await this.request(`/v2/orders/${encodeURIComponent(req.orderId)}`, { method: 'DELETE' });
  }

  private async request<T>(path: string, options: { method?: string; body?: Record<string, unknown>; base?: 'trading' | 'data' } = {}): Promise<T> {
    const base = options.base === 'data' ? this.dataUrl : this.baseUrl;
    const response = await this.fetchImpl(`${base}${path}`, {
      method: options.method ?? 'GET',
      headers: { 'APCA-API-KEY-ID': this.apiKey, 'APCA-API-SECRET-KEY': this.secretKey, 'Content-Type': 'application/json' },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    if (!response.ok) throw new Error(`Alpaca API error ${response.status}: ${await response.text().catch(() => 'Unknown error')}`);
    if (options.method === 'DELETE') return undefined as T;
    return await response.json() as T;
  }
}

function normalizeSymbol(symbol: string): string { return symbol.replace('/', '').toUpperCase(); }
function mapTimeframe(timeframe: string): string {
  const mappings: Record<string, string> = { '1m': '1Min', '5m': '5Min', '15m': '15Min', '30m': '30Min', '1h': '1Hour', '4h': '4Hour', '1d': '1Day' };
  const mapped = mappings[timeframe];
  if (!mapped) throw new Error(`Unsupported Alpaca timeframe: ${timeframe}`);
  return mapped;
}
