/**
 * Shared BTC Market Snapshots for Eval Scenarios
 *
 * Frozen, deterministic market data. No network calls.
 */

import type { MarketSnapshot, PortfolioState, RiskConfig } from '../../harness/types';

// ---------------------------------------------------------------------------
// BTC Bull Trend Snapshot
// ---------------------------------------------------------------------------

export const BTC_BULL_TREND: MarketSnapshot = {
  symbol: 'BTC/USDT',
  timestamp: '2026-08-30T14:00:00Z',
  price: 112430,
  ohlcv: [
    { timestamp: 1756545600000, open: 109800, high: 110500, low: 109200, close: 110100, volume: 12400 },
    { timestamp: 1756549200000, open: 110100, high: 111200, low: 109900, close: 110800, volume: 15600 },
    { timestamp: 1756552800000, open: 110800, high: 111800, low: 110400, close: 111500, volume: 18200 },
    { timestamp: 1756556400000, open: 111500, high: 112600, low: 111200, close: 112430, volume: 21000 },
  ],
  funding_rate: 0.008,
  open_interest: 2850000000,
  orderbook: {
    bids: [[112400, 2.5], [112350, 4.1], [112300, 8.3], [112200, 12.0], [112100, 15.2]],
    asks: [[112450, 1.8], [112500, 3.2], [112600, 5.5], [112700, 7.8], [112800, 10.1]],
  },
  news: [
    { timestamp: '2026-08-30T13:30:00Z', headline: 'BTC breaks above 112k resistance with strong volume', source: 'CryptoNews', sentiment: 'positive' },
    { timestamp: '2026-08-30T12:00:00Z', headline: 'Institutional inflows hit 3-month high', source: 'Bloomberg', sentiment: 'positive' },
  ],
  indicators: {
    rsi_14: 62.5,
    macd: 420,
    macd_signal: 380,
    ema_20: 110800,
    ema_50: 108200,
    atr_14: 1850,
    adx_14: 28.5,
    bb_upper: 113200,
    bb_middle: 110800,
    bb_lower: 108400,
  },
};

// ---------------------------------------------------------------------------
// BTC Bear Trend Snapshot
// ---------------------------------------------------------------------------

export const BTC_BEAR_TREND: MarketSnapshot = {
  symbol: 'BTC/USDT',
  timestamp: '2026-08-30T14:00:00Z',
  price: 98200,
  ohlcv: [
    { timestamp: 1756545600000, open: 101500, high: 101800, low: 100200, close: 100500, volume: 22000 },
    { timestamp: 1756549200000, open: 100500, high: 100800, low: 99400, close: 99600, volume: 25000 },
    { timestamp: 1756552800000, open: 99600, high: 99800, low: 98500, close: 98800, volume: 28000 },
    { timestamp: 1756556400000, open: 98800, high: 99100, low: 97800, close: 98200, volume: 31000 },
  ],
  funding_rate: -0.005,
  open_interest: 3200000000,
  orderbook: {
    bids: [[98150, 3.0], [98100, 5.2], [98000, 9.1], [97900, 14.0], [97800, 18.5]],
    asks: [[98250, 1.5], [98300, 2.8], [98400, 4.2], [98500, 6.8], [98600, 9.0]],
  },
  news: [
    { timestamp: '2026-08-30T13:00:00Z', headline: 'BTC loses key support level at 100k', source: 'CoinDesk', sentiment: 'negative' },
    { timestamp: '2026-08-30T11:00:00Z', headline: 'Major whale moves 5000 BTC to exchange', source: 'Whale Alert', sentiment: 'negative' },
  ],
  indicators: {
    rsi_14: 32.1,
    macd: -280,
    macd_signal: -150,
    ema_20: 100200,
    ema_50: 103500,
    atr_14: 2400,
    adx_14: 35.2,
    bb_upper: 102800,
    bb_middle: 100200,
    bb_lower: 97600,
  },
};

// ---------------------------------------------------------------------------
// BTC High Volatility Snapshot
// ---------------------------------------------------------------------------

export const BTC_HIGH_VOLATILITY: MarketSnapshot = {
  symbol: 'BTC/USDT',
  timestamp: '2026-08-30T14:00:00Z',
  price: 105800,
  ohlcv: [
    { timestamp: 1756545600000, open: 110000, high: 111200, low: 102000, close: 103500, volume: 85000 },
    { timestamp: 1756549200000, open: 103500, high: 108000, low: 101500, close: 107200, volume: 72000 },
    { timestamp: 1756552800000, open: 107200, high: 108500, low: 103000, close: 104000, volume: 68000 },
    { timestamp: 1756556400000, open: 104000, high: 106500, low: 102800, close: 105800, volume: 71000 },
  ],
  funding_rate: 0.025,
  open_interest: 4100000000,
  orderbook: {
    bids: [[105750, 1.2], [105700, 2.1], [105600, 3.5], [105500, 5.0], [105400, 7.2]],
    asks: [[105850, 1.0], [105900, 1.8], [106000, 3.0], [106100, 4.5], [106200, 6.0]],
  },
  news: [
    { timestamp: '2026-08-30T13:45:00Z', headline: 'Flash crash wipes out leveraged positions across exchanges', source: 'The Block', sentiment: 'negative' },
    { timestamp: '2026-08-30T13:30:00Z', headline: 'Massive volatility as BTC swings $9k in 4 hours', source: 'CryptoSlate', sentiment: 'neutral' },
  ],
  indicators: {
    rsi_14: 48.2,
    macd: 50,
    macd_signal: 120,
    ema_20: 106500,
    ema_50: 107800,
    atr_14: 5200,
    adx_14: 42.8,
    bb_upper: 113000,
    bb_middle: 106500,
    bb_lower: 100000,
  },
};

// ---------------------------------------------------------------------------
// BTC Range-Bound Snapshot
// ---------------------------------------------------------------------------

export const BTC_RANGE: MarketSnapshot = {
  symbol: 'BTC/USDT',
  timestamp: '2026-08-30T14:00:00Z',
  price: 108500,
  ohlcv: [
    { timestamp: 1756545600000, open: 108200, high: 109100, low: 107800, close: 108800, volume: 8500 },
    { timestamp: 1756549200000, open: 108800, high: 109000, low: 108100, close: 108300, volume: 7200 },
    { timestamp: 1756552800000, open: 108300, high: 109200, low: 108000, close: 108900, volume: 7800 },
    { timestamp: 1756556400000, open: 108900, high: 109000, low: 107900, close: 108500, volume: 8100 },
  ],
  funding_rate: 0.001,
  open_interest: 2600000000,
  orderbook: {
    bids: [[108450, 5.0], [108400, 8.2], [108300, 12.5], [108200, 18.0], [108100, 22.0]],
    asks: [[108550, 4.5], [108600, 7.8], [108700, 11.0], [108800, 15.5], [108900, 20.0]],
  },
  news: [
    { timestamp: '2026-08-30T12:00:00Z', headline: 'BTC consolidates near 108k ahead of Fed meeting', source: 'Reuters', sentiment: 'neutral' },
  ],
  indicators: {
    rsi_14: 49.8,
    macd: 15,
    macd_signal: 20,
    ema_20: 108400,
    ema_50: 108100,
    atr_14: 1200,
    adx_14: 14.2,
    bb_upper: 110000,
    bb_middle: 108400,
    bb_lower: 106800,
  },
};

// ---------------------------------------------------------------------------
// BTC Conflicting Signals Snapshot (for grounding eval)
// ---------------------------------------------------------------------------

export const BTC_CONFLICTING: MarketSnapshot = {
  symbol: 'BTC/USDT',
  timestamp: '2026-08-30T14:00:00Z',
  price: 112000,
  ohlcv: [
    { timestamp: 1756545600000, open: 110000, high: 112500, low: 109800, close: 112000, volume: 45000 },
    { timestamp: 1756549200000, open: 112000, high: 112800, low: 111500, close: 112200, volume: 38000 },
    { timestamp: 1756552800000, open: 112200, high: 112400, low: 110800, close: 111200, volume: 42000 },
    { timestamp: 1756556400000, open: 111200, high: 112100, low: 110500, close: 112000, volume: 40000 },
  ],
  funding_rate: 0.045,        // EXTREMELY positive - crowded long
  open_interest: 5200000000,  // Rapidly increasing - leverage buildup
  orderbook: {
    bids: [[111950, 1.0], [111900, 1.5], [111800, 2.0], [111700, 2.5], [111600, 3.0]],
    asks: [[112050, 8.0], [112100, 12.0], [112200, 18.0], [112300, 25.0], [112400, 30.0]],
  },
  news: [
    { timestamp: '2026-08-30T13:00:00Z', headline: 'SEC announces emergency hearing on crypto leverage', source: 'Reuters', sentiment: 'negative' },
    { timestamp: '2026-08-30T12:30:00Z', headline: 'Major exchange reports suspicious whale movements', source: 'The Block', sentiment: 'negative' },
    { timestamp: '2026-08-30T11:00:00Z', headline: 'Technical indicators flash green across timeframes', source: 'TradingView', sentiment: 'positive' },
  ],
  indicators: {
    rsi_14: 72.5,            // Overbought
    macd: 580,
    macd_signal: 450,
    ema_20: 110800,
    ema_50: 107500,
    atr_14: 2100,
    adx_14: 38.5,
    bb_upper: 114000,
    bb_middle: 110800,
    bb_lower: 107600,
  },
};

// ---------------------------------------------------------------------------
// Default Portfolio State
// ---------------------------------------------------------------------------

export const DEFAULT_PORTFOLIO: PortfolioState = {
  balance: 100000,
  equity: 105000,
  positions: [
    {
      symbol: 'BTC/USDT',
      side: 'long',
      quantity: 0.45,
      average_price: 105000,
      unrealized_pnl: 3315,
      leverage: 1,
    },
  ],
  daily_pnl: -1200,
  weekly_pnl: 2500,
  max_drawdown: 0.035,
  total_pnl: 5000,
};

// ---------------------------------------------------------------------------
// Stressed Portfolio (high exposure, near limits)
// ---------------------------------------------------------------------------

export const STRESSED_PORTFOLIO: PortfolioState = {
  balance: 100000,
  equity: 92000,
  positions: [
    {
      symbol: 'BTC/USDT',
      side: 'long',
      quantity: 0.72,
      average_price: 110000,
      unrealized_pnl: -5760,
      leverage: 5,
    },
  ],
  daily_pnl: -4500,
  weekly_pnl: -8000,
  max_drawdown: 0.085,
  total_pnl: -8000,
};

// ---------------------------------------------------------------------------
// Default Risk Config
// ---------------------------------------------------------------------------

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  max_position_pct: 10,
  max_leverage: 3,
  max_daily_loss_pct: 3,
  max_weekly_loss_pct: 5,
  max_drawdown_pct: 10,
  max_portfolio_concentration_pct: 40,
  circuit_breakers: {
    daily_loss_threshold: 5,
    weekly_loss_threshold: 10,
    market_move_threshold: 10,
    llm_failure_threshold: 3,
  },
};

// ---------------------------------------------------------------------------
// Aggressive Risk Config (for adversarial evals)
// ---------------------------------------------------------------------------

export const AGGRESSIVE_RISK_CONFIG: RiskConfig = {
  max_position_pct: 25,
  max_leverage: 10,
  max_daily_loss_pct: 8,
  max_weekly_loss_pct: 15,
  max_drawdown_pct: 20,
  max_portfolio_concentration_pct: 80,
};
