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

export class GateAdapter extends BaseAdapter {
  exchange: Exchange = 'gate';
  private requestId = 1;

  protected getWebSocketUrl(): string {
    return 'wss://fx-ws.gateio.ws/v4/ws/usdt';
  }

  protected getPingMessage(): any {
    return {
      time: Math.floor(Date.now() / 1000),
      channel: 'futures.ping'
    };
  }

  protected sendSubscription(symbols: Symbol[], streams: MessageType[], subscribe: boolean): void {
    const contracts = symbols.map(s => SYMBOL_MAPPING.gate(s));

    if (streams.includes('ticker')) {
      this.send({
        time: Math.floor(Date.now() / 1000),
        channel: 'futures.tickers',
        event: subscribe ? 'subscribe' : 'unsubscribe',
        payload: contracts
      });
    }

    if (streams.includes('trade')) {
      this.send({
        time: Math.floor(Date.now() / 1000),
        channel: 'futures.trades',
        event: subscribe ? 'subscribe' : 'unsubscribe',
        payload: contracts
      });
    }

    if (streams.includes('orderbook')) {
      this.send({
        time: Math.floor(Date.now() / 1000),
        channel: 'futures.order_book',
        event: subscribe ? 'subscribe' : 'unsubscribe',
        payload: contracts.map(c => ({ contract: c, level: '20', interval: '100ms' }))
      });
    }

    if (streams.includes('liquidation')) {
      this.send({
        time: Math.floor(Date.now() / 1000),
        channel: 'futures.liquidates',
        event: subscribe ? 'subscribe' : 'unsubscribe',
        payload: contracts
      });
    }
  }

  protected handleRawMessage(data: any): void {
    const channel = data.channel;

    if (channel === 'futures.tickers') {
      this.handleTicker(data);
    } else if (channel === 'futures.trades') {
      this.handleTrades(data);
    } else if (channel === 'futures.liquidates') {
      this.handleLiquidation(data);
    }
  }

  private handleTicker(data: any): void {
    const items = data.result;
    if (!Array.isArray(items)) return;

    for (const item of items) {
      const symbol = REVERSE_SYMBOL_MAPPING.gate(item.contract);

      const ticker: NormalizedTicker = {
        symbol,
        exchange: this.exchange,
        markPrice: parseFloat(item.mark_price || '0'),
        indexPrice: parseFloat(item.index_price || '0'),
        lastPrice: parseFloat(item.last || '0'),
        fundingRate: parseFloat(item.funding_rate || '0'),
        nextFundingTime: item.funding_rate_indicative ? Date.now() + 28800000 : 0,
        openInterest: parseFloat(item.total_size || '0'),
        openInterestValue: parseFloat(item.total_size || '0') * parseFloat(item.last || '1'),
        volume24h: parseFloat(item.volume_24h || '0'),
        volumeUsd24h: parseFloat(item.volume_24h_usd || item.volume_24h_quote || '0'),
        high24h: parseFloat(item.high_24h || '0'),
        low24h: parseFloat(item.low_24h || '0'),
        priceChange24h: parseFloat(item.change_percentage || '0') * parseFloat(item.last || '0') / 100,
        priceChangePercent24h: parseFloat(item.change_percentage || '0'),
        timestamp: Date.now()
      };

      this.emitMessage({
        type: 'ticker',
        exchange: this.exchange,
        data: ticker,
        timestamp: Date.now()
      });

      // Emit funding
      if (item.funding_rate) {
        const funding: NormalizedFunding = {
          symbol,
          exchange: this.exchange,
          fundingRate: parseFloat(item.funding_rate),
          predictedRate: parseFloat(item.funding_rate_indicative || '0'),
          nextFundingTime: Date.now() + 28800000, // 8 hours
          fundingInterval: 8,
          timestamp: Date.now()
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
    const trades = data.result;
    if (!Array.isArray(trades)) return;

    for (const t of trades) {
      const symbol = REVERSE_SYMBOL_MAPPING.gate(t.contract);
      const price = parseFloat(t.price);
      const size = parseFloat(t.size);

      const trade: NormalizedTrade = {
        symbol,
        exchange: this.exchange,
        tradeId: String(t.id),
        price,
        size: Math.abs(size),
        side: size > 0 ? 'buy' : 'sell',
        timestamp: t.create_time * 1000,
        isLiquidation: false,
        usdValue: price * Math.abs(size)
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
    const items = data.result;
    if (!Array.isArray(items)) return;

    for (const item of items) {
      const symbol = REVERSE_SYMBOL_MAPPING.gate(item.contract);
      const price = parseFloat(item.order_price || item.fill_price || '0');
      const size = parseFloat(item.size || '0');

      const liquidation: NormalizedLiquidation = {
        symbol,
        exchange: this.exchange,
        side: item.side === 'long' ? 'long' : 'short',
        price,
        size: Math.abs(size),
        usdValue: price * Math.abs(size),
        timestamp: item.time * 1000
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

