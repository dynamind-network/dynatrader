/**
 * Symbol Scoring Engine
 *
 * Computes multi-dimensional scores for each symbol and produces a composite
 * ranking. Scoring uses market data fetched from Hyperliquid API.
 *
 * Score dimensions:
 * - liquidityScore (30%): volume, order book, spread, slippage
 * - signalScore (25%): IC, IR, regime match
 * - trendScore (20%): price action, momentum
 * - volatilityScore (15%): ATR, realized vol
 * - riskPenalty (-10%): funding, OI, liquidation
 */

import type {
  MarketBias,
  ScannerConfig,
  ScoredSymbol,
  SymbolMarketData,
  ScoringInput,
} from "./types";

/** Score weights */
const WEIGHTS = {
  liquidity: 0.30,
  signal: 0.25,
  trend: 0.20,
  volatility: 0.15,
  riskPenalty: 0.10,
};

/**
 * Score a single symbol using its market data.
 */
export function scoreSymbol(
  marketData: SymbolMarketData,
  config: ScannerConfig,
  trend: MarketBias = "NEUTRAL",
  icScore: number = 0,
  irScore: number = 0,
  regime: ScoringInput["regime"] = "ranging",
): ScoredSymbol {
  // liquidityScore: volume normalized to 0-1 (log scale)
  const liquidityScore = normalizeVolume(marketData.volume24hUsd);

  // volatilityScore: based on ATR as % of price
  const volatilityScore = computeVolatilityScore(marketData);

  // trendScore: based on trend bias + recent price momentum
  const trendScore = computeTrendScore(trend, marketData);

  // riskPenalty: funding + OI change + range from 24h extremes
  const riskPenalty = computeRiskPenalty(marketData);

  // signalScore: IC/IR normalized + regime match
  const signalScore = computeSignalScore(icScore, irScore, regime, trend);

  // Composite score
  const totalScore = clamp01(
    WEIGHTS.liquidity * liquidityScore +
    WEIGHTS.signal * signalScore +
    WEIGHTS.trend * trendScore +
    WEIGHTS.volatility * volatilityScore -
    WEIGHTS.riskPenalty * riskPenalty,
  );

  // Generate reason string
  const reason = buildReason(liquidityScore, signalScore, trendScore, riskPenalty, trend);

  return {
    symbol: marketData.symbol,
    liquidityScore: round3(liquidityScore),
    volatilityScore: round3(volatilityScore),
    trendScore: round3(trendScore),
    riskPenalty: round3(riskPenalty),
    signalScore: round3(signalScore),
    totalScore: round3(totalScore),
    bias: trend,
    reason,
    eligible: true,
  };
}

/** Clamp a value to [0, 1] */
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** Round to 3 decimal places */
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

// --- Liquidity Scoring ---

function normalizeVolume(volumeUsd: number): number {
  const min = 5_000_000;
  const max = 500_000_000;
  const raw = Math.log10(Math.max(1, volumeUsd) / min) / Math.log10(max / min);
  return clamp01(raw);
}

// --- Volatility Scoring ---

function computeVolatilityScore(data: SymbolMarketData): number {
  if (data.price <= 0 || data.high24h <= 0 || data.low24h <= 0) return 0.5;

  const atrPct = (data.high24h - data.low24h) / data.price;
  const score = clamp01(1 - atrPct / 0.10);
  return round3(score);
}

// --- Trend Scoring ---

function computeTrendScore(trend: MarketBias, data: SymbolMarketData): number {
  let base = 0.5;

  if (trend === "BULLISH") base = 0.7;
  if (trend === "BEARISH") base = 0.6;

  if (data.price > 0 && data.high24h > 0 && data.low24h > 0) {
    const range = data.high24h - data.low24h;
    if (range > 0) {
      const position = (data.price - data.low24h) / range;
      if (trend === "BULLISH" && position > 0.7) base = Math.min(1, base + 0.1);
      if (trend === "BEARISH" && position < 0.3) base = Math.min(1, base + 0.1);
    }
  }

  return round3(clamp01(base));
}

// --- Risk Penalty ---

function computeRiskPenalty(data: SymbolMarketData): number {
  let penalty = 0;

  penalty += Math.min(1, Math.abs(data.fundingRate) / 0.05);
  penalty += Math.min(1, Math.abs(data.oiChange24h) / 0.50);

  if (data.price > 0 && data.high24h > 0 && data.low24h > 0) {
    const range = data.high24h - data.low24h;
    if (range > 0) {
      const upperReach = (data.price - data.low24h) / range;
      const lowerReach = (data.high24h - data.price) / range;
      const extremeReach = Math.max(upperReach, lowerReach);
      if (extremeReach > 0.9) penalty += 0.5;
      if (extremeReach > 0.95) penalty += 0.5;
    }
  }

  return round3(clamp01(penalty / 3));
}

// --- Signal Scoring ---

function computeSignalScore(
  icScore: number,
  irScore: number,
  regime: ScoringInput["regime"],
  trend: MarketBias,
): number {
  const icNorm = clamp01(icScore / 0.2);
  const irNorm = clamp01(irScore / 0.1);

  let regimeBonus = 0;
  if (regime === "trending_up" && trend === "BULLISH") regimeBonus = 0.2;
  if (regime === "trending_down" && trend === "BEARISH") regimeBonus = 0.2;
  if (regime === "volatile") regimeBonus = -0.2;

  const signal = icNorm * 0.5 + irNorm * 0.5 + regimeBonus;
  return round3(clamp01(signal));
}

// --- Reason Builder ---

function buildReason(
  liq: number,
  sig: number,
  _tr: number,
  risk: number,
  trend: MarketBias,
): string {
  const parts: string[] = [];

  if (trend === "BULLISH") parts.push("bullish momentum");
  else if (trend === "BEARISH") parts.push("bearish momentum");
  else parts.push("neutral price action");

  if (liq >= 0.8) parts.push("high liquidity");
  else if (liq < 0.3) parts.push("low liquidity");

  if (risk > 0.6) parts.push("elevated risk");
  else if (risk < 0.2) parts.push("low risk");

  if (sig > 0.7) parts.push("strong signal");
  else if (sig < 0.3) parts.push("weak signal");

  return parts.join(" | ") || "Mixed signals";
}
