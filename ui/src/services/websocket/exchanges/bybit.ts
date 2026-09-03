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

export class BybitAdapter extends BaseAdapter {
  exchange: Exchange = 'bybit';
  private reqId = 1;

  protected getWebSocketUrl(): string {
    return 'wss://stream.bybit.com/v5/public/linear';
  }

  protected getPingMessage(): any {
    return { op: 'ping' };
  }

  protected sendSubscription(symbols: Symbol[], streams: MessageType[], subscribe: boolean): void {
    const args: string[] = [];

    for (const symbol of symbols) {
      const bybitSymbol = SYMBOL_MAPPING.bybit(symbol);

      if (streams.includes('ticker')) {
        args.push(`tickers.${bybitSymbol}`);
      }
      if (streams.includes('trade')) {
        args.push(`publicTrade.${bybitSymbol}`);
      }
      if (streams.includes('orderbook')) {
        args.push(`orderbook.50.${bybitSymbol}`);
      }
      if (streams.includes('liquidation')) {
        args.push(`liquidation.${bybitSymbol}`);
      }
    }

    if (args.length > 0) {
      this.send({
        op: subscribe ? 'subscribe' : 'unsubscribe',
        args,
        req_id: String(this.reqId++)
      });
    }
  }

  protected handleRawMessage(data: any): void {
    if (data.topic?.startsWith('tickers.')) {
      this.handleTicker(data);
    } else if (data.topic?.startsWith('publicTrade.')) {
      this.handleTrades(data);
    } else if (data.topic?.startsWith('liquidation.')) {
      this.handleLiquidation(data);
    }
  }

  private handleTicker(data: any): void {
    const tickerData = data.data;
    const symbol = REVERSE_SYMBOL_MAPPING.bybit(tickerData.symbol);

    const ticker: NormalizedTicker = {
      symbol,
      exchange: this.exchange,
      markPrice: parseFloat(tickerData.markPrice || '0'),
      indexPrice: parseFloat(tickerData.indexPrice || '0'),
      lastPrice: parseFloat(tickerData.lastPrice || '0'),
      fundingRate: parseFloat(tickerData.fundingRate || '0'),
      nextFundingTime: tickerData.nextFundingTime || 0,
      openInterest: parseFloat(tickerData.openInterest || '0'),
      openInterestValue: parseFloat(tickerData.openInterestValue || '0'),
      volume24h: parseFloat(tickerData.volume24h || '0'),
      volumeUsd24h: parseFloat(tickerData.turnover24h || '0'),
      high24h: parseFloat(tickerData.highPrice24h || '0'),
      low24h: parseFloat(tickerData.lowPrice24h || '0'),
      priceChange24h: parseFloat(tickerData.price24hPcnt || '0') * parseFloat(tickerData.lastPrice || '0'),
      priceChangePercent24h: parseFloat(tickerData.price24hPcnt || '0') * 100,
      timestamp: data.ts
    };

    this.emitMessage({
      type: 'ticker',
      exchange: this.exchange,
      data: ticker,
      timestamp: Date.now()
    });

    // Emit funding
    if (tickerData.fundingRate) {
      const funding: NormalizedFunding = {
        symbol,
        exchange: this.exchange,
        fundingRate: parseFloat(tickerData.fundingRate),
        nextFundingTime: tickerData.nextFundingTime || 0,
        fundingInterval: 8,
        timestamp: data.ts
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
    const trades = data.data;
    if (!Array.isArray(trades)) return;

    for (const t of trades) {
      const symbol = REVERSE_SYMBOL_MAPPING.bybit(t.s);
      const price = parseFloat(t.p);
      const size = parseFloat(t.v);

      const trade: NormalizedTrade = {
        symbol,
        exchange: this.exchange,
        tradeId: t.i,
        price,
        size,
        side: t.S === 'Buy' ? 'buy' : 'sell',
        timestamp: t.T,
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
  }

  private handleLiquidation(data: any): void {
    const liq = data.data;
    const symbol = REVERSE_SYMBOL_MAPPING.bybit(liq.symbol);
    const price = parseFloat(liq.price);
    const size = parseFloat(liq.size);

    const liquidation: NormalizedLiquidation = {
      symbol,
      exchange: this.exchange,
      side: liq.side === 'Buy' ? 'short' : 'long',
      price,
      size,
      usdValue: price * size,
      timestamp: liq.updatedTime
    };

    this.emitMessage({
      type: 'liquidation',
      exchange: this.exchange,
      data: liquidation,
      timestamp: Date.now()
    });
  }
}
