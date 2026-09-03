/**
 * Type definitions for trading tools
 */

// API Response Types
export interface BinanceTicker {
  lastPrice: string;
  priceChangePercent: string;
  highPrice: string;
  lowPrice: string;
  volume: string;
  quoteVolume: string;
}

export interface YahooChartResult {
  chart: {
    result?: Array<{
      meta: {
        shortName?: string;
        regularMarketPrice?: number;
        previousClose?: number;
        regularMarketDayLow?: number;
        regularMarketDayHigh?: number;
        fiftyTwoWeekLow?: number;
        fiftyTwoWeekHigh?: number;
        regularMarketVolume?: number;
        marketCap?: number;
      };
      indicators: {
        quote: Array<{
          close: number[];
        }>;
      };
    }>;
  };
}

export interface ForexApiResult {
  result: string;
  rates: Record<string, number>;
  time_last_update_utc: string;
  error?: string;
}

// EVM Token Types
export interface EvmTokenConfig {
  symbol: string;
  address: string;
  decimals: number;
}

export interface EvmBalance {
  symbol: string;
  balance: string;
  value: string;
  chain: string;
}

// Hyperliquid Types
export interface HyperliquidPosition {
  symbol: string;
  size: number;
  entryPrice: number;
  markPrice: number;
  pnl: number;
  pnlPercent: number;
  leverage: number;
  liquidationPrice: number;
}

// Manual Position Types
export interface ManualPosition {
  id: string;
  symbol: string;
  entryPrice: number;
  size: number;
  pnl: number;
  extra?: string;
}

// Market Data Types
export interface TokenData {
  symbol: string;
  price: number;
  change24h: number;
  volume24h: number;
  marketCap: number;
}

export interface StockData {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  dayLow: number;
  dayHigh: number;
  volume: number;
  marketCap?: number;
}

export interface ForexData {
  pair: string;
  rate: number;
  time: string;
}

// Technical Analysis Types
export interface IndicatorResult {
  name: string;
  values: number[];
  signalLine?: number[];
}

export interface BacktestResult {
  strategy: string;
  winRate: number;
  totalReturn: number;
  maxDrawdown: number;
  trades: number;
  trades_won: number;
  trades_lost: number;
}
