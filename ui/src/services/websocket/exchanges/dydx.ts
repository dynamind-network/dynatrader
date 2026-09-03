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

export class DydxAdapter extends BaseAdapter {
  exchange: Exchange = 'dydx';
  private messageId = 0;

  protected getWebSocketUrl(): string {
    return 'wss://indexer.dydx.trade/v4/ws';
  }

  protected getPingMessage(): any {
    return { type: 'ping' };
  }

  protected sendSubscription(symbols: Symbol[], streams: MessageType[], subscribe: boolean): void {
    for (const symbol of symbols) {
      const dydxSymbol = SYMBOL_MAPPING.dydx(symbol);

      if (streams.includes('ticker') || streams.includes('funding')) {
        this.send({
          type: subscribe ? 'subscribe' : 'unsubscribe',
          channel: 'v4_markets',
          id: dydxSymbol
        });
      }

      if (streams.includes('trade')) {
        this.send({
          type: subscribe ? 'subscribe' : 'unsubscribe',
          channel: 'v4_trades',
          id: dydxSymbol
        });
      }

      if (streams.includes('orderbook')) {
        this.send({
          type: subscribe ? 'subscribe' : 'unsubscribe',
          channel: 'v4_orderbook',
          id: dydxSymbol
        });
      }
    }
  }

  protected handleRawMessage(data: any): void {
    if (data.type === 'channel_data' || data.type === 'subscribed') {
      const channel = data.channel;

      if (channel === 'v4_markets') {
        this.handleMarkets(data);
      } else if (channel === 'v4_trades') {
        this.handleTrades(data);
      }
    }
  }

  private handleMarkets(data: any): void {
    const contents = data.contents || data.connection?.contents;
    if (!contents) return;

    // Handle both snapshot and updates
    const markets = contents.markets || { [data.id]: contents };

    for (const [marketId, market] of Object.entries(markets) as [string, any][]) {
      const symbol = REVERSE_SYMBOL_MAPPING.dydx(marketId);

      const ticker: NormalizedTicker = {
        symbol,
        exchange: this.exchange,
        markPrice: parseFloat(market.oraclePrice || market.indexPrice || '0'),
        indexPrice: parseFloat(market.indexPrice || market.oraclePrice || '0'),
        lastPrice: parseFloat(market.oraclePrice || '0'),
        fundingRate: parseFloat(market.nextFundingRate || '0'),
        nextFundingTime: market.nextFundingAt ? new Date(market.nextFundingAt).getTime() : 0,
        openInterest: parseFloat(market.openInterest || '0'),
        openInterestValue: parseFloat(market.openInterestUSDC || '0'),
        volume24h: parseFloat(market.volume24H || '0'),
        volumeUsd24h: parseFloat(market.volume24H || '0'),
        high24h: parseFloat(market.high24H || '0'),
        low24h: parseFloat(market.low24H || '0'),
        priceChange24h: parseFloat(market.priceChange24H || '0'),
        priceChangePercent24h: parseFloat(market.priceChange24HPercent || '0'),
        timestamp: Date.now()
      };

      this.emitMessage({
        type: 'ticker',
        exchange: this.exchange,
        data: ticker,
        timestamp: Date.now()
      });

      // Emit funding
      if (market.nextFundingRate) {
        const funding: NormalizedFunding = {
          symbol,
          exchange: this.exchange,
          fundingRate: parseFloat(market.nextFundingRate),
          predictedRate: parseFloat(market.nextFundingRate),
          nextFundingTime: market.nextFundingAt ? new Date(market.nextFundingAt).getTime() : 0,
          fundingInterval: 1, // dYdX v4 has 1-hour funding
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
    const contents = data.contents;
    if (!contents?.trades) return;

    const marketId = data.id;
    const symbol = REVERSE_SYMBOL_MAPPING.dydx(marketId);

    for (const t of contents.trades) {
      const price = parseFloat(t.price);
      const size = parseFloat(t.size);

      const trade: NormalizedTrade = {
        symbol,
        exchange: this.exchange,
        tradeId: t.id || String(Date.now()),
        price,
        size,
        side: t.side === 'BUY' ? 'buy' : 'sell',
        timestamp: t.createdAt ? new Date(t.createdAt).getTime() : Date.now(),
        isLiquidation: t.type === 'LIQUIDATION',
        liquidationSide: t.type === 'LIQUIDATION' ? (t.side === 'BUY' ? 'short' : 'long') : undefined,
        usdValue: price * size
      };

      this.emitMessage({
        type: 'trade',
        exchange: this.exchange,
        data: trade,
        timestamp: Date.now()
      });

      // Emit liquidation if applicable
      if (t.type === 'LIQUIDATION') {
        const liquidation: NormalizedLiquidation = {
          symbol,
          exchange: this.exchange,
          side: t.side === 'BUY' ? 'short' : 'long',
          price,
          size,
          usdValue: price * size,
          timestamp: t.createdAt ? new Date(t.createdAt).getTime() : Date.now()
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
