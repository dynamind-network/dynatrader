/**
 * Scanner type definitions.
 * Defines the market scanning pipeline types for symbol discovery and ranking.
 */

import { z } from "zod";

/** Market bias direction */
export type MarketBias = "BULLISH" | "BEARISH" | "NEUTRAL";

/** Canonical symbol string (e.g., "BTC/USDT") */
export type Symbol = string;

/** Configuration for the market scanner */
export interface ScannerConfig {
  /** Minimum 24h volume in USD for eligibility */
  min24hVolumeUsd: number;
  /** Maximum spread in basis points for eligibility */
  maxSpreadBps: number;
  /** Maximum estimated slippage in basis points */
  maxEstimatedSlippageBps: number;
  /** Minimum number of candle history for eligibility */
  minCandleHistory: number;
  /** Maximum absolute funding rate (e.g., 0.05 for 5%) */
  maxFundingAbs: number;
  /** Number of top candidates to return */
  topCandidates: number;
}

/** Default scanner configuration */
export const DEFAULT_SCANNER_CONFIG: ScannerConfig = {
  min24hVolumeUsd: 5_000_000,
  maxSpreadBps: 10,
  maxEstimatedSlippageBps: 15,
  minCandleHistory: 200,
  maxFundingAbs: 0.05,
  topCandidates: 10,
};

/** A symbol that has been scored and evaluated */
export interface ScoredSymbol {
  /** Canonical symbol name (e.g., "BTC/USDT") */
  symbol: string;
  /** Volume, order book depth, spread score (0-1) */
  liquidityScore: number;
  /** ATR, realized volatility score (0-1) */
  volatilityScore: number;
  /** EMA, MACD, RSI, trend structure score (0-1) */
  trendScore: number;
  /** Funding, OI, liquidation risk penalty (0-1, higher = worse) */
  riskPenalty: number;
  /** IC, IR, confidence, regime match score (0-1) */
  signalScore: number;
  /** Weighted composite score (0-1) */
  totalScore: number;
  /** Market bias direction */
  bias: MarketBias;
  /** Human-readable reason for the top-scoring signal */
  reason: string;
  /** Whether the symbol passed all eligibility filters */
  eligible: boolean;
  /** If not eligible, the reason for skipping */
  skipReason?: string;
}

/** Raw market data for a single symbol */
export interface SymbolMarketData {
  symbol: string;
  /** Current mid price */
  price: number;
  /** 24h volume in USD */
  volume24hUsd: number;
  /** Bid-ask spread in basis points */
  spreadBps: number;
  /** Estimated slippage in basis points for the target position size */
  estimatedSlippageBps: number;
  /** Number of candles available */
  candleCount: number;
  /** Funding rate (annualized, e.g., 0.0001 = 0.01%) */
  fundingRate: number;
  /** Open interest change in the last 24h */
  oiChange24h: number;
  /** 24h high price */
  high24h: number;
  /** 24h low price */
  low24h: number;
  /** Available (true if all required data was fetched) */
  available: boolean;
  /** If unavailable, the reason */
  unavailableReason?: string;
}

/** Result from a complete market scan */
export interface ScannerResult {
  /** ISO timestamp of the scan */
  timestamp: string;
  /** Total number of symbols evaluated */
  symbolsScanned: number;
  /** Number that passed all eligibility filters */
  eligibleCount: number;
  /** Scored and ranked candidates (top N by totalScore) */
  candidates: ScoredSymbol[];
  /** Symbols that were skipped with reasons */
  skipped: Array<{ symbol: string; reason: string }>;
  /** Any issues encountered during scanning */
  issues: string[];
  /** Where the symbol universe came from */
  universeSource: "hyperliquid" | "fallback" | "failed";
}

/** Input for scoring a symbol */
export interface ScoringInput {
  marketData: SymbolMarketData;
  /** Simple trend detection */
  trend: MarketBias;
  /** Information coefficient score (0-1) */
  icScore: number;
  /** Information ratio score (0-1) */
  irScore: number;
  /** Regime: used for signal match scoring */
  regime: "trending_up" | "trending_down" | "ranging" | "volatile";
}

/** Result of universe fetch */
export interface UniverseFetchResult {
  symbols: string[];
  source: "hyperliquid" | "fallback" | "failed";
  issue?: string;
}
