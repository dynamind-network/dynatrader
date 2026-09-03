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

export class BitgetAdapter extends BaseAdapter {
  exchange: Exchange = 'bitget';

  protected getWebSocketUrl(): string {
    return 'wss://ws.bitget.com/v2/ws/public';
  }

  protected getPingMessage(): any {
    return 'ping';
  }

  protected sendSubscription(symbols: Symbol[], streams: MessageType[], subscribe: boolean): void {
    const args: any[] = [];

    for (const symbol of symbols) {
      const bitgetSymbol = SYMBOL_MAPPING.bitget(symbol);

      if (streams.includes('ticker')) {
        args.push({
          instType: 'USDT-FUTURES',
          channel: 'ticker',
          instId: bitgetSymbol
        });
      }
      if (streams.includes('trade')) {
        args.push({
          instType: 'USDT-FUTURES',
          channel: 'trade',
          instId: bitgetSymbol
        });
      }
      if (streams.includes('orderbook')) {
        args.push({
          instType: 'USDT-FUTURES',
          channel: 'books15',
          instId: bitgetSymbol
        });
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

    if (channel === 'ticker') {
      this.handleTicker(data);
    } else if (channel === 'trade') {
      this.handleTrades(data);
    }
  }

  private handleTicker(data: any): void {
    const items = data.data;
    if (!Array.isArray(items)) return;

    for (const item of items) {
      const symbol = REVERSE_SYMBOL_MAPPING.bitget(item.instId || data.arg?.instId);

      const ticker: NormalizedTicker = {
        symbol,
        exchange: this.exchange,
        markPrice: parseFloat(item.markPrice || item.last || '0'),
        indexPrice: parseFloat(item.indexPrice || '0'),
        lastPrice: parseFloat(item.last || '0'),
        fundingRate: parseFloat(item.fundingRate || '0'),
        nextFundingTime: parseInt(item.nextFundingTime || '0'),
        openInterest: parseFloat(item.holdingAmount || '0'),
        openInterestValue: parseFloat(item.holdingAmount || '0') * parseFloat(item.last || '1'),
        volume24h: parseFloat(item.baseVolume || '0'),
        volumeUsd24h: parseFloat(item.quoteVolume || '0'),
        high24h: parseFloat(item.high24h || '0'),
        low24h: parseFloat(item.low24h || '0'),
        priceChange24h: parseFloat(item.change24h || '0'),
        priceChangePercent24h: parseFloat(item.changeUtc24h || '0') * 100,
        timestamp: parseInt(item.ts || Date.now().toString())
      };

      this.emitMessage({
        type: 'ticker',
        exchange: this.exchange,
        data: ticker,
        timestamp: Date.now()
      });

      // Emit funding
      if (item.fundingRate) {
        const funding: NormalizedFunding = {
          symbol,
          exchange: this.exchange,
          fundingRate: parseFloat(item.fundingRate),
          nextFundingTime: parseInt(item.nextFundingTime || '0'),
          fundingInterval: 8,
          timestamp: parseInt(item.ts || Date.now().toString())
        };

        this.emitMessage({
          type: 'funding',
          exchange: this.exchange,
          data: funding,
          timestamp: Date.now()
        });
      }
    }
  }

  private handleTrades(data: any): void {
    const trades = data.data;
    if (!Array.isArray(trades)) return;

    for (const t of trades) {
      const symbol = REVERSE_SYMBOL_MAPPING.bitget(t.instId || data.arg?.instId);
      const price = parseFloat(t.price || t.px);
      const size = parseFloat(t.size || t.sz);

      const trade: NormalizedTrade = {
        symbol,
        exchange: this.exchange,
        tradeId: t.tradeId || String(t.ts),
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
}
