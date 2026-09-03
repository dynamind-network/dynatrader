/**
 * Symbol Eligibility Filters
 *
 * Apply minimum thresholds to filter out ineligible symbols before scoring.
 * Each filter logs a skip reason so the operator can see exactly why a symbol
 * was excluded.
 */

import type { ScannerConfig, SymbolMarketData, ScoredSymbol } from "./types";

/**
 * Filter a single symbol's market data against eligibility criteria.
 * Returns the symbol marked as eligible or with a skip reason.
 */
export function filterSymbol(
  data: SymbolMarketData,
  config: ScannerConfig,
): ScoredSymbol {
  // Check 1: price data must be available
  if (!data.available) {
    return {
      symbol: data.symbol,
      liquidityScore: 0,
      volatilityScore: 0,
      trendScore: 0,
      riskPenalty: 0,
      signalScore: 0,
      totalScore: 0,
      bias: "NEUTRAL",
      reason: "Insufficient data",
      eligible: false,
      skipReason: data.unavailableReason ?? "SKIPPED: insufficient data",
    };
  }

  // Check 2: 24h volume must exceed minimum
  if (data.volume24hUsd < config.min24hVolumeUsd) {
    return {
      symbol: data.symbol,
      liquidityScore: 0,
      volatilityScore: 0,
      trendScore: 0,
      riskPenalty: 0,
      signalScore: 0,
      totalScore: 0,
      bias: "NEUTRAL",
      reason: "Insufficient volume",
      eligible: false,
      skipReason: `SKIPPED: 24h volume $${(data.volume24hUsd / 1e6).toFixed(1)}M below minimum $${(config.min24hVolumeUsd / 1e6).toFixed(0)}M`,
    };
  }

  // Check 3: spread must be below maximum
  if (data.spreadBps > config.maxSpreadBps) {
    return {
      symbol: data.symbol,
      liquidityScore: 0,
      volatilityScore: 0,
      trendScore: 0,
      riskPenalty: 0,
      signalScore: 0,
      totalScore: 0,
      bias: "NEUTRAL",
      reason: "Excessive spread",
      eligible: false,
      skipReason: `SKIPPED: spread ${data.spreadBps.toFixed(1)}bps exceeds max ${config.maxSpreadBps}bps`,
    };
  }

  // Check 4: estimated slippage must be acceptable
  if (data.estimatedSlippageBps > config.maxEstimatedSlippageBps) {
    return {
      symbol: data.symbol,
      liquidityScore: 0,
      volatilityScore: 0,
      trendScore: 0,
      riskPenalty: 0,
      signalScore: 0,
      totalScore: 0,
      bias: "NEUTRAL",
      reason: "Excessive slippage",
      eligible: false,
      skipReason: `SKIPPED: est. slippage ${data.estimatedSlippageBps.toFixed(1)}bps exceeds max ${config.maxEstimatedSlippageBps}bps`,
    };
  }

  // Check 5: must have enough candle history
  if (data.candleCount < config.minCandleHistory) {
    return {
      symbol: data.symbol,
      liquidityScore: 0,
      volatilityScore: 0,
      trendScore: 0,
      riskPenalty: 0,
      signalScore: 0,
      totalScore: 0,
      bias: "NEUTRAL",
      reason: "Insufficient history",
      eligible: false,
      skipReason: `SKIPPED: candle history ${data.candleCount} below minimum ${config.minCandleHistory}`,
    };
  }

  // Check 6: funding rate must not be extreme
  if (Math.abs(data.fundingRate) > config.maxFundingAbs) {
    return {
      symbol: data.symbol,
      liquidityScore: 0,
      volatilityScore: 0,
      trendScore: 0,
      riskPenalty: 0,
      signalScore: 0,
      totalScore: 0,
      bias: "NEUTRAL",
      reason: "Extreme funding",
      eligible: false,
      skipReason: `SKIPPED: funding rate ${(data.fundingRate * 100).toFixed(3)}% exceeds max ${(config.maxFundingAbs * 100).toFixed(1)}%`,
    };
  }

  // All checks passed
  return {
    symbol: data.symbol,
    liquidityScore: 0,
    volatilityScore: 0,
    trendScore: 0,
    riskPenalty: 0,
    signalScore: 0,
    totalScore: 0,
    bias: "NEUTRAL",
    reason: "Passed eligibility filters",
    eligible: true,
  };
}

/**
 * Filter an array of symbols. Returns eligible symbols and a list of skips.
 */
export function filterCandidates(
  allResults: ScoredSymbol[],
): {
  eligible: ScoredSymbol[];
  skipped: Array<{ symbol: string; reason: string }>;
} {
  const eligible: ScoredSymbol[] = [];
  const skipped: Array<{ symbol: string; reason: string }> = [];

  for (const result of allResults) {
    if (result.eligible) {
      eligible.push(result);
    } else if (result.skipReason) {
      skipped.push({ symbol: result.symbol, reason: result.skipReason });
    }
  }

  return { eligible, skipped };
}

/**
 * Rank and select top N candidates from eligible symbols.
 */
export function selectTopCandidates(
  eligible: ScoredSymbol[],
  topN: number,
): ScoredSymbol[] {
  return eligible
    .sort((a, b) => b.totalScore - a.totalScore)
    .slice(0, topN);
}
