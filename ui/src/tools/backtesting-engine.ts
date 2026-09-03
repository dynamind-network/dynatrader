import { BaseTool } from './base-tool.js';
import type { ToolExecutionContext, ToolResult } from '../core/types.js';
import { getErrorMessage } from '../utils/index.js';
import { buildMarketUrl, getMarketKlinesPath } from '../config/market-provider.js';
import {
  listWorkspaceStrategyTemplatesSync,
  resolveWorkspaceBacktestEngine,
} from './strategy-catalog.js';

interface BacktestCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface BacktestPosition {
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  entryTime: number;
  quantity: number;
  leverage?: number;
}

interface BacktestTrade {
  symbol: string;
  entryTime: number;
  exitTime: number;
  side: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnl: number;
  pnlPercent: number;
  duration: number;
}

/**
 * Backtesting Engine
 * Simulates trading strategies on historical data
 */
export class BacktestingEngineTool extends BaseTool {
  name = 'backtest';
  description = 'Backtest workspace-defined strategies on historical data.';
  isDestructive = false;
  private readonly engineHandlers: Record<
    string,
    (
      candles: BacktestCandle[],
      initialCapital: number,
      positionSize: number,
      leverage: number
    ) => {
      trades: BacktestTrade[];
      finalCapital: number;
    }
  >;

  inputSchema = {
    type: 'object' as const,
    properties: {
      symbol: {
        type: 'string',
        description: 'Asset symbol to backtest',
      },
      strategy: {
        type: 'string',
        description: 'Workspace-defined strategy name or template ID',
      },
      initial_capital: {
        type: 'number',
        description: 'Starting capital for backtest (default: 10000)',
      },
      position_size: {
        type: 'number',
        description: 'Position size percentage per trade (default: 0.1 = 10%)',
      },
      leverage: {
        type: 'number',
        description: 'Leverage multiplier (default: 1)',
      },
    },
    required: ['symbol', 'strategy'],
  };

  constructor() {
    super();
    this.engineHandlers = {
      sma_crossover: (candles, initialCapital, positionSize, leverage) =>
        this.smaCrossoverBacktest(candles, initialCapital, positionSize, leverage),
      mean_reversion: (candles, initialCapital, positionSize, leverage) =>
        this.meanReversionBacktest(candles, initialCapital, positionSize, leverage),
      momentum: (candles, initialCapital, positionSize, leverage) =>
        this.momentumBacktest(candles, initialCapital, positionSize, leverage),
      rsi_breakout: (candles, initialCapital, positionSize, leverage) =>
        this.rsiBreakoutBacktest(candles, initialCapital, positionSize, leverage),
    };

    const names = listWorkspaceStrategyTemplatesSync().map((template) => template.name);
    if (names.length > 0) {
      this.description = `Backtest workspace-defined strategies on historical data. Workspace templates: ${names.join(', ')}.`;
      this.inputSchema = {
        ...this.inputSchema,
        properties: {
          ...this.inputSchema.properties,
          strategy: {
            ...((this.inputSchema.properties as Record<string, unknown>).strategy as Record<
              string,
              unknown
            >),
            type: 'string',
            description: `Workspace-defined strategy name or template ID (${names.join(', ')})`,
          },
        },
      };
    }
  }

  async execute(
    input: Record<string, unknown>,
    _context: ToolExecutionContext
  ): Promise<ToolResult> {
    const symbol = (input.symbol as string).toUpperCase();
    const strategy = (input.strategy as string).toLowerCase();
    const resolvedStrategy = resolveWorkspaceBacktestEngine(strategy);
    const initialCapital = (input.initial_capital as number) || 10000;
    const positionSize = (input.position_size as number) || 0.1;
    const leverage = (input.leverage as number) || 1;

    try {
      const binanceSymbol = symbol.includes('USDT') ? symbol : `${symbol}USDT`;
      const url = buildMarketUrl(getMarketKlinesPath(), {
        symbol: binanceSymbol,
        interval: '1d',
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

      if (!resolvedStrategy) {
        return this.error(`Unknown workspace strategy: ${strategy}`);
      }

      const handler = this.engineHandlers[resolvedStrategy];
      if (!handler) {
        return this.error(`No backtest engine configured for strategy: ${strategy}`);
      }
      const backtest = handler(candles, initialCapital, positionSize, leverage);

      const results = this.formatBacktestResults(
        symbol,
        resolvedStrategy,
        backtest,
        initialCapital
      );
      return this.success(results);
    } catch (err) {
      return this.error(`Backtest failed: ${getErrorMessage(err)}`);
    }
  }

  /**
   * Execute generic backtest strategy with configurable entry/exit signals
   */
  private executeBacktestStrategy(
    candles: BacktestCandle[],
    initialCapital: number,
    positionSize: number,
    leverage: number,
    startIndex: number,
    entrySignal: (i: number) => boolean,
    exitSignal: (i: number) => boolean
  ) {
    const trades: BacktestTrade[] = [];
    let capital = initialCapital;
    let position: BacktestPosition | null = null;

    for (let i = startIndex; i < candles.length; i++) {
      const current = candles[i];

      if (!position && entrySignal(i)) {
        const tradeSize = (capital * positionSize * leverage) / current.close;
        position = {
          symbol: 'TEST',
          side: 'long',
          entryPrice: current.close,
          entryTime: current.time,
          quantity: tradeSize,
          leverage,
        };
      }

      if (position && exitSignal(i)) {
        const pnl = (current.close - position.entryPrice) * position.quantity;
        const pnlPercent = ((current.close - position.entryPrice) / position.entryPrice) * 100;
        trades.push({
          symbol: 'TEST',
          entryTime: position.entryTime,
          exitTime: current.time,
          side: 'long',
          entryPrice: position.entryPrice,
          exitPrice: current.close,
          quantity: position.quantity,
          pnl,
          pnlPercent,
          duration: current.time - position.entryTime,
        });
        capital += pnl;
        position = null;
      }
    }

    if (position) {
      const lastCandle = candles[candles.length - 1];
      const pnl = (lastCandle.close - position.entryPrice) * position.quantity;
      const pnlPercent = ((lastCandle.close - position.entryPrice) / position.entryPrice) * 100;
      trades.push({
        symbol: 'TEST',
        entryTime: position.entryTime,
        exitTime: lastCandle.time,
        side: 'long',
        entryPrice: position.entryPrice,
        exitPrice: lastCandle.close,
        quantity: position.quantity,
        pnl,
        pnlPercent,
        duration: lastCandle.time - position.entryTime,
      });
      capital += pnl;
    }

    return { trades, finalCapital: capital };
  }

  /**
   * SMA Crossover Strategy: Buy when SMA50 > SMA200, Sell when SMA50 < SMA200
   */
  private smaCrossoverBacktest(
    candles: BacktestCandle[],
    initialCapital: number,
    positionSize: number,
    leverage: number
  ) {
    return this.executeBacktestStrategy(
      candles,
      initialCapital,
      positionSize,
      leverage,
      50,
      (i) => {
        const sma50 = this.calculateSMA(
          candles.slice(i - 50, i).map((c) => c.close),
          50
        );
        const sma200 = this.calculateSMA(
          candles.slice(0, i + 1).map((c) => c.close),
          200
        );
        return sma50 > sma200;
      },
      (i) => {
        const sma50 = this.calculateSMA(
          candles.slice(i - 50, i).map((c) => c.close),
          50
        );
        const sma200 = this.calculateSMA(
          candles.slice(0, i + 1).map((c) => c.close),
          200
        );
        return sma50 < sma200;
      }
    );
  }

  /**
   * Mean Reversion: Buy at support (low price), Sell at resistance (high price)
   */
  private meanReversionBacktest(
    candles: BacktestCandle[],
    initialCapital: number,
    positionSize: number,
    leverage: number
  ) {
    return this.executeBacktestStrategy(
      candles,
      initialCapital,
      positionSize,
      leverage,
      20,
      (i) => {
        const recent = candles.slice(i - 20, i);
        const high = Math.max(...recent.map((c) => c.high));
        const low = Math.min(...recent.map((c) => c.low));
        return candles[i].close < low + (high - low) * 0.2;
      },
      (i) => {
        const recent = candles.slice(i - 20, i);
        const high = Math.max(...recent.map((c) => c.high));
        const low = Math.min(...recent.map((c) => c.low));
        return candles[i].close > high - (high - low) * 0.2;
      }
    );
  }

  /**
   * Momentum Strategy: Buy on uptrend, Sell on downtrend
   */
  private momentumBacktest(
    candles: BacktestCandle[],
    initialCapital: number,
    positionSize: number,
    leverage: number
  ) {
    return this.executeBacktestStrategy(
      candles,
      initialCapital,
      positionSize,
      leverage,
      5,
      (i) => candles[i].close - candles[i - 5].close > 0,
      (i) => candles[i].close - candles[i - 5].close < 0
    );
  }

  /**
   * RSI Breakout: Buy on RSI < 30 (oversold), Sell on RSI > 70 (overbought)
   */
  private rsiBreakoutBacktest(
    candles: BacktestCandle[],
    initialCapital: number,
    positionSize: number,
    leverage: number
  ) {
    return this.executeBacktestStrategy(
      candles,
      initialCapital,
      positionSize,
      leverage,
      14,
      (i) =>
        this.calculateRSI(
          candles.slice(0, i + 1).map((c) => c.close),
          14
        ) < 30,
      (i) =>
        this.calculateRSI(
          candles.slice(0, i + 1).map((c) => c.close),
          14
        ) > 70
    );
  }

  /**
   * Calculate SMA
   */
  private calculateSMA(prices: number[], period: number): number {
    const slice = prices.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  }

  /**
   * Calculate RSI
   */
  private calculateRSI(prices: number[], period: number): number {
    const changes: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      changes.push(prices[i] - prices[i - 1]);
    }

    const gains = changes.map((c) => (c > 0 ? c : 0));
    const losses = changes.map((c) => (c < 0 ? -c : 0));

    const avgGain = gains.slice(-period).reduce((a, b) => a + b, 0) / period;
    const avgLoss = losses.slice(-period).reduce((a, b) => a + b, 0) / period;

    if (avgLoss === 0) return 100;

    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  /**
   * Format and return backtest results
   */
  private formatBacktestResults(
    symbol: string,
    strategy: string,
    backtest: { trades: BacktestTrade[]; finalCapital: number },
    initialCapital: number
  ): string {
    const results: string[] = [];

    results.push(`=== BACKTEST RESULTS: ${symbol} (${strategy.toUpperCase()}) ===`);
    results.push('');

    // Summary metrics
    const totalReturn = backtest.finalCapital - initialCapital;
    const returnPercent = (totalReturn / initialCapital) * 100;
    const numTrades = backtest.trades.length;
    const winningTrades = backtest.trades.filter((t) => t.pnl > 0).length;
    const losingTrades = numTrades - winningTrades;
    const winRate = numTrades > 0 ? (winningTrades / numTrades) * 100 : 0;

    results.push('Performance Summary:');
    results.push(`  Initial Capital: $${initialCapital.toFixed(2)}`);
    results.push(`  Final Capital: $${backtest.finalCapital.toFixed(2)}`);
    results.push(
      `  Total Return: ${totalReturn >= 0 ? '+' : ''}$${totalReturn.toFixed(2)} (${returnPercent >= 0 ? '+' : ''}${returnPercent.toFixed(2)}%)`
    );
    results.push('');

    results.push('Trade Statistics:');
    results.push(`  Total Trades: ${numTrades}`);
    results.push(`  Winning Trades: ${winningTrades}`);
    results.push(`  Losing Trades: ${losingTrades}`);
    results.push(`  Win Rate: ${winRate.toFixed(2)}%`);
    results.push('');

    if (numTrades > 0) {
      const avgWin =
        backtest.trades.filter((t) => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0) /
        (winningTrades || 1);
      const avgLoss =
        backtest.trades.filter((t) => t.pnl < 0).reduce((sum, t) => sum + Math.abs(t.pnl), 0) /
        (losingTrades || 1);
      const profitFactor = avgWin > 0 && avgLoss > 0 ? avgWin / avgLoss : 0;

      const maxDrawdown = this.calculateMaxDrawdown(backtest.trades, initialCapital);
      const sharpeRatio = this.calculateSharpeRatio(backtest.trades);

      results.push('Advanced Metrics:');
      results.push(`  Average Win: $${avgWin.toFixed(2)}`);
      results.push(`  Average Loss: $${avgLoss.toFixed(2)}`);
      results.push(`  Profit Factor: ${profitFactor.toFixed(2)}`);
      results.push(`  Max Drawdown: ${maxDrawdown.toFixed(2)}%`);
      results.push(`  Sharpe Ratio: ${sharpeRatio.toFixed(2)}`);
      results.push('');

      results.push('Top 5 Trades:');
      const topTrades = backtest.trades.sort((a, b) => b.pnl - a.pnl).slice(0, 5);
      for (const trade of topTrades) {
        results.push(
          `  ${trade.side.toUpperCase()}: +$${trade.pnl.toFixed(2)} (${trade.pnlPercent.toFixed(2)}%)`
        );
      }
    }

    return results.join('\n');
  }

  /**
   * Calculate maximum drawdown percentage
   */
  private calculateMaxDrawdown(trades: BacktestTrade[], initialCapital: number): number {
    let runningCapital = initialCapital;
    let peakCapital = initialCapital;
    let maxDrawdown = 0;

    for (const trade of trades) {
      runningCapital += trade.pnl;
      if (runningCapital > peakCapital) {
        peakCapital = runningCapital;
      }
      const drawdown = ((peakCapital - runningCapital) / peakCapital) * 100;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }

    return maxDrawdown;
  }

  /**
   * Calculate Sharpe ratio
   */
  private calculateSharpeRatio(trades: BacktestTrade[]): number {
    if (trades.length === 0) return 0;

    const returns = trades.map((t) => t.pnlPercent);
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance =
      returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);

    return stdDev > 0 ? avgReturn / stdDev : 0;
  }
}
