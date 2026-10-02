/**
 * Technical Indicators
 *
 * Wraps technicalindicators library with normalized interfaces
 */

import type { SkillManifest } from "@dyna/contracts";
import {
  SMA,
  EMA,
  RSI,
  MACD,
  BollingerBands,
  ADX,
  ATR,
  Stochastic,
  IchimokuCloud,
} from "technicalindicators";

export interface IndicatorConfig {
  period: number;
  values?: number[];
  precision?: number;
}

export interface IndicatorResult {
  value: number;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export class TechnicalIndicators {
  // Simple Moving Average
  static async SMA(config: IndicatorConfig, data: OHLCV[]): Promise<IndicatorResult[]> {
    const sma = new SMA({
      period: config.period,
      values: data.map(d => d.close),
    });

    const results = sma.getResult();
    return results.map((value: number, index: number) => ({
      value,
      timestamp: new Date(data[index]!.timestamp),
      metadata: { period: config.period },
    }));
  }

  // Exponential Moving Average
  static async EMA(config: IndicatorConfig, data: OHLCV[]): Promise<IndicatorResult[]> {
    const ema = new EMA({
      period: config.period,
      values: data.map(d => d.close),
    });

    const results = ema.getResult();
    return results.map((value: number, index: number) => ({
      value,
      timestamp: new Date(data[index]!.timestamp),
      metadata: { period: config.period },
    }));
  }

  // Relative Strength Index
  static async RSI(config: IndicatorConfig, data: OHLCV[]): Promise<IndicatorResult[]> {
    const rsi = new RSI({
      period: config.period,
      values: data.map(d => d.close),
    });

    const results = rsi.getResult();
    return results.map((value: number, index: number) => ({
      value,
      timestamp: new Date(data[index]!.timestamp),
      metadata: { period: config.period },
    }));
  }

  // MACD
  static async MACD(config: IndicatorConfig, data: OHLCV[]): Promise<{
    macd: IndicatorResult[];
    signal: IndicatorResult[];
    histogram: IndicatorResult[];
  }> {
    const macd = new MACD({
      fastPeriod: config.period,
      slowPeriod: config.period * 2,
      signalPeriod: config.period / 2,
      values: data.map(d => d.close),
      SimpleMAOscillator: false,
      SimpleMASignal: false,
    });

    const results = macd.getResult();

    return {
      macd: results.map((r: { MACD: number; signal: number; histogram: number }, index: number) => ({
        value: r.MACD,
        timestamp: new Date(data[index]!.timestamp),
        metadata: { period: config.period },
      })),
      signal: results.map((r: { MACD: number; signal: number; histogram: number }, index: number) => ({
        value: r.signal,
        timestamp: new Date(data[index]!.timestamp),
        metadata: { period: config.period },
      })),
      histogram: results.map((r: { MACD: number; signal: number; histogram: number }, index: number) => ({
        value: r.histogram,
        timestamp: new Date(data[index]!.timestamp),
        metadata: { period: config.period },
      })),
    };
  }

  // Bollinger Bands
  static async BB(config: IndicatorConfig, data: OHLCV[]): Promise<{
    upper: IndicatorResult[];
    middle: IndicatorResult[];
    lower: IndicatorResult[];
  }> {
    const bb = new BollingerBands({
      period: config.period,
      stdDev: 2,
      values: data.map(d => d.close),
    });

    const results = bb.getResult();

    return {
      upper: results.map((r: { upper: number; middle: number; lower: number }, index: number) => ({
        value: r.upper,
        timestamp: new Date(data[index]!.timestamp),
        metadata: { period: config.period, stdDev: 2 },
      })),
      middle: results.map((r: { upper: number; middle: number; lower: number }, index: number) => ({
        value: r.middle,
        timestamp: new Date(data[index]!.timestamp),
        metadata: { period: config.period },
      })),
      lower: results.map((r: { upper: number; middle: number; lower: number }, index: number) => ({
        value: r.lower,
        timestamp: new Date(data[index]!.timestamp),
        metadata: { period: config.period, stdDev: 2 },
      })),
    };
  }

  // Average Directional Index
  static async ADX(config: IndicatorConfig, data: OHLCV[]): Promise<IndicatorResult[]> {
    const adx = new ADX({
      period: config.period,
      high: data.map(d => d.high),
      low: data.map(d => d.low),
      close: data.map(d => d.close),
    });

    const results = adx.getResult();
    return results.map((value: number, index: number) => ({
      value,
      timestamp: new Date(data[index]!.timestamp),
      metadata: { period: config.period },
    }));
  }

  // Average True Range
  static async ATR(config: IndicatorConfig, data: OHLCV[]): Promise<IndicatorResult[]> {
    const atr = new ATR({
      period: config.period,
      high: data.map(d => d.high),
      low: data.map(d => d.low),
      close: data.map(d => d.close),
    });

    const results = atr.getResult();
    return results.map((value: number, index: number) => ({
      value,
      timestamp: new Date(data[index]!.timestamp),
      metadata: { period: config.period },
    }));
  }

  // Stochastic Oscillator
  static async Stochastic(config: IndicatorConfig, data: OHLCV[]): Promise<{
    k: IndicatorResult[];
    d: IndicatorResult[];
  }> {
    const stochastic = new Stochastic({
      period: config.period,
      signalPeriod: Math.floor(config.period / 2),
      high: data.map(d => d.high),
      low: data.map(d => d.low),
      close: data.map(d => d.close),
    });

    const results = stochastic.getResult();

    return {
      k: results.map((r: { k: number; d: number }, index: number) => ({
        value: r.k,
        timestamp: new Date(data[index]!.timestamp),
        metadata: { kPeriod: config.period, dPeriod: Math.floor(config.period / 2) },
      })),
      d: results.map((r: { k: number; d: number }, index: number) => ({
        value: r.d,
        timestamp: new Date(data[index]!.timestamp),
        metadata: { kPeriod: config.period, dPeriod: Math.floor(config.period / 2) },
      })),
    };
  }

  // Ichimoku Cloud
  static async Ichimoku(config: IndicatorConfig, data: OHLCV[]): Promise<{
    tenkan: IndicatorResult[];
    kinjun: IndicatorResult[];
    senkouA: IndicatorResult[];
    senkouB: IndicatorResult[];
    chikou: IndicatorResult[];
  }> {
    const ichimoku = new IchimokuCloud({
      conversionPeriod: config.period,
      basePeriod: config.period * 3,
      spanPeriod: config.period * 2,
      displacement: config.period,
      high: data.map(d => d.high),
      low: data.map(d => d.low),
    });

    const results = ichimoku.getResult();

    return {
      tenkan: results.map((r: { conversion: number; base: number; spanA: number; spanB: number }, index: number) => ({
        value: r.conversion,
        timestamp: new Date(data[index]!.timestamp),
        metadata: { period: config.period },
      })),
      kinjun: results.map((r: { conversion: number; base: number; spanA: number; spanB: number }, index: number) => ({
        value: r.base,
        timestamp: new Date(data[index]!.timestamp),
        metadata: { period: config.period },
      })),
      senkouA: results.map((r: { conversion: number; base: number; spanA: number; spanB: number }, index: number) => ({
        value: r.spanA,
        timestamp: new Date(data[index]!.timestamp),
        metadata: { period: config.period },
      })),
      senkouB: results.map((r: { conversion: number; base: number; spanA: number; spanB: number }, index: number) => ({
        value: r.spanB,
        timestamp: new Date(data[index]!.timestamp),
        metadata: { period: config.period },
      })),
      chikou: results.map((r: { conversion: number; base: number; spanA: number; spanB: number }, index: number) => ({
        value: r.spanB,
        timestamp: new Date(data[index]!.timestamp),
        metadata: { period: config.period },
      })),
    };
  }

  // Strategy-specific indicator calculations
  static async calculateStrategyIndicators(
    strategy: SkillManifest,
    data: OHLCV[]
  ): Promise<Record<string, IndicatorResult[]>> {
    const indicators: Record<string, IndicatorResult[]> = {};

    const entry = strategy.entry as Record<string, unknown> | undefined;
    const exits = strategy.exits as Record<string, unknown> | undefined;
    const condition = findCondition(strategy, entry, exits);

    if (matchesStrategyCondition(condition, ["ema", "crossover", "moving average", "trend"])) {
      const fastPeriod = getNumericParam(entry, ["fastPeriod", "fast", "shortPeriod"], 10);
      const slowPeriod = getNumericParam(entry, ["slowPeriod", "slow", "longPeriod"], 20);
      indicators.fastMA = await this.EMA({ period: fastPeriod }, data);
      indicators.slowMA = await this.EMA({ period: slowPeriod }, data);
    }

    if (matchesStrategyCondition(condition, ["rsi", "oversold", "overbought", "mean reversion"])) {
      const period = getNumericParam(entry, ["period", "rsiPeriod"], 14);
      indicators.rsi = await this.RSI({ period }, data);
    }

    if (matchesStrategyCondition(condition, ["bollinger", "bb"])) {
      const period = getNumericParam(entry, ["period", "bbPeriod"], 20);
      const bb = await this.BB({ period }, data);
      indicators.bbUpper = bb.upper;
      indicators.bbMiddle = bb.middle;
      indicators.bbLower = bb.lower;
    }

    if (matchesStrategyCondition(condition, ["macd"])) {
      const period = getNumericParam(entry, ["fastPeriod", "period", "macdPeriod"], 12);
      const macd = await this.MACD({ period }, data);
      indicators.macd = macd.macd;
      indicators.macdSignal = macd.signal;
      indicators.macdHistogram = macd.histogram;
    }

    if (matchesStrategyCondition(condition, ["ichimoku"])) {
      const period = getNumericParam(entry, ["period", "conversionPeriod"], 9);
      const ichimoku = await this.Ichimoku({ period }, data);
      Object.assign(indicators, ichimoku);
    }

    return indicators;
  }
}

function findCondition(
  strategy: SkillManifest,
  entry?: Record<string, unknown>,
  exits?: Record<string, unknown>,
): string {
  const candidates = [
    strategy.id,
    strategy.timeframe ?? "",
    strategy.symbol,
    typeof entry?.condition === "string" ? entry.condition : "",
    typeof exits?.condition === "string" ? exits.condition : "",
    typeof exits?.exit === "string" ? exits.exit : "",
  ];

  return candidates.filter(Boolean).join(" ").toLowerCase();
}

function matchesStrategyCondition(condition: string, keywords: string[]): boolean {
  return keywords.some((keyword) => condition.includes(keyword));
}

function getNumericParam(
  entry: Record<string, unknown> | undefined,
  keys: string[],
  fallback: number,
): number {
  if (!entry) return fallback;

  for (const key of keys) {
    const value = entry[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }

  return fallback;
}
