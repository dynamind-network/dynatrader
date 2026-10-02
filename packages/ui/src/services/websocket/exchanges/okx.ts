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

export class OkxAdapter extends BaseAdapter {
  exchange: Exchange = 'okx';

  protected getWebSocketUrl(): string {
    return 'wss://ws.okx.com:8443/ws/v5/public';
  }

  protected getPingMessage(): any {
    return 'ping';
  }

  protected sendSubscription(symbols: Symbol[], streams: MessageType[], subscribe: boolean): void {
    const args: any[] = [];

    for (const symbol of symbols) {
      const okxSymbol = SYMBOL_MAPPING.okx(symbol);

      if (streams.includes('ticker')) {
        args.push({ channel: 'mark-price', instId: okxSymbol });
        args.push({ channel: 'tickers', instId: okxSymbol });
      }
      if (streams.includes('trade')) {
        args.push({ channel: 'trades', instId: okxSymbol });
      }
      if (streams.includes('funding')) {
        args.push({ channel: 'funding-rate', instId: okxSymbol });
      }
      if (streams.includes('liquidation')) {
        args.push({ channel: 'liquidation-orders', instType: 'SWAP' });
      }
      if (streams.includes('orderbook')) {
        args.push({ channel: 'books5', instId: okxSymbol });
      }
    }

    if (args.length > 0) {
      this.send({
        op: subscribe ? 'subscribe' : 'unsubscribe',
        args
      });
    }
  }

  protected handleRawMessage(data: any): void {
    if (data === 'pong') return;

    const channel = data.arg?.channel;

    if (channel === 'tickers') {
      this.handleTicker(data);
    } else if (channel === 'mark-price') {
      this.handleMarkPrice(data);
    } else if (channel === 'trades') {
      this.handleTrades(data);
    } else if (channel === 'funding-rate') {
      this.handleFunding(data);
    } else if (channel === 'liquidation-orders') {
      this.handleLiquidation(data);
    }
  }

  private handleTicker(data: any): void {
    const items = data.data;
    if (!Array.isArray(items)) return;

    for (const item of items) {
      const symbol = REVERSE_SYMBOL_MAPPING.okx(item.instId);

      const ticker: NormalizedTicker = {
        symbol,
        exchange: this.exchange,
        markPrice: parseFloat(item.last || '0'),
        indexPrice: parseFloat(item.idxPx || '0'),
        lastPrice: parseFloat(item.last || '0'),
        fundingRate: 0,
        nextFundingTime: 0,
        openInterest: parseFloat(item.oi || '0'),
        openInterestValue: parseFloat(item.oiCcy || '0'),
        volume24h: parseFloat(item.vol24h || '0'),
        volumeUsd24h: parseFloat(item.volCcy24h || '0'),
        high24h: parseFloat(item.high24h || '0'),
        low24h: parseFloat(item.low24h || '0'),
        priceChange24h: parseFloat(item.last || '0') - parseFloat(item.open24h || '0'),
        priceChangePercent24h: ((parseFloat(item.last || '0') - parseFloat(item.open24h || '1')) / parseFloat(item.open24h || '1')) * 100,
        timestamp: parseInt(item.ts)
      };

      this.emitMessage({
        type: 'ticker',
        exchange: this.exchange,
        data: ticker,
        timestamp: Date.now()
      });
    }
  }

  private handleMarkPrice(data: any): void {
    const items = data.data;
    if (!Array.isArray(items)) return;

    for (const item of items) {
      const symbol = REVERSE_SYMBOL_MAPPING.okx(item.instId);

      const ticker: NormalizedTicker = {
        symbol,
        exchange: this.exchange,
        markPrice: parseFloat(item.markPx || '0'),
        indexPrice: parseFloat(item.idxPx || '0'),
        lastPrice: parseFloat(item.markPx || '0'),
        fundingRate: 0,
        nextFundingTime: 0,
        openInterest: 0,
        openInterestValue: 0,
        volume24h: 0,
        volumeUsd24h: 0,
        high24h: 0,
        low24h: 0,
        priceChange24h: 0,
        priceChangePercent24h: 0,
        timestamp: parseInt(item.ts)
      };

      this.emitMessage({
        type: 'ticker',
        exchange: this.exchange,
        data: ticker,
        timestamp: Date.now()
      });
    }
  }

  private handleTrades(data: any): void {
    const trades = data.data;
    if (!Array.isArray(trades)) return;

    for (const t of trades) {
      const symbol = REVERSE_SYMBOL_MAPPING.okx(t.instId);
      const price = parseFloat(t.px);
      const size = parseFloat(t.sz);

      const trade: NormalizedTrade = {
        symbol,
        exchange: this.exchange,
        tradeId: t.tradeId,
        price,
        size,
        side: t.side === 'buy' ? 'buy' : 'sell',
        timestamp: parseInt(t.ts),
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

  private handleFunding(data: any): void {
    const items = data.data;
    if (!Array.isArray(items)) return;

    for (const item of items) {
      const symbol = REVERSE_SYMBOL_MAPPING.okx(item.instId);

      const funding: NormalizedFunding = {
        symbol,
        exchange: this.exchange,
        fundingRate: parseFloat(item.fundingRate || '0'),
        predictedRate: parseFloat(item.nextFundingRate || '0'),
        nextFundingTime: parseInt(item.fundingTime || '0'),
        fundingInterval: 8,
        timestamp: parseInt(item.ts)
      };

      this.emitMessage({
        type: 'funding',
        exchange: this.exchange,
        data: funding,
        timestamp: Date.now()
      });
    }
  }

  private handleLiquidation(data: any): void {
    const items = data.data;
    if (!Array.isArray(items)) return;

    for (const item of items) {
      const symbol = REVERSE_SYMBOL_MAPPING.okx(item.instId);
      const price = parseFloat(item.bkPx);
      const size = parseFloat(item.sz);

      const liquidation: NormalizedLiquidation = {
        symbol,
        exchange: this.exchange,
        side: item.side === 'buy' ? 'short' : 'long',
        price,
        size,
        usdValue: price * size,
        timestamp: parseInt(item.ts)
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

