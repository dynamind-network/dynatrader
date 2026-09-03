// WebSocket Types for Multi-Exchange Data Normalization

export type Exchange =
  'binance' | 'bybit' | 'okx' | 'bitget' | 'hyperliquid' | 'dydx' | 'kraken' | 'gmx' | 'gate';

export type Symbol = string; // BTC, ETH, SOL, etc.

// Normalized Ticker Data
export interface NormalizedTicker {
  symbol: Symbol;
  exchange: Exchange;
  markPrice: number;
  indexPrice: number;
  lastPrice: number;
  fundingRate: number;
  nextFundingTime: number;
  openInterest: number;
  openInterestValue: number; // in USD
  volume24h: number;
  volumeUsd24h: number;
  high24h: number;
  low24h: number;
  priceChange24h: number;
  priceChangePercent24h: number;
  timestamp: number;
}

// Normalized Trade Data
export interface NormalizedTrade {
  symbol: Symbol;
  exchange: Exchange;
  tradeId: string;
  price: number;
  size: number;
  side: 'buy' | 'sell';
  timestamp: number;
  isLiquidation: boolean;
  liquidationSide?: 'long' | 'short';
  usdValue: number;
}

// Normalized Orderbook Data
export interface NormalizedOrderbook {
  symbol: Symbol;
  exchange: Exchange;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  bestBid: number;
  bestAsk: number;
  spread: number;
  spreadPercent: number;
  timestamp: number;
}

export interface OrderbookLevel {
  price: number;
  size: number;
  total?: number; // cumulative size
}

// Normalized Funding Rate
export interface NormalizedFunding {
  symbol: Symbol;
  exchange: Exchange;
  fundingRate: number;
  predictedRate?: number;
  nextFundingTime: number;
  fundingInterval: number; // in hours (1, 4, 8)
  timestamp: number;
}

// Normalized Liquidation
export interface NormalizedLiquidation {
  symbol: Symbol;
  exchange: Exchange;
  side: 'long' | 'short';
  price: number;
  size: number;
  usdValue: number;
  timestamp: number;
}

// Aggregated Market Data (across all exchanges)
export interface AggregatedMarket {
  symbol: Symbol;
  avgPrice: number;
  weightedAvgPrice: number;
  minPrice: number;
  maxPrice: number;
  spread: number;
  spreadPercent: number;
  avgFundingRate: number;
  totalOpenInterest: number;
  totalVolume24h: number;
  priceChangePercent24h: number;
  exchangeCount: number;
  exchanges: Map<Exchange, NormalizedTicker>;
  lastUpdate: number;
}

// Connection State
export type ConnectionState =
  'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface ExchangeConnection {
  exchange: Exchange;
  state: ConnectionState;
  lastHeartbeat: number;
  reconnectAttempts: number;
  error?: string;
  latency?: number;
}

// WebSocket Message Types
export type MessageType = 'ticker' | 'trade' | 'orderbook' | 'funding' | 'liquidation';

export interface WebSocketMessage {
  type: MessageType;
  exchange: Exchange;
  data:
    | NormalizedTicker
    | NormalizedTrade
    | NormalizedOrderbook
    | NormalizedFunding
    | NormalizedLiquidation;
  timestamp: number;
}

// Exchange Adapter Interface
export interface ExchangeAdapter {
  exchange: Exchange;
  connect(): Promise<void>;
  disconnect(): void;
  subscribe(symbols: Symbol[], streams: MessageType[]): void;
  unsubscribe(symbols: Symbol[], streams: MessageType[]): void;
  getConnectionState(): ConnectionState;
  onMessage(callback: (message: WebSocketMessage) => void): void;
  onStateChange(callback: (state: ConnectionState) => void): void;
  onError(callback: (error: Error) => void): void;
}

// Manager Events
export interface ManagerEvents {
  ticker: (data: NormalizedTicker) => void;
  trade: (data: NormalizedTrade) => void;
  orderbook: (data: NormalizedOrderbook) => void;
  funding: (data: NormalizedFunding) => void;
  liquidation: (data: NormalizedLiquidation) => void;
  aggregated: (data: AggregatedMarket) => void;
  connectionChange: (connections: Map<Exchange, ExchangeConnection>) => void;
  exchangeError: (exchange: Exchange, error: Error) => void;
}

// Supported symbols per exchange
export const SUPPORTED_SYMBOLS: Symbol[] = [
  'BTC',
  'ETH',
  'SOL',
  'BNB',
  'XRP',
  'ADA',
  'AVAX',
  'DOGE',
  'LINK',
  'DOT',
  'MATIC',
  'UNI',
  'ATOM',
  'LTC',
  'ARB',
  'OP',
  'APT',
  'SUI',
  'INJ',
  'TIA',
  'SEI',
  'NEAR',
  'FTM',
  'AAVE',
];

// Symbol mapping per exchange (some use different formats)
export const SYMBOL_MAPPING: Record<Exchange, (symbol: Symbol) => string> = {
  binance: (s) => `${s}USDT`,
  bybit: (s) => `${s}USDT`,
  okx: (s) => `${s}-USDT-SWAP`,
  bitget: (s) => `${s}USDT`,
  hyperliquid: (s) => s,
  dydx: (s) => `${s}-USD`,
  kraken: (s) => `PF_${s}USD`,
  gmx: (s) => s,
  gate: (s) => `${s}_USDT`,
};

// Reverse symbol mapping (exchange format to normalized)
export const REVERSE_SYMBOL_MAPPING: Record<Exchange, (exchangeSymbol: string) => Symbol> = {
  binance: (s) => s.replace('USDT', ''),
  bybit: (s) => s.replace('USDT', ''),
  okx: (s) => s.split('-')[0],
  bitget: (s) => s.replace('USDT', ''),
  hyperliquid: (s) => s,
  dydx: (s) => s.replace('-USD', ''),
  kraken: (s) => s.replace('PF_', '').replace('USD', ''),
  gmx: (s) => s,
  gate: (s) => s.replace('_USDT', ''),
};
