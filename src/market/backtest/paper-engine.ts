/**
 * Paper Trading Engine
 *
 * Implements deterministic paper and backtest execution for DynaTrader strategies.
 * The engine is intentionally stateful and records portfolio/equity history so CLI
 * callers can persist full run artifacts.
 */

import type { ExchangeAdapter, OrderIntent, AgentTurnContext, TradeMode } from "@dyna/contracts";

export interface BacktestConfig {
  initialBalance: number;
  commissionRate: number;
  slippageRate: number;
  feeCurrency: string;
}

export interface TradeRecord {
  id: string;
  timestamp: Date;
  venue: string;
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit" | "stop" | "stop-limit";
  quantity: number;
  price: number;
  value: number;
  fees: number;
  slippage: number;
  status: "filled" | "cancelled" | "rejected";
  reason?: string;
  realizedPnL?: number;
}

export interface Position {
  symbol: string;
  quantity: number;
  averagePrice: number;
  unrealizedPnL: number;
  realizedPnL: number;
  trades: string[];
}

export interface Portfolio {
  balance: number;
  positions: Position[];
  totalValue: number;
  equity: number;
  margin: number;
  dailyPnL: number;
  totalPnL: number;
}

export interface EquityCurvePoint {
  timestamp: Date;
  equity: number;
  balance: number;
  totalValue: number;
  drawdown: number;
}

export interface DrawdownPoint {
  timestamp: Date;
  drawdown: number;
}

export interface BacktestResult {
  id: string;
  strategyId: string;
  symbol: string;
  venue: string;
  timeframe: string;
  startDate: Date;
  endDate: Date;
  trades: TradeRecord[];
  portfolioHistory: Portfolio[];
  equityCurve: EquityCurvePoint[];
  drawdownCurve: DrawdownPoint[];
  summary: BacktestSummary;
}

export interface BacktestSummary {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalVolume: number;
  totalFees: number;
  totalSlippage: number;
  maxDrawdown: number;
  sharpeRatio: number;
  profitFactor: number;
  finalEquity: number;
  totalReturn: number;
  annualizedReturn: number;
}

export interface OHLCVData {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketDataFeed {
  symbol: string;
  venue: string;
  data: OHLCVData[];
  currentIndex: number;
}

export class PaperEngine {
  private config: BacktestConfig;
  private adapter: ExchangeAdapter;
  private trades: Map<string, TradeRecord> = new Map();
  private portfolio: Portfolio;
  private marketFeeds: Map<string, MarketDataFeed> = new Map();
  private currentTime: Date;
  private backtestStartTime: Date | null = null;
  private backtestEndTime: Date | null = null;
  private portfolioHistory: Portfolio[] = [];
  private equityCurve: EquityCurvePoint[] = [];
  private drawdownCurve: DrawdownPoint[] = [];
  private peakEquity: number;

  constructor(config: BacktestConfig, adapter: ExchangeAdapter) {
    this.config = config;
    this.adapter = adapter;
    this.currentTime = new Date();
    this.peakEquity = config.initialBalance;
    this.portfolio = this.createInitialPortfolio();
  }

  /**
   * Initialize backtest with historical market data.
   */
  async initialize(
    symbol: string,
    data: OHLCVData[],
    startDate: Date,
    endDate: Date,
    venue = this.adapter.id,
  ): Promise<void> {
    if (data.length === 0) {
      throw new Error(`No market data provided for ${symbol}`);
    }

    const sorted = [...data].sort((a, b) => a.timestamp - b.timestamp);
    this.marketFeeds.set(symbol, {
      symbol,
      venue,
      data: sorted,
      currentIndex: 0,
    });

    this.currentTime = new Date(sorted[0]!.timestamp);
    this.backtestStartTime = startDate;
    this.backtestEndTime = endDate;
    this.resetState();
  }

  /**
   * Process a single time step for a symbol feed.
   */
  async step(symbol: string): Promise<void> {
    const feed = this.marketFeeds.get(symbol);
    if (!feed || feed.currentIndex >= feed.data.length) {
      return;
    }

    const currentCandle = feed.data[feed.currentIndex]!;
    this.currentTime = new Date(currentCandle.timestamp);

    await this.updatePortfolio(symbol, currentCandle);
    feed.currentIndex += 1;
    this.snapshotPortfolio(new Date(currentCandle.timestamp));
  }

  /**
   * Place an order in paper/backtest mode.
   */
  async placeOrder(intent: OrderIntent): Promise<TradeRecord> {
    if (intent.mode !== "paper" && intent.mode !== "backtest") {
      throw new Error(`Paper engine only supports paper/backtest mode, got: ${intent.mode}`);
    }

    const tradeId = `trade-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const timestamp = new Date();

    const feed = this.marketFeeds.get(intent.symbol);
    if (!feed) {
      throw new Error(`No market data for ${intent.symbol}`);
    }

    const currentCandle = this.getActiveCandle(feed);
    if (!currentCandle) {
      throw new Error(`No market data available at current time`);
    }

    const trade: TradeRecord = {
      id: tradeId,
      timestamp,
      venue: feed.venue,
      symbol: intent.symbol,
      side: intent.side,
      type: intent.type as TradeRecord["type"],
      quantity: intent.quantity,
      price: currentCandle.close,
      value: 0,
      fees: 0,
      slippage: 0,
      status: "filled",
    };

    const fillDecision = this.resolveFill(intent, currentCandle);
    if (!fillDecision.filled) {
      trade.status = "cancelled";
      trade.reason = fillDecision.reason;
      this.trades.set(tradeId, trade);
      return trade;
    }

    const price = fillDecision.price;
    const value = intent.quantity * price;
    const fees = value * this.config.commissionRate;
    const slippage = Math.abs(value * this.config.slippageRate);

    trade.price = price;
    trade.value = value;
    trade.fees = fees;
    trade.slippage = slippage;

    try {
      await this.executeTrade(trade);
    } catch (error) {
      trade.status = "rejected";
      trade.reason = error instanceof Error ? error.message : String(error);
    }

    this.trades.set(tradeId, trade);
    return trade;
  }

  /**
   * Cancel an order.
   */
  async cancelOrder(tradeId: string): Promise<void> {
    const trade = this.trades.get(tradeId);
    if (!trade) {
      throw new Error(`Trade not found: ${tradeId}`);
    }

    if (trade.status === "filled") {
      throw new Error("Cannot cancel a filled trade");
    }

    trade.status = "cancelled";
    this.trades.set(tradeId, trade);
  }

  /**
   * Get current portfolio state.
   */
  getPortfolio(): Portfolio {
    return this.clonePortfolio(this.portfolio);
  }

  /**
   * Get trade history.
   */
  getTrades(): TradeRecord[] {
    return Array.from(this.trades.values());
  }

  /**
   * Get the final backtest result.
   */
  getResult(strategyId: string, timeframe = "unknown"): BacktestResult {
    const feed = this.marketFeeds.values().next().value;
    if (!feed) {
      throw new Error("No market data loaded");
    }

    const startDate = this.backtestStartTime ?? new Date(feed.data[0]!.timestamp);
    const endDate = this.backtestEndTime ?? new Date(feed.data[feed.data.length - 1]!.timestamp);

    return {
      id: `backtest-${Date.now()}`,
      strategyId,
      symbol: feed.symbol,
      venue: feed.venue,
      timeframe,
      startDate,
      endDate,
      trades: this.getTrades(),
      portfolioHistory: this.portfolioHistory.length > 0
        ? this.portfolioHistory.map((portfolio) => this.clonePortfolio(portfolio))
        : [this.clonePortfolio(this.portfolio)],
      equityCurve: [...this.equityCurve],
      drawdownCurve: [...this.drawdownCurve],
      summary: this.calculateSummary(),
    };
  }

  private async executeTrade(trade: TradeRecord): Promise<void> {
    if (trade.side === "buy") {
      const position = this.portfolio.positions.find((p) => p.symbol === trade.symbol);
      if (position) {
        const totalValue = position.quantity * position.averagePrice + trade.quantity * trade.price;
        position.quantity += trade.quantity;
        position.averagePrice = totalValue / position.quantity;
      } else {
        this.portfolio.positions.push({
          symbol: trade.symbol,
          quantity: trade.quantity,
          averagePrice: trade.price,
          unrealizedPnL: 0,
          realizedPnL: 0,
          trades: [trade.id],
        });
      }

      this.portfolio.balance -= trade.value + trade.fees;
    } else {
      const position = this.portfolio.positions.find((p) => p.symbol === trade.symbol);
      if (!position || position.quantity < trade.quantity) {
        throw new Error(`Insufficient position for sell order: ${trade.symbol}`);
      }

      const realizedPnL = (trade.price - position.averagePrice) * trade.quantity;
      trade.realizedPnL = realizedPnL;
      position.realizedPnL += realizedPnL;
      position.quantity -= trade.quantity;

      if (position.quantity === 0) {
        this.portfolio.positions = this.portfolio.positions.filter((p) => p.symbol !== trade.symbol);
      } else {
        position.trades.push(trade.id);
      }

      this.portfolio.balance += trade.value - trade.fees;
    }

    this.updatePortfolioTotals();
    this.snapshotPortfolio(trade.timestamp);
  }

  private async updatePortfolio(symbol: string, candle: OHLCVData): Promise<void> {
    const position = this.portfolio.positions.find((p) => p.symbol === symbol);
    if (!position) {
      this.updatePortfolioTotals();
      return;
    }

    position.unrealizedPnL = (candle.close - position.averagePrice) * position.quantity;
    this.updatePortfolioTotals();
  }

  private updatePortfolioTotals(): void {
    let totalPositionValue = 0;

    for (const position of this.portfolio.positions) {
      const feed = this.marketFeeds.get(position.symbol);
      if (!feed) {
        continue;
      }

      const candle = this.getActiveCandle(feed);
      if (!candle) {
        continue;
      }

      const positionValue = position.quantity * candle.close;
      totalPositionValue += positionValue;
      position.unrealizedPnL = (candle.close - position.averagePrice) * position.quantity;
    }

    this.portfolio.totalValue = this.portfolio.balance + totalPositionValue;
    this.portfolio.equity = this.portfolio.totalValue;
    this.portfolio.totalPnL = this.portfolio.totalValue - this.config.initialBalance;
    this.portfolio.dailyPnL = this.portfolio.totalPnL;
  }

  private calculateSummary(): BacktestSummary {
    const trades = this.getTrades();
    const filledTrades = trades.filter((trade) => trade.status === "filled");
    const closedTrades = filledTrades.filter((trade) => typeof trade.realizedPnL === "number");
    const winningTrades = closedTrades.filter((trade) => (trade.realizedPnL ?? 0) > 0).length;
    const losingTrades = closedTrades.filter((trade) => (trade.realizedPnL ?? 0) < 0).length;
    const totalTrades = filledTrades.length;
    const winRate = closedTrades.length > 0 ? winningTrades / closedTrades.length : 0;
    const totalVolume = filledTrades.reduce((sum, trade) => sum + trade.value, 0);
    const totalFees = filledTrades.reduce((sum, trade) => sum + trade.fees, 0);
    const totalSlippage = filledTrades.reduce((sum, trade) => sum + trade.slippage, 0);

    const maxDrawdown = this.drawdownCurve.length > 0
      ? Math.max(...this.drawdownCurve.map((point) => point.drawdown))
      : 0;

    const returns = this.calculateReturnsFromEquityCurve();
    const avgReturn = returns.length > 0 ? returns.reduce((sum, value) => sum + value, 0) / returns.length : 0;
    const stdDev = returns.length > 0
      ? Math.sqrt(returns.reduce((sum, value) => sum + (value - avgReturn) ** 2, 0) / returns.length)
      : 0;
    const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0;

    const grossProfit = closedTrades
      .filter((trade) => (trade.realizedPnL ?? 0) > 0)
      .reduce((sum, trade) => sum + (trade.realizedPnL ?? 0), 0);
    const grossLoss = closedTrades
      .filter((trade) => (trade.realizedPnL ?? 0) < 0)
      .reduce((sum, trade) => sum + Math.abs(trade.realizedPnL ?? 0), 0);
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    const totalReturn = (this.portfolio.equity - this.config.initialBalance) / this.config.initialBalance;
    const start = this.backtestStartTime ?? this.currentTime;
    const end = this.backtestEndTime ?? this.currentTime;
    const days = Math.max((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24), 1 / 24);
    const annualizedReturn = days > 0 ? Math.pow(1 + totalReturn, 365 / days) - 1 : 0;

    return {
      totalTrades,
      winningTrades,
      losingTrades,
      winRate,
      totalVolume,
      totalFees,
      totalSlippage,
      maxDrawdown,
      sharpeRatio,
      profitFactor,
      finalEquity: this.portfolio.equity,
      totalReturn,
      annualizedReturn,
    };
  }

  private resolveFill(
    intent: OrderIntent,
    candle: OHLCVData,
  ): { filled: boolean; price: number; reason?: string } {
    if (intent.type === "market") {
      const price = candle.close * (1 + (intent.side === "buy" ? 1 : -1) * this.config.slippageRate);
      return { filled: true, price };
    }

    if (typeof intent.price !== "number") {
      return { filled: false, price: candle.close, reason: "Limit and stop orders require a price" };
    }

    const price = intent.price;
    let triggered = false;
    if (intent.type === "limit") {
      triggered =
        (intent.side === "buy" && candle.low <= price) ||
        (intent.side === "sell" && candle.high >= price);
    } else if (intent.type === "stop") {
      triggered =
        (intent.side === "buy" && candle.high >= price) ||
        (intent.side === "sell" && candle.low <= price);
    } else if (intent.type === "stop-limit") {
      triggered =
        (intent.side === "buy" && candle.high >= price) ||
        (intent.side === "sell" && candle.low <= price);
    }

    return triggered
      ? { filled: true, price }
      : { filled: false, price, reason: "Order was not triggered by historical price action" };
  }

  private createInitialPortfolio(): Portfolio {
    return {
      balance: this.config.initialBalance,
      positions: [],
      totalValue: this.config.initialBalance,
      equity: this.config.initialBalance,
      margin: 0,
      dailyPnL: 0,
      totalPnL: 0,
    };
  }

  private resetState(): void {
    this.portfolio = this.createInitialPortfolio();
    this.trades.clear();
    this.portfolioHistory = [];
    this.equityCurve = [];
    this.drawdownCurve = [];
    this.peakEquity = this.config.initialBalance;
    this.snapshotPortfolio(this.currentTime);
  }

  private snapshotPortfolio(timestamp: Date): void {
    this.updatePortfolioTotals();
    const snapshot = this.clonePortfolio(this.portfolio);
    this.portfolioHistory.push(snapshot);

    const drawdown = this.peakEquity > 0 ? (this.peakEquity - snapshot.equity) / this.peakEquity : 0;
    this.peakEquity = Math.max(this.peakEquity, snapshot.equity);
    this.equityCurve.push({
      timestamp: new Date(timestamp),
      equity: snapshot.equity,
      balance: snapshot.balance,
      totalValue: snapshot.totalValue,
      drawdown,
    });
    this.drawdownCurve.push({
      timestamp: new Date(timestamp),
      drawdown,
    });
  }

  private calculateReturnsFromEquityCurve(): number[] {
    if (this.equityCurve.length < 2) {
      return [];
    }

    const returns: number[] = [];
    for (let i = 1; i < this.equityCurve.length; i++) {
      const prev = this.equityCurve[i - 1]!;
      const current = this.equityCurve[i]!;
      if (prev.equity > 0) {
        returns.push((current.equity - prev.equity) / prev.equity);
      }
    }
    return returns;
  }

  private clonePortfolio(portfolio: Portfolio): Portfolio {
    return {
      balance: portfolio.balance,
      positions: portfolio.positions.map((position) => ({
        ...position,
        trades: [...position.trades],
      })),
      totalValue: portfolio.totalValue,
      equity: portfolio.equity,
      margin: portfolio.margin,
      dailyPnL: portfolio.dailyPnL,
      totalPnL: portfolio.totalPnL,
    };
  }


  private getActiveCandle(feed: MarketDataFeed): OHLCVData | null {
    if (feed.data.length === 0) {
      return null;
    }

    const currentIndex = feed.currentIndex;
    if (currentIndex > 0 && currentIndex <= feed.data.length) {
      return feed.data[currentIndex - 1] ?? null;
    }

    return feed.data[feed.data.length - 1] ?? null;
  }
}
