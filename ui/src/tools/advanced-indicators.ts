import { BaseTool } from './base-tool.js';
import type { ToolExecutionContext, ToolResult } from '../core/types.js';
import { getErrorMessage } from '../utils/index.js';
import { buildMarketUrl, getMarketKlinesPath } from '../config/market-provider.js';

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Advanced Technical Analysis Tool
 * Implements: Ichimoku Cloud, Fibonacci Retracement, VWAP, Volume Profile
 */
export class AdvancedIndicatorsTool extends BaseTool {
  name = 'advanced_indicators';
  description = `Calculate advanced technical indicators:
- Ichimoku Cloud (trend, support/resistance)
- Fibonacci Retracement levels (trend reversal points)
- VWAP (Volume Weighted Average Price)
- Volume Profile (price distribution by volume)`;
  isDestructive = false;

  inputSchema = {
    type: 'object' as const,
    properties: {
      symbol: {
        type: 'string',
        description: 'Asset symbol to analyze',
      },
      indicators: {
        type: 'string',
        description: 'Comma-separated indicators: ichimoku, fibonacci, vwap, volume_profile',
      },
      trend_high: {
        type: 'number',
        description: 'High price for Fibonacci calculation (trend reference point)',
      },
      trend_low: {
        type: 'number',
        description: 'Low price for Fibonacci calculation (trend reference point)',
      },
    },
    required: ['symbol', 'indicators'],
  };

  async execute(
    input: Record<string, unknown>,
    _context: ToolExecutionContext
  ): Promise<ToolResult> {
    const symbol = (input.symbol as string).toUpperCase();
    const indicatorsStr = input.indicators as string;
    const indicators = indicatorsStr.split(',').map((s) => s.trim().toLowerCase());
    const trendHigh = input.trend_high as number;
    const trendLow = input.trend_low as number;

    try {
      const binanceSymbol = symbol.includes('USDT') ? symbol : `${symbol}USDT`;
      const url = buildMarketUrl(getMarketKlinesPath(), {
        symbol: binanceSymbol,
        interval: '1h',
        limit: 100,
      });

      const response = await fetch(url);
      if (!response.ok) {
        return this.error(`Failed to fetch data for ${symbol}`);
      }

      const klines = (await response.json()) as unknown[][];
      const candles = klines.map((k) => ({
        time: k[0] as number,
        open: parseFloat(k[1] as string),
        high: parseFloat(k[2] as string),
        low: parseFloat(k[3] as string),
        close: parseFloat(k[4] as string),
        volume: parseFloat(k[7] as string),
      }));

      const results: string[] = [`Advanced Indicators for ${symbol}`];
      results.push(`Data points: ${candles.length} candles`);
      results.push('');

      for (const indicator of indicators) {
        switch (indicator) {
          case 'ichimoku':
            results.push(...this.calculateIchimoku(candles));
            break;
          case 'fibonacci':
            if (trendHigh && trendLow && trendHigh > trendLow) {
              results.push(...this.calculateFibonacci(trendHigh, trendLow));
            } else {
              const high = Math.max(...candles.map((c) => c.high));
              const low = Math.min(...candles.map((c) => c.low));
              results.push(...this.calculateFibonacci(high, low));
            }
            break;
          case 'vwap':
            results.push(...this.calculateVWAP(candles));
            break;
          case 'volume_profile':
            results.push(...this.calculateVolumeProfile(candles));
            break;
        }
        results.push('');
      }

      return this.success(results.join('\n'));
    } catch (err) {
      return this.error(`Advanced analysis failed: ${getErrorMessage(err)}`);
    }
  }

  /**
   * Ichimoku Cloud - Comprehensive indicator for support/resistance and trend
   * Components:
   * - Tenkan-sen (9-period high-low midpoint)
   * - Kijun-sen (26-period high-low midpoint)
   * - Senkou Span A (Average of Tenkan and Kijun, plotted 26 periods ahead)
   * - Senkou Span B (52-period high-low midpoint, plotted 26 periods ahead)
   * - Chikou Span (Close plotted 26 periods in the past)
   */
  private calculateIchimoku(candles: Candle[]): string[] {
    const results: string[] = ['=== ICHIMOKU CLOUD ==='];

    if (candles.length < 52) {
      results.push('Insufficient data (need at least 52 candles)');
      return results;
    }

    // Last 26 candles for recent values
    const recent = candles.slice(-26);
    const last26 = candles.slice(-26);
    const last52 = candles.slice(-52);
    const last9 = recent.slice(-9);

    // Tenkan-sen: 9-period high-low midpoint
    const tenkan =
      (Math.max(...last9.map((c) => c.high)) + Math.min(...last9.map((c) => c.low))) / 2;

    // Kijun-sen: 26-period high-low midpoint
    const kijun =
      (Math.max(...last26.map((c) => c.high)) + Math.min(...last26.map((c) => c.low))) / 2;

    // Senkou Span A: Midpoint of Tenkan and Kijun (plotted 26 periods ahead)
    const senkouA = (tenkan + kijun) / 2;

    // Senkou Span B: 52-period high-low midpoint (plotted 26 periods ahead)
    const senkouB =
      (Math.max(...last52.map((c) => c.high)) + Math.min(...last52.map((c) => c.low))) / 2;

    // Chikou Span: Current close compared to 26 periods ago
    const chikouValue = candles[candles.length - 26]?.close || 0;

    const currentPrice = candles[candles.length - 1].close;

    // Cloud Analysis
    const cloudTop = Math.max(senkouA, senkouB);
    const cloudBottom = Math.min(senkouA, senkouB);
    const cloudThickness = cloudTop - cloudBottom;

    results.push('Components:');
    results.push(`  Tenkan-sen (9-period): ${tenkan.toFixed(2)}`);
    results.push(`  Kijun-sen (26-period): ${kijun.toFixed(2)}`);
    results.push(`  Senkou Span A: ${senkouA.toFixed(2)}`);
    results.push(`  Senkou Span B: ${senkouB.toFixed(2)}`);
    results.push(`  Chikou Span (26 back): ${chikouValue.toFixed(2)}`);
    results.push('');

    results.push('Cloud Analysis:');
    results.push(`  Cloud Top (Resistance): ${cloudTop.toFixed(2)}`);
    results.push(`  Cloud Bottom (Support): ${cloudBottom.toFixed(2)}`);
    results.push(`  Cloud Thickness: ${cloudThickness.toFixed(2)}`);
    results.push('');

    // Trend Signal
    const signal =
      currentPrice > cloudTop && tenkan > kijun
        ? 'STRONG BULLISH (Price above cloud, Tenkan > Kijun)'
        : currentPrice > cloudTop
          ? 'BULLISH (Price above cloud)'
          : currentPrice < cloudBottom && tenkan < kijun
            ? 'STRONG BEARISH (Price below cloud, Tenkan < Kijun)'
            : currentPrice < cloudBottom
              ? 'BEARISH (Price below cloud)'
              : 'NEUTRAL (Price in cloud)';

    results.push(`Signal: ${signal}`);
    results.push(`Current Price: ${currentPrice.toFixed(2)}`);

    return results;
  }

  /**
   * Fibonacci Retracement Levels
   * Shows potential support/resistance at key Fibonacci ratios (23.6%, 38.2%, 50%, 61.8%, 78.6%)
   */
  private calculateFibonacci(high: number, low: number): string[] {
    const results: string[] = ['=== FIBONACCI RETRACEMENT ==='];

    const difference = high - low;
    const levels = {
      '0.0%': high,
      '23.6%': high - difference * 0.236,
      '38.2%': high - difference * 0.382,
      '50.0%': high - difference * 0.5,
      '61.8%': high - difference * 0.618,
      '78.6%': high - difference * 0.786,
      '100.0%': low,
    };

    results.push(`Trend High: ${high.toFixed(2)}`);
    results.push(`Trend Low: ${low.toFixed(2)}`);
    results.push(`Difference: ${difference.toFixed(2)}`);
    results.push('');

    results.push('Retracement Levels:');
    for (const [label, level] of Object.entries(levels)) {
      results.push(`  ${label.padEnd(6)}: ${level.toFixed(2)}`);
    }

    results.push('');
    results.push('Trading Signals:');
    results.push('  - 38.2% & 50.0%: Shallow pullback (bullish)');
    results.push('  - 61.8%: Key retracement level (strong support/resistance)');
    results.push('  - 78.6%: Deep pullback (potential reversal)');

    return results;
  }

  /**
   * VWAP (Volume Weighted Average Price)
   * Shows fair value based on cumulative volume
   * Price above VWAP = overpriced, Price below VWAP = underpriced
   */
  private calculateVWAP(candles: Candle[]): string[] {
    const results: string[] = ['=== VWAP (Volume Weighted Average Price) ==='];

    let cumulativeTP = 0; // Cumulative typical price * volume
    let cumulativeVolume = 0;

    const vwapValues: number[] = [];

    for (const candle of candles) {
      const typicalPrice = (candle.high + candle.low + candle.close) / 3;
      cumulativeTP += typicalPrice * candle.volume;
      cumulativeVolume += candle.volume;
      vwapValues.push(cumulativeTP / cumulativeVolume);
    }

    const currentVWAP = vwapValues[vwapValues.length - 1];
    const previousVWAP = vwapValues[Math.max(0, vwapValues.length - 2)];
    const currentPrice = candles[candles.length - 1].close;

    const deviation = ((currentPrice - currentVWAP) / currentVWAP) * 100;

    results.push(`Current VWAP: ${currentVWAP.toFixed(2)}`);
    results.push(`Current Price: ${currentPrice.toFixed(2)}`);
    results.push(`Deviation: ${deviation > 0 ? '+' : ''}${deviation.toFixed(2)}%`);
    results.push(`VWAP Trend: ${currentVWAP > previousVWAP ? 'RISING' : 'FALLING'}`);
    results.push('');

    // Standard deviation bands (±1 standard deviation from VWAP)
    let sumSquaredDev = 0;
    for (let i = 0; i < vwapValues.length; i++) {
      sumSquaredDev += Math.pow(vwapValues[i] - currentVWAP, 2);
    }
    const stdDev = Math.sqrt(sumSquaredDev / vwapValues.length);

    results.push('VWAP Bands (±1 std dev):');
    results.push(`  Upper Band: ${(currentVWAP + stdDev).toFixed(2)}`);
    results.push(`  VWAP (Fair Value): ${currentVWAP.toFixed(2)}`);
    results.push(`  Lower Band: ${(currentVWAP - stdDev).toFixed(2)}`);
    results.push('');

    // Signal
    const signal =
      currentPrice > currentVWAP + stdDev
        ? 'OVERBOUGHT (Price far above VWAP)'
        : currentPrice > currentVWAP
          ? 'OVERPRICED (Price above VWAP)'
          : currentPrice < currentVWAP - stdDev
            ? 'OVERSOLD (Price far below VWAP)'
            : currentPrice < currentVWAP
              ? 'UNDERPRICED (Price below VWAP)'
              : 'FAIR VALUE (Price near VWAP)';

    results.push(`Signal: ${signal}`);

    return results;
  }

  /**
   * Volume Profile - Shows price distribution by volume
   * Helps identify support/resistance and liquidity levels
   */
  private calculateVolumeProfile(candles: Candle[]): string[] {
    const results: string[] = ['=== VOLUME PROFILE ==='];

    // Group volume by price ranges (20 buckets)
    const minPrice = Math.min(...candles.map((c) => c.low));
    const maxPrice = Math.max(...candles.map((c) => c.high));
    const buckets = 20;
    const bucketSize = (maxPrice - minPrice) / buckets;

    const volumeByPrice: Record<number, number> = {};
    for (let i = 0; i < buckets; i++) {
      volumeByPrice[i] = 0;
    }

    // Distribute volume into buckets
    for (const candle of candles) {
      const priceRange = (candle.high + candle.low) / 2;
      const bucketIndex = Math.floor((priceRange - minPrice) / bucketSize);
      const clampedIndex = Math.min(buckets - 1, Math.max(0, bucketIndex));
      volumeByPrice[clampedIndex] += candle.volume;
    }

    // Find max volume bucket (point of control)
    const maxVolume = Math.max(...Object.values(volumeByPrice));
    let pocBucket = '0';
    for (const [idx, vol] of Object.entries(volumeByPrice)) {
      if (vol === maxVolume) {
        pocBucket = idx;
        break;
      }
    }

    const pocPrice = minPrice + Number(pocBucket) * bucketSize + bucketSize / 2;

    results.push(`Price Range: $${minPrice.toFixed(2)} - $${maxPrice.toFixed(2)}`);
    results.push(`Bucket Size: $${bucketSize.toFixed(2)}`);
    results.push('');

    results.push('Volume Distribution (top 10 levels):');

    const sortedBuckets = Object.entries(volumeByPrice)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    for (const [bucketIdx, volume] of sortedBuckets) {
      const idx = Number(bucketIdx);
      const priceLevel = minPrice + idx * bucketSize + bucketSize / 2;
      const barLength = Math.round((volume / maxVolume) * 30);
      const bar = '█'.repeat(barLength);
      results.push(`  $${priceLevel.toFixed(2)}: ${bar} ${(volume / 1e6).toFixed(1)}M`);
    }

    results.push('');
    results.push(`Point of Control (POC): $${pocPrice.toFixed(2)}`);
    results.push(`  Highest volume traded at this price level`);
    results.push(`  Acts as strong support/resistance`);

    results.push('');
    results.push('Liquidity Analysis:');

    // Calculate value area (68% of volume)
    const totalVolume = Object.values(volumeByPrice).reduce((a, b) => a + b, 0);
    const valueAreaTarget = totalVolume * 0.68;

    let valueAreaVolume = 0;
    let lowestValueBucket = Number(pocBucket);
    let highestValueBucket = Number(pocBucket);

    while (
      valueAreaVolume < valueAreaTarget &&
      (lowestValueBucket > 0 || highestValueBucket < buckets - 1)
    ) {
      const lowerVol = lowestValueBucket > 0 ? volumeByPrice[lowestValueBucket - 1] : -1;
      const upperVol =
        highestValueBucket < buckets - 1 ? volumeByPrice[highestValueBucket + 1] : -1;

      if (lowerVol >= upperVol && lowerVol > 0) {
        valueAreaVolume += lowerVol;
        lowestValueBucket--;
      } else if (upperVol > 0) {
        valueAreaVolume += upperVol;
        highestValueBucket++;
      } else {
        break;
      }
    }

    const valueAreaHigh = minPrice + (highestValueBucket + 1) * bucketSize;
    const valueAreaLow = minPrice + lowestValueBucket * bucketSize;

    results.push(`Value Area: $${valueAreaLow.toFixed(2)} - $${valueAreaHigh.toFixed(2)}`);
    results.push(`  Contains 68% of trading activity`);

    return results;
  }
}
