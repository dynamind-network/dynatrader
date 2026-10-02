import { BaseAdapter } from '../baseAdapter.js';
import {
  Exchange,
  Symbol,
  MessageType,
  NormalizedTicker,
  NormalizedTrade,
  NormalizedFunding,
  NormalizedLiquidation,
  WebSocketMessage,
  SYMBOL_MAPPING,
  REVERSE_SYMBOL_MAPPING
} from '../types.js';

export class BinanceAdapter extends BaseAdapter {
  exchange: Exchange = 'binance';
  private streamId = 1;

  protected getWebSocketUrl(): string {
    return 'wss://fstream.binance.com/ws';
  }

  protected getPingMessage(): any {
    return null; // Binance handles ping/pong automatically
  }

  protected sendSubscription(symbols: Symbol[], streams: MessageType[], subscribe: boolean): void {
    const binanceStreams: string[] = [];

    for (const symbol of symbols) {
      const binanceSymbol = SYMBOL_MAPPING.binance(symbol).toLowerCase();

      if (streams.includes('ticker')) {
        binanceStreams.push(`${binanceSymbol}@markPrice@1s`);
        binanceStreams.push(`${binanceSymbol}@ticker`);
      }
      if (streams.includes('trade')) {
        binanceStreams.push(`${binanceSymbol}@aggTrade`);
      }
      if (streams.includes('orderbook')) {
        binanceStreams.push(`${binanceSymbol}@depth20@100ms`);
      }
      if (streams.includes('liquidation')) {
        binanceStreams.push(`${binanceSymbol}@forceOrder`);
      }
    }

    if (binanceStreams.length > 0) {
      this.send({
        method: subscribe ? 'SUBSCRIBE' : 'UNSUBSCRIBE',
        params: binanceStreams,
        id: this.streamId++
      });
    }
  }

  protected handleRawMessage(data: any): void {
    if (data.e === 'markPriceUpdate') {
      this.handleMarkPrice(data);
    } else if (data.e === '24hrTicker') {
      this.handle24hrTicker(data);
    } else if (data.e === 'aggTrade') {
      this.handleAggTrade(data);
    } else if (data.e === 'forceOrder') {
      this.handleLiquidation(data);
    }
  }

  private handleMarkPrice(data: any): void {
    const symbol = REVERSE_SYMBOL_MAPPING.binance(data.s);

    const ticker: NormalizedTicker = {
      symbol,
      exchange: this.exchange,
      markPrice: parseFloat(data.p),
      indexPrice: parseFloat(data.i),
      lastPrice: parseFloat(data.p),
      fundingRate: parseFloat(data.r),
      nextFundingTime: data.T,
      openInterest: 0,
      openInterestValue: 0,
      volume24h: 0,
      volumeUsd24h: 0,
      high24h: 0,
      low24h: 0,
      priceChange24h: 0,
      priceChangePercent24h: 0,
      timestamp: data.E
    };

    this.emitMessage({
      type: 'ticker',
      exchange: this.exchange,
      data: ticker,
      timestamp: Date.now()
    });

    // Also emit funding
    const funding: NormalizedFunding = {
      symbol,
      exchange: this.exchange,
      fundingRate: parseFloat(data.r),
      nextFundingTime: data.T,
      fundingInterval: 8,
      timestamp: data.E
    };

    this.emitMessage({
      type: 'funding',
      exchange: this.exchange,
      data: funding,
      timestamp: Date.now()
    });
  }

  private handle24hrTicker(data: any): void {
    const symbol = REVERSE_SYMBOL_MAPPING.binance(data.s);

    const ticker: NormalizedTicker = {
      symbol,
      exchange: this.exchange,
      markPrice: parseFloat(data.c),
      indexPrice: parseFloat(data.c),
      lastPrice: parseFloat(data.c),
      fundingRate: 0,
      nextFundingTime: 0,
      openInterest: 0,
      openInterestValue: 0,
      volume24h: parseFloat(data.v),
      volumeUsd24h: parseFloat(data.q),
      high24h: parseFloat(data.h),
      low24h: parseFloat(data.l),
      priceChange24h: parseFloat(data.p),
      priceChangePercent24h: parseFloat(data.P),
      timestamp: data.E
    };

    this.emitMessage({
      type: 'ticker',
      exchange: this.exchange,
      data: ticker,
      timestamp: Date.now()
    });
  }

  private handleAggTrade(data: any): void {
    const symbol = REVERSE_SYMBOL_MAPPING.binance(data.s);
    const price = parseFloat(data.p);
    const size = parseFloat(data.q);

    const trade: NormalizedTrade = {
      symbol,
      exchange: this.exchange,
      tradeId: String(data.a),
      price,
      size,
      side: data.m ? 'sell' : 'buy',
      timestamp: data.T,
      isLiquidation: false,
      usdValue: price * size
    };

    this.emitMessage({
      type: 'trade',
      exchange: this.exchange,
      data: trade,
      timestamp: Date.now()
    });
  }

  private handleLiquidation(data: any): void {
    const order = data.o;
    const symbol = REVERSE_SYMBOL_MAPPING.binance(order.s);
    const price = parseFloat(order.p);
    const size = parseFloat(order.q);

    const liquidation: NormalizedLiquidation = {
      symbol,
      exchange: this.exchange,
      side: order.S === 'BUY' ? 'short' : 'long',
      price,
      size,
      usdValue: price * size,
      timestamp: order.T
    };

    this.emitMessage({
      type: 'liquidation',
      exchange: this.exchange,
      data: liquidation,
      timestamp: Date.now()
    });
  }
}

