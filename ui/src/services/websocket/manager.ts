import { EventEmitter } from 'events';
import {
  Exchange,
  Symbol,
  MessageType,
  NormalizedTicker,
  NormalizedTrade,
  NormalizedOrderbook,
  NormalizedFunding,
  NormalizedLiquidation,
  AggregatedMarket,
  ExchangeConnection,
  ConnectionState,
  WebSocketMessage,
  ExchangeAdapter,
  SUPPORTED_SYMBOLS,
} from './types.js';

// Import exchange adapters
import { BinanceAdapter } from './exchanges/binance.js';
import { BybitAdapter } from './exchanges/bybit.js';
import { OkxAdapter } from './exchanges/okx.js';
import { BitgetAdapter } from './exchanges/bitget.js';
import { HyperliquidAdapter } from './exchanges/hyperliquid.js';
import { DydxAdapter } from './exchanges/dydx.js';
import { KrakenAdapter } from './exchanges/kraken.js';
import { GmxAdapter } from './exchanges/gmx.js';
import { GateAdapter } from './exchanges/gate.js';

export const SUPPORTED_EXCHANGES: Exchange[] = [
  'binance',
  'bybit',
  'okx',
  'bitget',
  'hyperliquid',
  'dydx',
  'kraken',
  'gmx',
  'gate',
];

export class WebSocketManager extends EventEmitter {
  private adapters: Map<Exchange, ExchangeAdapter> = new Map();
  private connections: Map<Exchange, ExchangeConnection> = new Map();
  private tickers: Map<string, NormalizedTicker> = new Map(); // key: symbol-exchange
  private aggregatedMarkets: Map<Symbol, AggregatedMarket> = new Map();
  private recentTrades: NormalizedTrade[] = [];
  private recentLiquidations: NormalizedLiquidation[] = [];
  private orderbooks: Map<string, NormalizedOrderbook> = new Map();
  private fundingRates: Map<string, NormalizedFunding> = new Map();

  private subscribedSymbols: Symbol[] = [];
  private subscribedStreams: MessageType[] = ['ticker', 'trade', 'funding', 'liquidation'];
  private aggregationInterval: NodeJS.Timeout | null = null;
  private maxTrades = 100;
  private maxLiquidations = 50;

  constructor() {
    super();
    this.initializeAdapters();
  }

  private emitExchangeError(exchange: Exchange, error: Error): void {
    console.error(`[${exchange}] WebSocket error:`, error.message);
    this.emit('exchangeError', exchange, error);
  }

  private initializeAdapters(): void {
    const adapterClasses: Record<Exchange, new () => ExchangeAdapter> = {
      binance: BinanceAdapter,
      bybit: BybitAdapter,
      okx: OkxAdapter,
      bitget: BitgetAdapter,
      hyperliquid: HyperliquidAdapter,
      dydx: DydxAdapter,
      kraken: KrakenAdapter,
      gmx: GmxAdapter,
      gate: GateAdapter,
    };

    for (const exchange of SUPPORTED_EXCHANGES) {
      const AdapterClass = adapterClasses[exchange];
      const adapter = new AdapterClass();
      this.adapters.set(exchange, adapter);

      this.connections.set(exchange, {
        exchange,
        state: 'disconnected',
        lastHeartbeat: 0,
        reconnectAttempts: 0,
      });

      // Set up message handlers
      adapter.onMessage((message) => this.handleMessage(message));
      adapter.onStateChange((state) => this.handleStateChange(exchange, state));
      adapter.onError((error) => this.handleError(exchange, error));
    }
  }

  getSupportedExchanges(): Exchange[] {
    return [...SUPPORTED_EXCHANGES];
  }

  async connect(exchanges?: Exchange[]): Promise<void> {
    const targetExchanges = exchanges || Array.from(this.adapters.keys());

    const connectPromises = targetExchanges.map(async (exchange) => {
      const adapter = this.adapters.get(exchange);
      if (!adapter) return;

      try {
        this.updateConnectionState(exchange, 'connecting');
        await adapter.connect();
        this.updateConnectionState(exchange, 'connected');
      } catch (error) {
        const connectionError =
          error instanceof Error ? error : new Error(`Failed to connect to ${exchange}`);
        this.updateConnectionState(exchange, 'error', connectionError.message);
        this.emitExchangeError(exchange, connectionError);
      }
    });

    await Promise.allSettled(connectPromises);
    this.startAggregation();
  }

  disconnect(exchanges?: Exchange[]): void {
    const targetExchanges = exchanges || Array.from(this.adapters.keys());

    for (const exchange of targetExchanges) {
      const adapter = this.adapters.get(exchange);
      if (adapter) {
        adapter.disconnect();
        this.updateConnectionState(exchange, 'disconnected');
      }
    }

    if (!exchanges || exchanges.length === this.adapters.size) {
      this.stopAggregation();
    }
  }

  subscribe(symbols: Symbol[], streams?: MessageType[]): void {
    this.subscribedSymbols = [...new Set([...this.subscribedSymbols, ...symbols])];
    if (streams) {
      this.subscribedStreams = [...new Set([...this.subscribedStreams, ...streams])];
    }

    for (const [, adapter] of this.adapters) {
      if (adapter.getConnectionState() === 'connected') {
        adapter.subscribe(symbols, this.subscribedStreams);
      }
    }
  }

  unsubscribe(symbols: Symbol[], streams?: MessageType[]): void {
    this.subscribedSymbols = this.subscribedSymbols.filter((s) => !symbols.includes(s));

    for (const [, adapter] of this.adapters) {
      if (adapter.getConnectionState() === 'connected') {
        adapter.unsubscribe(symbols, streams || this.subscribedStreams);
      }
    }
  }

  private handleMessage(message: WebSocketMessage): void {
    const { type, exchange, data, timestamp } = message;

    switch (type) {
      case 'ticker':
        this.processTicker(data as NormalizedTicker);
        break;
      case 'trade':
        this.processTrade(data as NormalizedTrade);
        break;
      case 'orderbook':
        this.processOrderbook(data as NormalizedOrderbook);
        break;
      case 'funding':
        this.processFunding(data as NormalizedFunding);
        break;
      case 'liquidation':
        this.processLiquidation(data as NormalizedLiquidation);
        break;
    }

    // Update heartbeat
    const connection = this.connections.get(exchange);
    if (connection) {
      connection.lastHeartbeat = timestamp;
      this.connections.set(exchange, connection);
    }
  }

  private isTrackedSymbol(symbol: Symbol): boolean {
    return this.subscribedSymbols.length === 0 || this.subscribedSymbols.includes(symbol);
  }

  private preferNonZero(next: number, previous: number): number {
    return next !== 0 ? next : previous;
  }

  private mergeTicker(
    previous: NormalizedTicker | undefined,
    next: NormalizedTicker
  ): NormalizedTicker {
    if (!previous) {
      return next;
    }

    return {
      ...previous,
      ...next,
      markPrice: this.preferNonZero(next.markPrice, previous.markPrice),
      indexPrice: this.preferNonZero(next.indexPrice, previous.indexPrice),
      lastPrice: this.preferNonZero(next.lastPrice, previous.lastPrice),
      fundingRate: this.preferNonZero(next.fundingRate, previous.fundingRate),
      nextFundingTime: this.preferNonZero(next.nextFundingTime, previous.nextFundingTime),
      openInterest: this.preferNonZero(next.openInterest, previous.openInterest),
      openInterestValue: this.preferNonZero(next.openInterestValue, previous.openInterestValue),
      volume24h: this.preferNonZero(next.volume24h, previous.volume24h),
      volumeUsd24h: this.preferNonZero(next.volumeUsd24h, previous.volumeUsd24h),
      high24h: this.preferNonZero(next.high24h, previous.high24h),
      low24h: this.preferNonZero(next.low24h, previous.low24h),
      priceChange24h: this.preferNonZero(next.priceChange24h, previous.priceChange24h),
      priceChangePercent24h: this.preferNonZero(
        next.priceChangePercent24h,
        previous.priceChangePercent24h
      ),
      timestamp: Math.max(previous.timestamp, next.timestamp),
    };
  }

  private processTicker(ticker: NormalizedTicker): void {
    if (!this.isTrackedSymbol(ticker.symbol)) {
      return;
    }

    const key = `${ticker.symbol}-${ticker.exchange}`;
    const previous = this.tickers.get(key);
    const mergedTicker = this.mergeTicker(previous, ticker);
    this.tickers.set(key, mergedTicker);
    this.emit('ticker', mergedTicker);
  }

  private processTrade(trade: NormalizedTrade): void {
    if (!this.isTrackedSymbol(trade.symbol)) {
      return;
    }

    this.recentTrades.unshift(trade);
    if (this.recentTrades.length > this.maxTrades) {
      this.recentTrades.pop();
    }
    this.emit('trade', trade);
  }

  private processOrderbook(orderbook: NormalizedOrderbook): void {
    if (!this.isTrackedSymbol(orderbook.symbol)) {
      return;
    }

    const key = `${orderbook.symbol}-${orderbook.exchange}`;
    this.orderbooks.set(key, orderbook);
    this.emit('orderbook', orderbook);
  }

  private processFunding(funding: NormalizedFunding): void {
    if (!this.isTrackedSymbol(funding.symbol)) {
      return;
    }

    const key = `${funding.symbol}-${funding.exchange}`;
    this.fundingRates.set(key, funding);
    this.emit('funding', funding);
  }

  private processLiquidation(liquidation: NormalizedLiquidation): void {
    if (!this.isTrackedSymbol(liquidation.symbol)) {
      return;
    }

    this.recentLiquidations.unshift(liquidation);
    if (this.recentLiquidations.length > this.maxLiquidations) {
      this.recentLiquidations.pop();
    }
    this.emit('liquidation', liquidation);
  }

  private handleStateChange(exchange: Exchange, state: ConnectionState): void {
    this.updateConnectionState(exchange, state);

    // Re-subscribe on reconnection
    if (state === 'connected' && this.subscribedSymbols.length > 0) {
      const adapter = this.adapters.get(exchange);
      if (adapter) {
        adapter.subscribe(this.subscribedSymbols, this.subscribedStreams);
      }
    }
  }

  private handleError(exchange: Exchange, error: Error): void {
    this.updateConnectionState(exchange, 'error', error.message);
    this.emitExchangeError(exchange, error);
  }

  private updateConnectionState(exchange: Exchange, state: ConnectionState, error?: string): void {
    const connection = this.connections.get(exchange);
    if (connection) {
      connection.state = state;
      if (error) connection.error = error;
      if (state === 'reconnecting') connection.reconnectAttempts++;
      if (state === 'connected') connection.reconnectAttempts = 0;
      this.connections.set(exchange, connection);
      this.emit('connectionChange', new Map(this.connections));
    }
  }

  private startAggregation(): void {
    if (this.aggregationInterval) return;

    this.aggregationInterval = setInterval(() => {
      this.aggregateMarkets();
    }, 500); // Aggregate every 500ms
  }

  private stopAggregation(): void {
    if (this.aggregationInterval) {
      clearInterval(this.aggregationInterval);
      this.aggregationInterval = null;
    }
  }

  private aggregateMarkets(): void {
    const symbolGroups = new Map<Symbol, NormalizedTicker[]>();

    // Group tickers by symbol
    for (const [, ticker] of this.tickers) {
      const group = symbolGroups.get(ticker.symbol) || [];
      group.push(ticker);
      symbolGroups.set(ticker.symbol, group);
    }

    // Calculate aggregated data for each symbol
    for (const [symbol, tickers] of symbolGroups) {
      if (tickers.length === 0) continue;

      // Volume-weighted average price
      let totalVolume = 0;
      let weightedPriceSum = 0;
      let totalOI = 0;
      let fundingSum = 0;
      let priceMin = Infinity;
      let priceMax = -Infinity;
      let priceChangeSum = 0;

      const exchangeMap = new Map<Exchange, NormalizedTicker>();

      for (const ticker of tickers) {
        totalVolume += ticker.volumeUsd24h;
        weightedPriceSum += ticker.lastPrice * ticker.volumeUsd24h;
        totalOI += ticker.openInterestValue;
        fundingSum += ticker.fundingRate;
        priceMin = Math.min(priceMin, ticker.lastPrice);
        priceMax = Math.max(priceMax, ticker.lastPrice);
        priceChangeSum += ticker.priceChangePercent24h;
        exchangeMap.set(ticker.exchange, ticker);
      }

      const avgPrice = tickers.reduce((sum, t) => sum + t.lastPrice, 0) / tickers.length;
      const weightedAvgPrice = totalVolume > 0 ? weightedPriceSum / totalVolume : avgPrice;
      const spread = priceMax - priceMin;
      const spreadPercent = avgPrice > 0 ? (spread / avgPrice) * 100 : 0;
      const avgFunding = fundingSum / tickers.length;
      const avgPriceChange = priceChangeSum / tickers.length;

      const aggregated: AggregatedMarket = {
        symbol,
        avgPrice,
        weightedAvgPrice,
        minPrice: priceMin,
        maxPrice: priceMax,
        spread,
        spreadPercent,
        avgFundingRate: avgFunding,
        totalOpenInterest: totalOI,
        totalVolume24h: totalVolume,
        priceChangePercent24h: avgPriceChange,
        exchangeCount: tickers.length,
        exchanges: exchangeMap,
        lastUpdate: Date.now(),
      };

      this.aggregatedMarkets.set(symbol, aggregated);
      this.emit('aggregated', aggregated);
    }
  }

  // Public getters
  getConnections(): Map<Exchange, ExchangeConnection> {
    return new Map(this.connections);
  }

  getAggregatedMarkets(): Map<Symbol, AggregatedMarket> {
    return new Map(this.aggregatedMarkets);
  }

  getAggregatedMarket(symbol: Symbol): AggregatedMarket | undefined {
    return this.aggregatedMarkets.get(symbol);
  }

  getTicker(symbol: Symbol, exchange: Exchange): NormalizedTicker | undefined {
    return this.tickers.get(`${symbol}-${exchange}`);
  }

  getAllTickers(): NormalizedTicker[] {
    return Array.from(this.tickers.values());
  }

  getRecentTrades(symbol?: Symbol, limit = 50): NormalizedTrade[] {
    let trades = this.recentTrades;
    if (symbol) {
      trades = trades.filter((t) => t.symbol === symbol);
    }
    return trades.slice(0, limit);
  }

  getRecentLiquidations(symbol?: Symbol, limit = 20): NormalizedLiquidation[] {
    let liquidations = this.recentLiquidations;
    if (symbol) {
      liquidations = liquidations.filter((l) => l.symbol === symbol);
    }
    return liquidations.slice(0, limit);
  }

  getOrderbook(symbol: Symbol, exchange: Exchange): NormalizedOrderbook | undefined {
    return this.orderbooks.get(`${symbol}-${exchange}`);
  }

  getFunding(symbol: Symbol, exchange: Exchange): NormalizedFunding | undefined {
    return this.fundingRates.get(`${symbol}-${exchange}`);
  }

  getAllFunding(symbol: Symbol): NormalizedFunding[] {
    const funding: NormalizedFunding[] = [];
    for (const [key, rate] of this.fundingRates) {
      if (key.startsWith(`${symbol}-`)) {
        funding.push(rate);
      }
    }
    return funding;
  }

  getConnectedExchangeCount(): number {
    let count = 0;
    for (const [, conn] of this.connections) {
      if (conn.state === 'connected') count++;
    }
    return count;
  }

  isConnected(): boolean {
    return this.getConnectedExchangeCount() > 0;
  }
}

// Singleton instance
let instance: WebSocketManager | null = null;

export function getWebSocketManager(): WebSocketManager {
  if (!instance) {
    instance = new WebSocketManager();
  }
  return instance;
}

export function resetWebSocketManager(): void {
  if (instance) {
    instance.disconnect();
    instance.removeAllListeners();
    instance = null;
  }
}
