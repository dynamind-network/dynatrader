export type ExchangeName =
  | "hyperliquid"
  | "binance"
  | "bybit"
  | "polymarket"
  | "coinbase";

export interface Ticker {
  symbol: string;
  price: number;
  change24h: number;
  changePercent24h: number;
  volume24h: number;
  high24h: number;
  low24h: number;
  timestamp: number;
}

export interface OrderBookEntry {
  price: number;
  size: number;
  total?: number;
}

export interface OrderBook {
  symbol: string;
  bids: OrderBookEntry[];
  asks: OrderBookEntry[];
  timestamp: number;
}

export interface OrderParams {
  symbol: string;
  side: "buy" | "sell";
  orderType: "market" | "limit";
  size: number;
  price?: number;
  reduceOnly?: boolean;
  postOnly?: boolean;
  timeInForce?: "GTC" | "IOC" | "FOK";
}

export interface OrderResult {
  success: boolean;
  orderId?: string;
  message?: string;
  filledPrice?: number;
  filledSize?: number;
}

export interface Position {
  symbol: string;
  side: "long" | "short";
  size: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  leverage: number;
  liquidationPrice?: number;
  marginUsed?: number;
  notionalValue?: number;
}

export interface Balance {
  total: number;
  available: number;
  locked: number;
  currency: string;
}

export interface ExchangeAdapter {
  name: ExchangeName;
  supports: ("spot" | "futures" | "options")[];
  isConnected(): boolean;
  connect(credentials?: ExchangeCredentials): Promise<void>;
  disconnect(): Promise<void>;
  getTicker(symbol: string): Promise<Ticker>;
  getAllTickers?(): Promise<Ticker[]>;
  getOrderBook(symbol: string, depth?: number): Promise<OrderBook>;
  placeOrder(params: OrderParams): Promise<OrderResult>;
  cancelOrder(orderId: string, symbol: string): Promise<OrderResult>;
  getPositions(): Promise<Position[]>;
  getBalance(): Promise<Balance>;
  getOpenOrders?(): Promise<OrderResult[]>;
  setLeverage?(symbol: string, leverage: number): Promise<void>;
  getFundingRates?(
    symbol: string,
  ): Promise<{ fundingRate: number; nextFundingTime: number }>;
}

export interface ExchangeCredentials {
  apiKey?: string;
  apiSecret?: string;
  privateKey?: string;
  userAddress?: string;
}

export interface ExchangeConfig {
  enabled: boolean;
  credentials: ExchangeCredentials;
  default?: boolean;
  testnet?: boolean;
}

export class ExchangeRegistry {
  private adapters: Map<ExchangeName, ExchangeAdapter> = new Map();
  private configs: Map<ExchangeName, ExchangeConfig> = new Map();
  private defaultExchange: ExchangeName | null = null;

  register(adapter: ExchangeAdapter, config?: ExchangeConfig): void {
    this.adapters.set(adapter.name, adapter);
    if (config) {
      this.configs.set(adapter.name, config);
      if (config.default) {
        this.defaultExchange = adapter.name;
      }
    }
    console.log(`[ExchangeRegistry] Registered exchange: ${adapter.name}`);
  }

  unregister(name: ExchangeName): boolean {
    if (this.defaultExchange === name) {
      this.defaultExchange = null;
    }
    this.configs.delete(name);
    return this.adapters.delete(name);
  }

  get(name: ExchangeName): ExchangeAdapter | undefined {
    return this.adapters.get(name);
  }

  getConfig(name: ExchangeName): ExchangeConfig | undefined {
    return this.configs.get(name);
  }

  has(name: ExchangeName): boolean {
    return this.adapters.has(name);
  }

  list(): ExchangeName[] {
    return Array.from(this.adapters.keys());
  }

  listEnabled(): ExchangeName[] {
    return Array.from(this.configs.entries())
      .filter(([, config]) => config.enabled)
      .map(([name]) => name);
  }

  setDefault(name: ExchangeName): void {
    if (!this.adapters.has(name)) {
      throw new Error(`Exchange ${name} not registered`);
    }
    this.defaultExchange = name;

    for (const [exchangeName, config] of this.configs) {
      this.configs.set(exchangeName, {
        ...config,
        default: exchangeName === name,
      });
    }
  }

  getDefault(): ExchangeName | null {
    return this.defaultExchange;
  }

  getDefaultAdapter(): ExchangeAdapter | undefined {
    if (this.defaultExchange) {
      return this.adapters.get(this.defaultExchange);
    }
    return this.adapters.values().next().value;
  }

  async connectAll(): Promise<void> {
    const connections: Promise<void>[] = [];

    for (const [name, config] of this.configs) {
      if (config.enabled) {
        const adapter = this.adapters.get(name);
        if (adapter && !adapter.isConnected()) {
          connections.push(
            adapter.connect(config.credentials).catch((error) => {
              console.error(
                `[ExchangeRegistry] Failed to connect ${name}:`,
                error,
              );
            }),
          );
        }
      }
    }

    await Promise.allSettled(connections);
  }

  async disconnectAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      if (adapter.isConnected()) {
        await adapter.disconnect();
      }
    }
  }

  clear(): void {
    this.adapters.clear();
    this.configs.clear();
    this.defaultExchange = null;
  }
}

let globalRegistry: ExchangeRegistry | null = null;

export function getExchangeRegistry(): ExchangeRegistry {
  if (!globalRegistry) {
    globalRegistry = new ExchangeRegistry();
  }
  return globalRegistry;
}

export function resetExchangeRegistry(): void {
  globalRegistry = null;
}
