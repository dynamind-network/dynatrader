// Technical analysis indicators

export interface OHLCV {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
}

export interface Indicator {
  name: string;
  value: string | number;
  signal: 'bullish' | 'bearish' | 'neutral';
  description?: string;
}

export interface OverallSignal {
  signal: 'bullish' | 'bearish' | 'neutral';
  bullish: number;
  bearish: number;
  neutral: number;
  confidence: number;
  summary?: string;
}

export interface AnalysisResults {
  momentum: Indicator[];
  trend: Indicator[];
  volatility: Indicator[];
  volume: Indicator[];
  levels: Indicator[];
  overall: OverallSignal;
}

/**
 * Calculate RSI (Relative Strength Index)
 */
function calculateRSI(candles: OHLCV[], period: number = 14): number {
  if (candles.length < period + 1) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = candles.length - period; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;
    if (change > 0) gains += change;
    else losses -= change;
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Calculate MACD (Moving Average Convergence Divergence)
 */
function calculateMACD(
  candles: OHLCV[],
  fast: number = 12,
  slow: number = 26,
  signal: number = 9
): { macd: number; signal: number; histogram: number } {
  const emaFast = calculateEMA(candles, fast);
  const emaSlow = calculateEMA(candles, slow);
  const macdLine = emaFast - emaSlow;

  // Simplified signal calculation
  const signalLine = macdLine * 0.9;

  return {
    macd: macdLine,
    signal: signalLine,
    histogram: macdLine - signalLine,
  };
}

/**
 * Calculate Exponential Moving Average
 */
function calculateEMA(candles: OHLCV[], period: number): number {
  if (candles.length < period) return candles[candles.length - 1]?.close || 0;

  const multiplier = 2 / (period + 1);
  let ema = candles[0].close;

  for (let i = 1; i < candles.length; i++) {
    ema = (candles[i].close - ema) * multiplier + ema;
  }

  return ema;
}

/**
 * Calculate Simple Moving Average
 */
function calculateSMA(candles: OHLCV[], period: number): number {
  if (candles.length < period) return candles[candles.length - 1]?.close || 0;

  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    sum += candles[i].close;
  }
  return sum / period;
}

/**
 * Calculate Bollinger Bands
 */
function calculateBollingerBands(
  candles: OHLCV[],
  period: number = 20,
  stdDev: number = 2
): { upper: number; middle: number; lower: number } {
  const sma = calculateSMA(candles, period);
  let variance = 0;

  for (let i = candles.length - period; i < candles.length; i++) {
    variance += Math.pow(candles[i].close - sma, 2);
  }

  const std = Math.sqrt(variance / period);

  return {
    upper: sma + stdDev * std,
    middle: sma,
    lower: sma - stdDev * std,
  };
}

/**
 * Calculate Stochastic RSI
 */
function calculateStochasticRSI(candles: OHLCV[], period: number = 14): number {
  if (candles.length < period * 2) return 50;

  const rsiValues: number[] = [];
  for (let i = period; i < candles.length; i++) {
    const slice = candles.slice(i - period, i);
    rsiValues.push(calculateRSI(slice, period));
  }

  if (rsiValues.length === 0) return 50;

  const max = Math.max(...rsiValues);
  const min = Math.min(...rsiValues);
  const current = rsiValues[rsiValues.length - 1];

  if (max === min) return 50;
  return ((current - min) / (max - min)) * 100;
}

/**
 * Calculate Average True Range (ATR)
 */
function calculateATR(candles: OHLCV[], period: number = 14): number {
  if (candles.length < period + 1) return 0;

  let trSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    trSum += tr;
  }

  return trSum / period;
}

/**
 * Calculate ADX (Average Directional Index)
 */
function calculateADX(candles: OHLCV[], period: number = 14): number {
  if (candles.length < period + 1) return 25;

  let plusDM = 0;
  let minusDM = 0;
  let trSum = 0;

  for (let i = candles.length - period; i < candles.length; i++) {
    const highDiff = candles[i].high - candles[i - 1].high;
    const lowDiff = candles[i - 1].low - candles[i].low;

    plusDM += highDiff > lowDiff && highDiff > 0 ? highDiff : 0;
    minusDM += lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0;

    trSum += Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
  }

  const tr = trSum / period;
  const plusDI = tr > 0 ? (plusDM / tr) * 100 : 0;
  const minusDI = tr > 0 ? (minusDM / tr) * 100 : 0;

  const dx = plusDI + minusDI > 0 ? (Math.abs(plusDI - minusDI) / (plusDI + minusDI)) * 100 : 0;

  return dx; // Simplified - real ADX requires EMA
}

/**
 * Calculate Williams %R
 */
function calculateWilliamsR(candles: OHLCV[], period: number = 14): number {
  if (candles.length < period) return -50;

  const recent = candles.slice(-period);
  const highest = Math.max(...recent.map((c) => c.high));
  const lowest = Math.min(...recent.map((c) => c.low));
  const current = candles[candles.length - 1].close;

  if (highest === lowest) return -50;

  return ((highest - current) / (highest - lowest)) * -100;
}

/**
 * Calculate OBV (On-Balance Volume)
 */
function calculateOBV(candles: OHLCV[]): number {
  let obv = 0;

  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close > candles[i - 1].close) {
      obv += candles[i].volume;
    } else if (candles[i].close < candles[i - 1].close) {
      obv -= candles[i].volume;
    }
  }

  return obv;
}

/**
 * Calculate VWAP (Volume Weighted Average Price)
 */
function calculateVWAP(candles: OHLCV[]): number {
  let volumeSum = 0;
  let priceVolumeSum = 0;

  for (const candle of candles) {
    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    priceVolumeSum += typicalPrice * candle.volume;
    volumeSum += candle.volume;
  }

  return volumeSum > 0 ? priceVolumeSum / volumeSum : 0;
}

/**
 * Calculate Fibonacci Retracement levels
 */
function calculateFibonacci(high: number, low: number): { level: number; price: number }[] {
  const diff = high - low;

  return [
    { level: 0.236, price: high - diff * 0.236 },
    { level: 0.382, price: high - diff * 0.382 },
    { level: 0.5, price: high - diff * 0.5 },
    { level: 0.618, price: high - diff * 0.618 },
    { level: 0.786, price: high - diff * 0.786 },
  ];
}

/**
 * Calculate pivot points
 */
function calculatePivotPoints(
  high: number,
  low: number,
  close: number
): { pp: number; r1: number; r2: number; s1: number; s2: number } {
  const pp = (high + low + close) / 3;
  const r1 = 2 * pp - low;
  const r2 = pp + (high - low);
  const s1 = 2 * pp - high;
  const s2 = pp - (high - low);

  return { pp, r1, r2, s1, s2 };
}

/**
 * Calculate all indicators for a given set of candles
 */
export function calculateAllIndicators(candles: OHLCV[], currentPrice: number): AnalysisResults {
  const indicators: AnalysisResults = {
    momentum: [],
    trend: [],
    volatility: [],
    volume: [],
    levels: [],
    overall: {
      signal: 'neutral',
      bullish: 0,
      bearish: 0,
      neutral: 0,
      confidence: 0,
    },
  };

  // RSI
  const rsi = calculateRSI(candles);
  indicators.momentum.push({
    name: 'RSI (14)',
    value: rsi.toFixed(1),
    signal: rsi > 70 ? 'bearish' : rsi < 30 ? 'bullish' : 'neutral',
    description: rsi > 70 ? 'Overbought' : rsi < 30 ? 'Oversold' : 'Neutral',
  });

  // Stochastic RSI
  const stochRSI = calculateStochasticRSI(candles);
  indicators.momentum.push({
    name: 'Stoch RSI',
    value: stochRSI.toFixed(1),
    signal: stochRSI > 80 ? 'bearish' : stochRSI < 20 ? 'bullish' : 'neutral',
    description: stochRSI > 80 ? 'Overbought' : stochRSI < 20 ? 'Oversold' : 'Neutral',
  });

  // MACD
  const macd = calculateMACD(candles);
  indicators.trend.push({
    name: 'MACD',
    value: macd.macd.toFixed(2),
    signal: macd.histogram > 0 ? 'bullish' : macd.histogram < 0 ? 'bearish' : 'neutral',
    description: macd.histogram > 0 ? 'Bullish momentum' : 'Bearish momentum',
  });

  // Moving Averages
  const ema20 = calculateEMA(candles, 20);
  const ema50 = calculateEMA(candles, 50);
  const ema200 = calculateEMA(candles, 200);

  indicators.trend.push({
    name: 'EMA 20',
    value: ema20.toFixed(2),
    signal: currentPrice > ema20 ? 'bullish' : 'bearish',
    description: currentPrice > ema20 ? 'Above EMA20' : 'Below EMA20',
  });

  indicators.trend.push({
    name: 'EMA 50',
    value: ema50.toFixed(2),
    signal: currentPrice > ema50 ? 'bullish' : 'bearish',
    description: currentPrice > ema50 ? 'Above EMA50' : 'Below EMA50',
  });

  indicators.trend.push({
    name: 'EMA 200',
    value: ema200.toFixed(2),
    signal: currentPrice > ema200 ? 'bullish' : 'bearish',
    description: currentPrice > ema200 ? 'Above EMA200 (long-term)' : 'Below EMA200',
  });

  // Golden/Death Cross
  const crossSignal = ema20 > ema50 ? 'bullish' : 'bearish';
  indicators.trend.push({
    name: 'MA Cross',
    value: ema20 > ema50 ? 'Golden' : 'Death',
    signal: crossSignal,
    description: ema20 > ema50 ? 'Golden cross (bullish)' : 'Death cross (bearish)',
  });

  // Bollinger Bands
  const bb = calculateBollingerBands(candles);
  indicators.volatility.push({
    name: 'BB Upper',
    value: bb.upper.toFixed(2),
    signal: currentPrice > bb.upper ? 'bearish' : 'neutral',
    description: currentPrice > bb.upper ? 'Above upper band' : 'Normal',
  });

  indicators.volatility.push({
    name: 'BB Middle',
    value: bb.middle.toFixed(2),
    signal: 'neutral',
    description: 'SMA 20',
  });

  indicators.volatility.push({
    name: 'BB Lower',
    value: bb.lower.toFixed(2),
    signal: currentPrice < bb.lower ? 'bullish' : 'neutral',
    description: currentPrice < bb.lower ? 'Below lower band (oversold)' : 'Normal',
  });

  // ATR
  const atr = calculateATR(candles);
  const atrPercent = (atr / currentPrice) * 100;
  indicators.volatility.push({
    name: 'ATR',
    value: `${atr.toFixed(2)} (${atrPercent.toFixed(1)}%)`,
    signal: atrPercent > 5 ? 'neutral' : 'neutral', // High volatility indicator
    description: atrPercent > 5 ? 'High volatility' : 'Normal volatility',
  });

  // Williams %R
  const williamsR = calculateWilliamsR(candles);
  indicators.momentum.push({
    name: 'Williams %R',
    value: williamsR.toFixed(1),
    signal: williamsR > -20 ? 'bearish' : williamsR < -80 ? 'bullish' : 'neutral',
    description: williamsR > -20 ? 'Overbought' : williamsR < -80 ? 'Oversold' : 'Neutral',
  });

  // ADX
  const adx = calculateADX(candles);
  indicators.trend.push({
    name: 'ADX',
    value: adx.toFixed(1),
    signal: adx > 25 ? 'neutral' : 'neutral', // Trend strength, not direction
    description: adx > 25 ? 'Strong trend' : 'Weak trend',
  });

  // OBV
  const obv = calculateOBV(candles);
  const obvSignal = obv > 0 ? 'bullish' : 'bearish';
  indicators.volume.push({
    name: 'OBV',
    value: obv.toLocaleString(),
    signal: obvSignal,
    description: obv > 0 ? 'Positive volume flow' : 'Negative volume flow',
  });

  // VWAP
  const vwap = calculateVWAP(candles);
  indicators.volume.push({
    name: 'VWAP',
    value: vwap.toFixed(2),
    signal: currentPrice > vwap ? 'bullish' : 'bearish',
    description: currentPrice > vwap ? 'Above VWAP' : 'Below VWAP',
  });

  // Volume analysis
  const avgVolume = candles.slice(-20).reduce((sum, c) => sum + c.volume, 0) / 20;
  const currentVolume = candles[candles.length - 1].volume;
  const volumeRatio = currentVolume / avgVolume;

  indicators.volume.push({
    name: 'Volume Ratio',
    value: volumeRatio.toFixed(2),
    signal: volumeRatio > 1.5 ? 'bullish' : volumeRatio < 0.5 ? 'bearish' : 'neutral',
    description:
      volumeRatio > 1.5 ? 'High volume' : volumeRatio < 0.5 ? 'Low volume' : 'Normal volume',
  });

  // Fibonacci levels
  const high = Math.max(...candles.slice(-50).map((c) => c.high));
  const low = Math.min(...candles.slice(-50).map((c) => c.low));
  const fibLevels = calculateFibonacci(high, low);

  for (const fib of fibLevels) {
    const distance = Math.abs(currentPrice - fib.price);
    const distancePercent = (distance / currentPrice) * 100;

    if (distancePercent < 2) {
      // Within 2% of level
      indicators.levels.push({
        name: `Fib ${(fib.level * 100).toFixed(0)}%`,
        value: fib.price.toFixed(2),
        signal: currentPrice > fib.price ? 'bullish' : 'bearish',
        description: currentPrice > fib.price ? 'Resistance' : 'Support',
      });
    }
  }

  // Pivot Points
  const pivot = calculatePivotPoints(high, low, currentPrice);
  indicators.levels.push({
    name: 'Pivot PP',
    value: pivot.pp.toFixed(2),
    signal: 'neutral',
    description: 'Pivot Point',
  });

  indicators.levels.push({
    name: 'R1',
    value: pivot.r1.toFixed(2),
    signal: currentPrice > pivot.r1 ? 'bearish' : 'neutral',
    description: 'Resistance 1',
  });

  indicators.levels.push({
    name: 'S1',
    value: pivot.s1.toFixed(2),
    signal: currentPrice < pivot.s1 ? 'bullish' : 'neutral',
    description: 'Support 1',
  });

  // Calculate overall signal
  const allIndicators = [
    ...indicators.momentum,
    ...indicators.trend,
    ...indicators.volatility,
    ...indicators.volume,
    ...indicators.levels,
  ];

  let bullish = 0;
  let bearish = 0;
  let neutral = 0;

  for (const ind of allIndicators) {
    if (ind.signal === 'bullish') bullish++;
    else if (ind.signal === 'bearish') bearish++;
    else neutral++;
  }

  const total = bullish + bearish + neutral;
  const confidence = total > 0 ? (Math.max(bullish, bearish) / total) * 100 : 0;

  indicators.overall = {
    signal: bullish > bearish ? 'bullish' : bearish > bullish ? 'bearish' : 'neutral',
    bullish,
    bearish,
    neutral,
    confidence,
    summary:
      bullish > bearish
        ? `Bullish (${bullish} of ${total})`
        : bearish > bullish
          ? `Bearish (${bearish} of ${total})`
          : `Neutral (${neutral} of ${total})`,
  };

  return indicators;
}
