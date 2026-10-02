/**
 * Base class for technical analysis and backtesting tools
 */

import { BaseTool } from './base-tool.js';
import type { ToolResult } from '../core/types.js';
import { buildMarketUrl, getMarketKlinesPath } from '../config/market-provider.js';

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface AnalysisResult {
  title: string;
  analyses: string[][];
  metrics?: Record<string, unknown>;
}

/**
 * Abstract base class for analysis and backtesting tools
 */
export abstract class AnalysisTool extends BaseTool {
  /**
   * Fetch candle data from source (Binance, etc.)
   */
  protected async fetchCandleData(
    symbol: string,
    interval: string = '1h',
    limit: number = 100
  ): Promise<Candle[]> {
    const url = buildMarketUrl(getMarketKlinesPath(), {
      symbol,
      interval,
      limit,
    });

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch candles: ${response.statusText}`);
      }

      const klines = (await response.json()) as unknown[][];
      return klines.map((k) => ({
        time: k[0] as number,
        open: parseFloat(k[1] as string),
        high: parseFloat(k[2] as string),
        low: parseFloat(k[3] as string),
        close: parseFloat(k[4] as string),
        volume: parseFloat(k[7] as string),
      }));
    } catch (err) {
      console.error(`Error fetching candles for ${symbol}:`, err);
      return [];
    }
  }

  /**
   * Format analysis results for display
   */
  protected formatResults(title: string, analyses: string[][]): string[] {
    const output: string[] = [];
    output.push(`${title}`);
    output.push('━'.repeat(50));

    for (const analysis of analyses) {
      output.push(...analysis);
      output.push('');
    }

    return output;
  }

  /**
   * Abstract method - subclasses must implement their analysis
   */
  protected abstract runAnalysis(
    candles: Candle[],
    params: Record<string, unknown>
  ): AnalysisResult;

  /**
   * Execute analysis and return formatted result
   */
  protected async executeAnalysis(
    symbol: string,
    params: Record<string, unknown>
  ): Promise<ToolResult> {
    const interval = (params.interval as string) || '1h';
    const limit = (params.limit as number) || 100;

    const candles = await this.fetchCandleData(symbol, interval, limit);
    if (candles.length === 0) {
      return this.error(`Failed to fetch candle data for ${symbol}`);
    }

    const result = this.runAnalysis(candles, params);
    const output = this.formatResults(result.title, result.analyses);

    return this.success(output.join('\n'));
  }

  /**
   * Calculate Simple Moving Average
   */
  protected calculateSMA(candles: Candle[], period: number): number[] {
    const sma: number[] = [];

    for (let i = 0; i < candles.length; i++) {
      if (i < period - 1) {
        sma.push(NaN);
        continue;
      }

      const slice = candles.slice(i - period + 1, i + 1);
      const avg = slice.reduce((sum, c) => sum + c.close, 0) / period;
      sma.push(avg);
    }

    return sma;
  }

  /**
   * Calculate Exponential Moving Average
   */
  protected calculateEMA(candles: Candle[], period: number): number[] {
    const ema: number[] = [];
    const multiplier = 2 / (period + 1);

    // Start with SMA for first value
    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += candles[i].close;
    }
    let emaValue = sum / period;
    ema.push(emaValue);

    // Calculate EMA for remaining candles
    for (let i = period; i < candles.length; i++) {
      emaValue = (candles[i].close - emaValue) * multiplier + emaValue;
      ema.push(emaValue);
    }

    return ema;
  }

  /**
   * Calculate RSI (Relative Strength Index)
   */
  protected calculateRSI(candles: Candle[], period: number = 14): number[] {
    const rsi: number[] = [];
    const deltas: number[] = [];

    // Calculate price changes
    for (let i = 1; i < candles.length; i++) {
      deltas.push(candles[i].close - candles[i - 1].close);
    }

    // Calculate gains and losses
    let gainSum = 0;
    let lossSum = 0;

    for (let i = 0; i < period; i++) {
      const delta = deltas[i];
      if (delta > 0) gainSum += delta;
      else lossSum += -delta;
    }

    let avgGain = gainSum / period;
    let avgLoss = lossSum / period;

    // Calculate RSI
    for (let i = period; i < deltas.length; i++) {
      const delta = deltas[i];
      const gain = delta > 0 ? delta : 0;
      const loss = delta < 0 ? -delta : 0;

      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;

      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      const rsiValue = 100 - 100 / (1 + rs);
      rsi.push(rsiValue);
    }

    return rsi;
  }

  /**
   * Find support and resistance levels
   */
  protected findLevels(
    candles: Candle[],
    period: number = 20
  ): { support: number[]; resistance: number[] } {
    const support: number[] = [];
    const resistance: number[] = [];

    for (let i = period; i < candles.length; i++) {
      const slice = candles.slice(i - period, i + 1);
      const high = Math.max(...slice.map((c) => c.high));
      const low = Math.min(...slice.map((c) => c.low));

      if (candles[i].close === low) {
        support.push(low);
      }
      if (candles[i].close === high) {
        resistance.push(high);
      }
    }

    return { support, resistance };
  }

  /**
   * Calculate volatility
   */
  protected calculateVolatility(candles: Candle[], period: number = 20): number {
    const closes = candles.slice(-period).map((c) => c.close);
    const mean = closes.reduce((a, b) => a + b) / closes.length;
    const variance =
      closes.reduce((sum, close) => sum + Math.pow(close - mean, 2), 0) / closes.length;
    return Math.sqrt(variance);
  }
}

