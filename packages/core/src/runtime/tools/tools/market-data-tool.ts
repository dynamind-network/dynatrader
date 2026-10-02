import type { ExchangeAdapter, ToolCall, ToolDefinition, ToolHandler, ToolResult } from '@dyna/contracts';
import type { MarketDataProvider } from '../../../plugins/types.js';

export interface MarketDataToolConfig {
  exchange: ExchangeAdapter;
  marketDataProvider?: MarketDataProvider;
  marketDataSource?: string;
}

export class MarketDataTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'market_data',
    description: 'Fetch market data. Supported actions: price, ohlcv, portfolio, markets. Use portfolio to retrieve account balances; there is no balance action.',
    category: 'market',
    inputSchema: {
      action: { type: 'string', enum: ['price', 'ohlcv', 'portfolio', 'markets'] },
      symbol: 'string?',
      timeframe: 'string?',
      limit: 'number?',
    },
    outputSchema: {},
    permissionsRequired: ['tool.market_data'],
    sideEffects: [],
    riskLevel: 'low',
    timeoutMs: 30000,
  };

  private exchange: ExchangeAdapter;
  private marketDataProvider?: MarketDataProvider;
  private marketDataSource: string;

  constructor(config: MarketDataToolConfig) {
    this.exchange = config.exchange;
    this.marketDataProvider = config.marketDataProvider;
    this.marketDataSource = config.marketDataSource ?? 'configured market-data provider';
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const start = Date.now();
    try {
      const action = call.args.action as string;

      switch (action) {
        case 'price': {
          return await this.getPrice(call);
        }
        case 'ohlcv': {
          return await this.getOHLCV(call);
        }
        case 'portfolio': {
          return await this.getPortfolio(call);
        }
        case 'markets': {
          return await this.getMarkets(call);
        }
        default: {
          return {
            success: false,
            error: `Unknown market_data action: "${action}". Available: price, ohlcv, portfolio, markets`,
            durationMs: Date.now() - start,
            truncated: false,
          };
        }
      }
    } catch (err) {
      const action = typeof call.args.action === 'string' ? call.args.action : 'request';
      const symbol = typeof call.args.symbol === 'string' ? ` for ${call.args.symbol}` : '';
      const message = (err as Error).message ?? String(err);
      const actionableMessage = /\b451\b|restricted location|unavailable for legal reasons/i.test(message)
        ? `${this.exchange.id} rejected ${action}${symbol} with HTTP 451 (restricted location). Venue access is unavailable from this host; no retry was attempted.`
        : `${action}${symbol} via ${this.marketDataProvider ? this.marketDataSource : this.exchange.id} failed: ${message}`;
      return {
        success: false,
        error: actionableMessage,
        durationMs: Date.now() - start,
        truncated: false,
      };
    }
  }

  private async getPrice(call: ToolCall): Promise<ToolResult> {
    const start = Date.now();
    const symbol = this.resolveSymbol(call);
    const timeframe = this.resolveTimeframe(call);
    if (!symbol) {
      return {
        success: false,
        error: 'market_data requires an explicit symbol. Call market_data with action "markets" first if you need to discover candidates.',
        durationMs: Date.now() - start,
        truncated: false,
      };
    }
    if (!timeframe && !this.marketDataProvider) {
      return {
        success: false,
        error: 'market_data requires an explicit timeframe for price analysis. The agent should choose one after market discovery.',
        durationMs: Date.now() - start,
        truncated: false,
      };
    }
    if (this.marketDataProvider) {
      const price = await this.marketDataProvider.getPrice(symbol);
      if (!Number.isFinite(price) || price <= 0) throw new Error(`No valid price data for ${symbol} from ${this.marketDataSource}.`);
      const fetchedAt = new Date().toISOString();
      return {
        success: true,
        data: { source: this.marketDataSource, symbol, price, fetchedAt },
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    const candles = await this.exchange.fetchOHLCV({ symbol, timeframe: timeframe!, limit: 1 });
    if (candles.length === 0) {
      return { success: false, error: `No price data for ${symbol}`, durationMs: Date.now() - start, truncated: false };
    }
    const [ts, open, high, low, close] = candles[0]! as unknown as [number, number, number, number, number];
    const fetchedAt = Date.now();
    return {
      success: true,
      data: { venue: this.exchange.id, source: 'exchange', symbol, timeframe, price: close, open, high, low, timestamp: new Date(ts).toISOString(), asOf: new Date(ts).toISOString(), fetchedAt: new Date(fetchedAt).toISOString(), stalenessMs: Math.max(0, fetchedAt - ts) },
      durationMs: Date.now() - start,
      truncated: false,
    };
  }

  private async getOHLCV(call: ToolCall): Promise<ToolResult> {
    const start = Date.now();
    const symbol = this.resolveSymbol(call);
    const timeframe = this.resolveTimeframe(call);
    if (!symbol) {
      return {
        success: false,
        error: 'market_data requires an explicit symbol. Call market_data with action "markets" first if you need to discover candidates.',
        durationMs: Date.now() - start,
        truncated: false,
      };
    }
    if (!timeframe) {
      return {
        success: false,
        error: 'market_data requires an explicit timeframe. The agent should infer the horizon from the strategy context rather than using a default.',
        durationMs: Date.now() - start,
        truncated: false,
      };
    }
    const requestedLimit = Number(call.args.limit);
    const limit = Math.max(1, Math.min(1000, Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 30));
    if (this.marketDataProvider) {
      const candles = await this.marketDataProvider.getOHLCV(symbol, timeframe, limit);
      const fetchedAt = Date.now();
      const lastTimestamp = candles.at(-1)?.timestamp;
      return {
        success: true,
        data: {
          source: this.marketDataSource,
          symbol,
          timeframe,
          fetchedAt: new Date(fetchedAt).toISOString(),
          ...(typeof lastTimestamp === 'number' ? { asOf: new Date(lastTimestamp).toISOString(), stalenessMs: Math.max(0, fetchedAt - lastTimestamp) } : {}),
          candles: candles.map((candle) => ({ ...candle, timestamp: new Date(candle.timestamp).toISOString() })),
        },
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    const candles = await this.exchange.fetchOHLCV({ symbol, timeframe, limit });
    const fetchedAt = Date.now();
    const lastTimestamp = candles.at(-1)?.[0];
    return {
      success: true,
      data: {
        venue: this.exchange.id,
        source: 'exchange',
        symbol,
        timeframe,
        fetchedAt: new Date(fetchedAt).toISOString(),
        ...(typeof lastTimestamp === 'number' ? { asOf: new Date(lastTimestamp).toISOString(), stalenessMs: Math.max(0, fetchedAt - lastTimestamp) } : {}),
        candles: candles.map((c: [number, number, number, number, number, number]) => ({
          timestamp: new Date(c[0]).toISOString(),
          open: c[1],
          high: c[2],
          low: c[3],
          close: c[4],
          volume: c[5],
        })),
      },
      durationMs: Date.now() - start,
      truncated: false,
    };
  }

  private async getPortfolio(call: ToolCall): Promise<ToolResult> {
    const start = Date.now();
    const balances = await this.exchange.balances();
    return {
      success: true,
      data: balances,
      durationMs: Date.now() - start,
      truncated: false,
    };
  }

  private async getMarkets(call: ToolCall): Promise<ToolResult> {
    const start = Date.now();
    if (this.marketDataProvider) {
      const markets = await this.marketDataProvider.fetchUniverse();
      return {
        success: true,
        data: { source: this.marketDataSource, fetchedAt: new Date().toISOString(), markets: markets.map((symbol) => ({ symbol })) },
        durationMs: Date.now() - start,
        truncated: false,
      };
    }
    const markets = await this.exchange.fetchMarkets();
    return {
      success: true,
      data: { venue: this.exchange.id, source: 'exchange', fetchedAt: new Date().toISOString(), markets },
      durationMs: Date.now() - start,
      truncated: false,
    };
  }

  private resolveSymbol(call: ToolCall): string | undefined {
    const symbol = call.args.symbol;
    if (typeof symbol !== 'string') return undefined;
    const trimmed = symbol.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private resolveTimeframe(call: ToolCall): string | undefined {
    const timeframe = call.args.timeframe;
    if (typeof timeframe !== 'string') return undefined;
    const trimmed = timeframe.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
}
