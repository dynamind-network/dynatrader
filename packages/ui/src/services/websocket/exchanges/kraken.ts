import { BaseAdapter } from '../baseAdapter.js';
import {
  Exchange,
  Symbol,
  MessageType,
  NormalizedTicker,
  NormalizedTrade,
  NormalizedFunding,
  NormalizedLiquidation,
  SYMBOL_MAPPING,
  REVERSE_SYMBOL_MAPPING
} from '../types.js';

export class KrakenAdapter extends BaseAdapter {
  exchange: Exchange = 'kraken';

  protected getWebSocketUrl(): string {
    return 'wss://futures.kraken.com/ws/v1';
  }

  protected getPingMessage(): any {
    return { event: 'ping' };
  }

  protected sendSubscription(symbols: Symbol[], streams: MessageType[], subscribe: boolean): void {
    const productIds = symbols.map(s => SYMBOL_MAPPING.kraken(s));

    if (streams.includes('ticker') || streams.includes('funding')) {
      this.send({
        event: subscribe ? 'subscribe' : 'unsubscribe',
        feed: 'ticker',
        product_ids: productIds
      });
    }

    if (streams.includes('trade')) {
      this.send({
        event: subscribe ? 'subscribe' : 'unsubscribe',
        feed: 'trade',
        product_ids: productIds
      });
    }

    if (streams.includes('orderbook')) {
      this.send({
        event: subscribe ? 'subscribe' : 'unsubscribe',
        feed: 'book',
        product_ids: productIds
      });
    }
  }

  protected handleRawMessage(data: any): void {
    const feed = data.feed;

    if (feed === 'ticker' || feed === 'ticker_snapshot') {
      this.handleTicker(data);
    } else if (feed === 'trade' || feed === 'trade_snapshot') {
      this.handleTrades(data);
    }
  }

  private handleTicker(data: any): void {
    const symbol = REVERSE_SYMBOL_MAPPING.kraken(data.product_id);

    const ticker: NormalizedTicker = {
      symbol,
      exchange: this.exchange,
      markPrice: data.markPrice || data.last || 0,
      indexPrice: data.index || data.markPrice || 0,
      lastPrice: data.last || data.markPrice || 0,
      fundingRate: data.funding_rate || 0,
      nextFundingTime: data.next_funding_rate_time ? new Date(data.next_funding_rate_time).getTime() : 0,
      openInterest: data.openInterest || 0,
      openInterestValue: (data.openInterest || 0) * (data.markPrice || 0),
      volume24h: data.volume || 0,
      volumeUsd24h: data.volumeQuote || (data.volume || 0) * (data.last || 0),
      high24h: data.high24h || 0,
      low24h: data.low24h || 0,
      priceChange24h: data.change || 0,
      priceChangePercent24h: data.changePercent || 0,
      timestamp: data.time ? new Date(data.time).getTime() : Date.now()
    };

    this.emitMessage({
      type: 'ticker',
      exchange: this.exchange,
      data: ticker,
      timestamp: Date.now()
    });

    // Emit funding
    if (data.funding_rate !== undefined) {
      const funding: NormalizedFunding = {
        symbol,
        exchange: this.exchange,
        fundingRate: data.funding_rate,
        predictedRate: data.funding_rate_prediction,
        nextFundingTime: data.next_funding_rate_time ? new Date(data.next_funding_rate_time).getTime() : 0,
        fundingInterval: 4, // Kraken has 4-hour funding
        timestamp: data.time ? new Date(data.time).getTime() : Date.now()
      };

      this.emitMessage({
        type: 'funding',
        exchange: this.exchange,
        data: funding,
        timestamp: Date.now()
      });
    }
  }

  private handleTrades(data: any): void {
    const trades = data.trades || [data];
    const symbol = REVERSE_SYMBOL_MAPPING.kraken(data.product_id);

    for (const t of trades) {
      if (!t.price) continue;

      const price = t.price;
      const size = t.qty || t.size || 0;

      const trade: NormalizedTrade = {
        symbol,
        exchange: this.exchange,
        tradeId: t.uid || String(t.time),
        price,
        size,
        side: t.side === 'buy' ? 'buy' : 'sell',
        timestamp: t.time ? new Date(t.time).getTime() : Date.now(),
        isLiquidation: t.type === 'liquidation',
        usdValue: price * size
      };

      this.emitMessage({
        type: 'trade',
        exchange: this.exchange,
        data: trade,
        timestamp: Date.now()
      });

      if (t.type === 'liquidation') {
        const liquidation: NormalizedLiquidation = {
          symbol,
          exchange: this.exchange,
          side: t.side === 'buy' ? 'short' : 'long',
          price,
          size,
          usdValue: price * size,
          timestamp: t.time ? new Date(t.time).getTime() : Date.now()
        };

        this.emitMessage({
          type: 'liquidation',
          exchange: this.exchange,
          data: liquidation,
          timestamp: Date.now()
        });
      }
    }
  }
}

