/**
 * CCXT Exchange Adapter
 *
 * Wraps CCXT to provide a consistent interface for Dyna-Trader.
 * Handles exchange-specific normalization and error handling.
 */

import type { Exchange, Market, OHLCV as CCXT_OHLCV } from "ccxt";
import type { ExchangeAdapter, OrderIntent, AgentTurnContext } from "@dyna/contracts";

export interface CCXTAdapterConfig {
  exchangeId: string;
  apiKey?: string;
  secret?: string;
  passphrase?: string;
  sandbox?: boolean;
  options?: Partial<Exchange>;
}

export interface MarketInfo {
  symbol: string;
  baseCurrency: string;
  quoteCurrency: string;
  minPrice: number;
  minAmount: number;
  maxPrice?: number;
  maxAmount?: number;
  precision: {
    amount: number;
    price: number;
  };
  type: "spot" | "margin" | "future" | "swap";
  status: "active" | "suspended" | "closed";
}

export interface ExchangeCapabilities {
  spot: boolean;
  margin: boolean;
  futures: boolean;
  swaps: boolean;
 OHLCV: boolean;
  orders: boolean;
  cancelAllOrders: boolean;
  fetchOpenOrders: boolean;
  fetchClosedOrders: boolean;
  fetchMyTrades: boolean;
}

export class CCXTAdapter implements ExchangeAdapter {
  public readonly id: string;
  private exchangePromise?: Promise<Exchange>;
  private config: CCXTAdapterConfig;
  private marketsCache: Map<string, MarketInfo> = new Map();

  constructor(config: CCXTAdapterConfig) {
    this.config = config;
    this.id = config.exchangeId;
  }

  private getExchange(): Promise<Exchange> {
    this.exchangePromise ??= import("ccxt").then((module) => {
      const ccxt = module.default;
      const exchangeClass = (ccxt.pro as Record<string, new () => Exchange>)[this.config.exchangeId];
      if (!exchangeClass) throw new Error(`Unknown exchange: ${this.config.exchangeId}`);
      const exchange = new exchangeClass();
      if (this.config.apiKey) exchange.apiKey = this.config.apiKey;
      if (this.config.secret) exchange.secret = this.config.secret;
      if (this.config.passphrase) exchange.password = this.config.passphrase;
      if (this.config.sandbox) exchange.setSandboxMode(true);
      if (this.config.options) Object.assign(exchange, this.config.options);
      return exchange;
    });
    return this.exchangePromise;
  }

  /**
   * Get exchange capabilities
   */
  async capabilities(): Promise<Record<string, unknown>> {
    const exchange = await this.getExchange();
    const markets = await this.getNormalizedMarkets();

    return {
      name: exchange.name,
      version: exchange.version,
      urls: exchange.urls,
      has: {
        spot: markets.some(m => m.type === "spot"),
        margin: markets.some(m => m.type === "margin"),
        futures: markets.some(m => m.type === "future"),
        swaps: markets.some(m => m.type === "swap"),
        OHLCV: true, // Supported by CCXT
        orders: true, // Supported by CCXT
        cancelAllOrders: exchange.has.cancelAllOrders,
        fetchOpenOrders: exchange.has.fetchOpenOrders,
        fetchClosedOrders: exchange.has.fetchClosedOrders,
        fetchMyTrades: exchange.has.fetchMyTrades,
      },
      timeframes: Object.keys(exchange.timeframes || {}),
      tradingMode: (exchange as Exchange & { sandboxMode?: boolean }).sandboxMode ? "sandbox" : "live",
      id: exchange.id,
      countries: exchange.countries,
      rateLimit: exchange.rateLimit,
    };
  }

  /**
   * Fetch and normalize markets
   */
  async fetchMarkets(): Promise<Record<string, unknown>> {
    const markets = await this.getNormalizedMarkets();

    return {
      total: markets.length,
      markets: markets.map(market => ({
        symbol: market.symbol,
        baseCurrency: market.baseCurrency,
        quoteCurrency: market.quoteCurrency,
        type: market.type,
        status: market.status,
        precision: market.precision,
        limits: {
          amount: {
            min: market.minAmount,
            max: market.maxAmount,
          },
          price: {
            min: market.minPrice,
            max: market.maxPrice,
          },
          cost: {
            min: market.minAmount * market.minPrice,
            max: (market.maxAmount ?? Infinity) * (market.maxPrice ?? Infinity),
          },
        },
        formatted: {
          base: market.baseCurrency,
          quote: market.quoteCurrency,
          amountPrecision: market.precision.amount,
          pricePrecision: market.precision.price,
        },
      })),
    };
  }

  /**
   * Fetch OHLCV data with normalized format
   */
  async fetchOHLCV(req: { symbol: string; timeframe: string; since?: number; limit?: number }): Promise<Array<[number, number, number, number, number, number]>> {
    try {
      const exchange = await this.getExchange();
      // Validate timeframe
      if (!exchange.timeframes?.[req.timeframe]) {
        throw new Error(`Unsupported timeframe: ${req.timeframe}`);
      }

      // Convert timeframe to CCXT format if needed
      const ccxtTimeframe = this.normalizeTimeframe(req.timeframe);

      // Fetch data from CCXT
      const ohlcv = await exchange.fetchOHLCV(req.symbol, ccxtTimeframe, req.since, req.limit);

      // Normalize and validate data
      return ohlcv.map((candle) => {
        const timestamp = (candle[0] ?? 0) as number;
        const open = (candle[1] ?? 0) as number;
        const high = (candle[2] ?? 0) as number;
        const low = (candle[3] ?? 0) as number;
        const close = (candle[4] ?? 0) as number;
        const volume = (candle[5] ?? 0) as number;

        // Validate candle data
        if (typeof open !== "number" || typeof high !== "number" ||
            typeof low !== "number" || typeof close !== "number" ||
            typeof volume !== "number") {
          throw new Error(`Invalid candle data for symbol ${req.symbol} at timestamp ${timestamp}`);
        }

        // Check for invalid price values
        if ([open, high, low, close].some(price => price <= 0 || isNaN(price) || !isFinite(price))) {
          throw new Error(`Invalid price values for symbol ${req.symbol} at timestamp ${timestamp}`);
        }

        // Ensure high >= low >= open, close
        if (high < low || high < Math.max(open, close) || low > Math.min(open, close)) {
          throw new Error(`Invalid price relationships for symbol ${req.symbol} at timestamp ${timestamp}`);
        }

        return [timestamp, open, high, low, close, volume];
      });
    } catch (error) {
      throw new Error(`Failed to fetch OHLCV for ${req.symbol}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Fetch an order book with normalized bid/ask levels.
   */
  async fetchOrderBook(symbol: string, limit?: number): Promise<{ bids: Array<[number, number]>; asks: Array<[number, number]>; timestamp: number }> {
    try {
      const exchange = await this.getExchange();
      const orderBook = await exchange.fetchOrderBook(symbol, limit);
      const normalizeLevels = (levels: typeof orderBook.bids): Array<[number, number]> => {
        const normalized: Array<[number, number]> = [];
        for (const [price, amount] of levels) {
          if (typeof price !== "number" || !Number.isFinite(price) || typeof amount !== "number" || !Number.isFinite(amount)) continue;
          normalized.push([price, amount]);
        }
        return normalized;
      };
      return {
        bids: normalizeLevels(orderBook.bids),
        asks: normalizeLevels(orderBook.asks),
        timestamp: orderBook.timestamp ?? Date.now(),
      };
    } catch (error) {
      throw new Error(`Failed to fetch order book for ${symbol}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Fetch rolling 24-hour traded value in the market's quote currency.
   */
  async fetch24hQuoteVolume(symbol: string): Promise<number> {
    try {
      const ticker = await (await this.getExchange()).fetchTicker(symbol);
      if (typeof ticker.quoteVolume !== "number" || !Number.isFinite(ticker.quoteVolume)) {
        throw new Error(`24h quote volume unavailable for ${symbol}`);
      }
      return ticker.quoteVolume;
    } catch (error) {
      throw new Error(`Failed to fetch 24h quote volume for ${symbol}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get account balances
   */
  async balances(): Promise<Record<string, unknown>> {
    try {
      const balance = await (await this.getExchange()).fetchBalance();

      return {
        free: balance.free,
        used: balance.used,
        total: balance.total,
        equity: balance.info?.equity || balance.total,
        margin: balance.info?.margin || 0,
        profit: balance.info?.profit || 0,
        loans: balance.info?.loans || 0,
        maintenanceMargin: balance.info?.maintenanceMargin || 0,
      };
    } catch (error) {
      throw new Error(`Failed to fetch balances: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Place order with intent validation and normalization
   */
  async placeOrder(intent: OrderIntent): Promise<{ orderId: string; raw?: unknown }> {
    try {
      // Get market info for validation
      const market = await this.getMarket(intent.symbol);

      // Validate order parameters
      this.validateOrderIntent(intent, market);

      // Normalize order parameters
      const orderParams = this.normalizeOrderIntent(intent, market);

      // Place the order
      const order = await (await this.getExchange()).createOrder(
        intent.symbol,
        intent.type,
        intent.side,
        intent.quantity,
        intent.price,
        orderParams
      );

      // Extract order ID
      const orderId = order.id || order.info?.id || `manual-${Date.now()}`;

      return {
        orderId: String(orderId),
        raw: order,
      };
    } catch (error) {
      throw new Error(`Failed to place order: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Cancel order
   */
  async cancelOrder(req: { orderId: string; symbol: string }): Promise<void> {
    try {
      await (await this.getExchange()).cancelOrder(req.orderId, req.symbol);
    } catch (error) {
      throw new Error(`Failed to cancel order ${req.orderId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async fetchOrder(orderId: string, symbol: string) {
    try {
      const order = await (await this.getExchange()).fetchOrder(orderId, symbol);
      return {
        status: order.status ?? undefined,
        filled: order.filled ?? undefined,
        average: order.average ?? undefined,
        fee: order.fee?.cost ?? undefined,
        raw: order,
      };
    } catch (error) {
      throw new Error(`Failed to fetch order ${orderId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async fetchOpenOrders(symbol?: string): Promise<unknown[]> {
    return (await this.getExchange()).fetchOpenOrders(symbol);
  }

  async fetchPositions(): Promise<unknown[]> {
    const exchange = await this.getExchange();
    if (!exchange.fetchPositions) return [];
    return exchange.fetchPositions();
  }

  /**
   * Get normalized market info
   */
  private async getNormalizedMarkets(): Promise<MarketInfo[]> {
    if (this.marketsCache.size === 0) {
      const markets = await (await this.getExchange()).loadMarkets();

      for (const [symbol, rawMarket] of Object.entries(markets)) {
        if (!rawMarket) continue;
        const market: Market = rawMarket;
        const precision = market.precision ?? { amount: undefined, price: undefined };
        const limits = market.limits ?? {};
        const marketStatus = (market as unknown as Record<string, unknown>).status;
        const marketInfo: MarketInfo = {
          symbol,
          baseCurrency: market.base,
          quoteCurrency: market.quote,
          minPrice: limits.price?.min ?? 0,
          minAmount: limits.amount?.min ?? 0,
          maxPrice: limits.price?.max,
          maxAmount: limits.amount?.max,
          precision: {
            amount: precision.amount ?? 8,
            price: precision.price ?? 8,
          },
          type: this.getMarketType(market),
          status: marketStatus === "trading" ? "active" : (marketStatus as MarketInfo["status"]) ?? "active",
        };

        this.marketsCache.set(symbol, marketInfo);
      }
    }

    return Array.from(this.marketsCache.values());
  }

  /**
   * Get single market info
   */
  private async getMarket(symbol: string): Promise<MarketInfo> {
    const markets = await this.getNormalizedMarkets();
    const market = markets.find(m => m.symbol === symbol);

    if (!market) {
      throw new Error(`Market not found: ${symbol}`);
    }

    return market;
  }

  /**
   * Determine market type
   */
  private getMarketType(market: Market): "spot" | "margin" | "future" | "swap" {
    const m = market as unknown as Record<string, unknown>;
    if (m.future) return "future";
    if (m.swap) return "swap";
    if (m.margin) return "margin";
    return "spot";
  }

  /**
   * Normalize timeframe for CCXT
   */
  private normalizeTimeframe(timeframe: string): string {
    // Common timeframe mappings
    const mappings: Record<string, string> = {
      "1m": "1m",
      "5m": "5m",
      "15m": "15m",
      "30m": "30m",
      "1h": "1h",
      "2h": "2h",
      "4h": "4h",
      "6h": "6h",
      "8h": "8h",
      "12h": "12h",
      "1d": "1d",
      "3d": "3d",
      "1w": "1w",
      "1M": "1M",
    };

    const normalized = mappings[timeframe];
    if (!normalized) {
      throw new Error(`Unsupported timeframe: ${timeframe}`);
    }

    return normalized;
  }

  /**
   * Validate order intent against market rules
   */
  private validateOrderIntent(intent: OrderIntent, market: MarketInfo): void {
    // Check quantity
    if (intent.quantity < market.minAmount) {
      throw new Error(`Quantity ${intent.quantity} is below minimum ${market.minAmount}`);
    }

    if (market.maxAmount && intent.quantity > market.maxAmount) {
      throw new Error(`Quantity ${intent.quantity} exceeds maximum ${market.maxAmount}`);
    }

    // Check price if provided
    if (intent.price) {
      if (intent.price < market.minPrice) {
        throw new Error(`Price ${intent.price} is below minimum ${market.minPrice}`);
      }

      if (market.maxPrice && intent.price > market.maxPrice) {
        throw new Error(`Price ${intent.price} exceeds maximum ${market.maxPrice}`);
      }
    }

    // Validate side
    if (intent.side !== "buy" && intent.side !== "sell") {
      throw new Error(`Invalid side: ${intent.side}`);
    }

    // Validate type
    const validTypes = ["market", "limit", "stop", "stop-limit"];
    if (!validTypes.includes(intent.type)) {
      throw new Error(`Invalid order type: ${intent.type}`);
    }
  }

  /**
   * Normalize order parameters for CCXT
   */
  private normalizeOrderIntent(intent: OrderIntent, market: MarketInfo): Record<string, unknown> {
    const params: Record<string, unknown> = {};

    // Handle stop orders - these require a stopPrice parameter
    if (intent.type === "stop" || intent.type === "stop-limit") {
      // Use the stopPrice from intent if provided, otherwise use the price
      params.stopPrice = intent.stopPrice ?? intent.price;
      
      // For stop-limit orders, we also need a limit price
      if (intent.type === "stop-limit" && intent.limitPrice) {
        params.price = intent.limitPrice;
      }
    }

    // Exchange-specific parameters
    if (this.id === "binance") {
      // Binance uses timeInForce for certain order types
      if (intent.type === "limit" || intent.type === "stop-limit") {
        params.timeInForce = "GTC";
      }
    }

    return params;
  }
}
