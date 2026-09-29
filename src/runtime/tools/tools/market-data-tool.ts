import type { ToolCall, ToolResult, ToolHandler, ToolDefinition, ExchangeAdapter } from '@dyna/contracts';

export interface MarketDataToolConfig {
  exchange: ExchangeAdapter;
}

export class MarketDataTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'market_data',
    description: 'Fetch market data including OHLCV candles, current price, and account balances',
    category: 'market',
    inputSchema: {
      action: 'string',
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

  constructor(config: MarketDataToolConfig) {
    this.exchange = config.exchange;
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
      return {
        success: false,
        error: (err as Error).message ?? String(err),
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
    if (!timeframe) {
      return {
        success: false,
        error: 'market_data requires an explicit timeframe for price analysis. The agent should choose one after market discovery.',
        durationMs: Date.now() - start,
        truncated: false,
      };
    }
    const candles = await this.exchange.fetchOHLCV({ symbol, timeframe, limit: 1 });
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
    const limit = (call.args.limit as number) || 30;
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
