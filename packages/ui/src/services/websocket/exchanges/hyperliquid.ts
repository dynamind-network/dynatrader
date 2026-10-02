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

export class HyperliquidAdapter extends BaseAdapter {
  exchange: Exchange = 'hyperliquid';
  private assetToIndex: Map<string, number> = new Map();
  private indexToAsset: Map<number, string> = new Map();

  protected getWebSocketUrl(): string {
    return 'wss://api.hyperliquid.xyz/ws';
  }

  protected getPingMessage(): any {
    return { method: 'ping' };
  }

  protected onConnect(): void {
    // Fetch meta info to get asset indices
    this.fetchMeta();
  }

  private async fetchMeta(): Promise<void> {
    try {
      const response = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'meta' })
      });

      const meta = await response.json() as { universe?: Array<{ name: string }> };
      if (meta.universe) {
        meta.universe.forEach((asset, index: number) => {
          this.assetToIndex.set(asset.name, index);
          this.indexToAsset.set(index, asset.name);
        });
      }
    } catch (error) {
      // Fallback - common assets
      const common = ['BTC', 'ETH', 'SOL', 'ARB', 'OP', 'DOGE', 'AVAX', 'MATIC', 'LINK', 'BNB'];
      common.forEach((asset, i) => {
        this.assetToIndex.set(asset, i);
        this.indexToAsset.set(i, asset);
      });
    }
  }

  protected sendSubscription(symbols: Symbol[], streams: MessageType[], subscribe: boolean): void {
    // Hyperliquid uses a different subscription model
    if (streams.includes('ticker') || streams.includes('funding')) {
      this.send({
        method: 'subscribe',
        subscription: { type: 'allMids' }
      });

      // Subscribe to individual asset contexts for funding
      for (const symbol of symbols) {
        this.send({
          method: 'subscribe',
          subscription: { type: 'activeAssetCtx', coin: symbol }
        });
      }
    }

    if (streams.includes('trade')) {
      for (const symbol of symbols) {
        this.send({
          method: 'subscribe',
          subscription: { type: 'trades', coin: symbol }
        });
      }
    }

    if (streams.includes('orderbook')) {
      for (const symbol of symbols) {
        this.send({
          method: 'subscribe',
          subscription: { type: 'l2Book', coin: symbol }
        });
      }
    }

    if (streams.includes('liquidation')) {
      this.send({
        method: 'subscribe',
        subscription: { type: 'notification', user: '0x0000000000000000000000000000000000000000' }
      });
    }
  }

  protected handleRawMessage(data: any): void {
    if (data.channel === 'allMids') {
      this.handleAllMids(data.data);
    } else if (data.channel === 'activeAssetCtx') {
      this.handleAssetCtx(data.data);
    } else if (data.channel === 'trades') {
      this.handleTrades(data.data);
    } else if (data.channel === 'l2Book') {
      this.handleOrderbook(data.data);
    }
  }

  private normalizeSymbol(rawSymbol: string): string {
    if (rawSymbol.startsWith('@')) {
      const assetIndex = Number.parseInt(rawSymbol.slice(1), 10);
      const mapped = this.indexToAsset.get(assetIndex);
      if (mapped) {
        return mapped;
      }
    }

    return rawSymbol;
  }

  private handleAllMids(data: any): void {
    if (!data.mids) return;

    for (const [rawSymbol, midPrice] of Object.entries(data.mids)) {
      const symbol = this.normalizeSymbol(rawSymbol);
      const ticker: NormalizedTicker = {
        symbol,
        exchange: this.exchange,
        markPrice: parseFloat(midPrice as string),
        indexPrice: parseFloat(midPrice as string),
        lastPrice: parseFloat(midPrice as string),
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
        timestamp: Date.now()
      };

      this.emitMessage({
        type: 'ticker',
        exchange: this.exchange,
        data: ticker,
        timestamp: Date.now()
      });
    }
  }

  private handleAssetCtx(data: any): void {
    if (!data.ctx) return;

    const ctx = data.ctx;
    const symbol = this.normalizeSymbol(data.coin);

    // Update funding info
    const funding: NormalizedFunding = {
      symbol,
      exchange: this.exchange,
      fundingRate: parseFloat(ctx.funding || '0'),
      predictedRate: parseFloat(ctx.premium || '0'),
      nextFundingTime: Date.now() + 3600000, // Hyperliquid has hourly funding
      fundingInterval: 1,
      timestamp: Date.now()
    };

    this.emitMessage({
      type: 'funding',
      exchange: this.exchange,
      data: funding,
      timestamp: Date.now()
    });

    // Also update ticker with OI
    const ticker: NormalizedTicker = {
      symbol,
      exchange: this.exchange,
      markPrice: parseFloat(ctx.markPx || '0'),
      indexPrice: parseFloat(ctx.oraclePx || ctx.markPx || '0'),
      lastPrice: parseFloat(ctx.markPx || '0'),
      fundingRate: parseFloat(ctx.funding || '0'),
      nextFundingTime: Date.now() + 3600000,
      openInterest: parseFloat(ctx.openInterest || '0'),
      openInterestValue: parseFloat(ctx.openInterest || '0') * parseFloat(ctx.markPx || '1'),
      volume24h: parseFloat(ctx.dayNtlVlm || '0'),
      volumeUsd24h: parseFloat(ctx.dayNtlVlm || '0'),
      high24h: 0,
      low24h: 0,
      priceChange24h: 0,
      priceChangePercent24h: parseFloat(ctx.dayPxPctChg || '0') * 100,
      timestamp: Date.now()
    };

    this.emitMessage({
      type: 'ticker',
      exchange: this.exchange,
      data: ticker,
      timestamp: Date.now()
    });
  }

  private handleTrades(data: any): void {
    if (!Array.isArray(data)) return;

    for (const t of data) {
      const price = parseFloat(t.px);
      const size = parseFloat(t.sz);

      const trade: NormalizedTrade = {
        symbol: this.normalizeSymbol(t.coin),
        exchange: this.exchange,
        tradeId: String(t.tid),
        price,
        size,
        side: t.side === 'A' ? 'sell' : 'buy',
        timestamp: t.time,
        isLiquidation: t.liquidation || false,
        liquidationSide: t.liquidation ? (t.side === 'A' ? 'long' : 'short') : undefined,
        usdValue: price * size
      };

      this.emitMessage({
        type: 'trade',
        exchange: this.exchange,
        data: trade,
        timestamp: Date.now()
      });

      // If liquidation, also emit liquidation event
      if (t.liquidation) {
        const liquidation: NormalizedLiquidation = {
          symbol: this.normalizeSymbol(t.coin),
          exchange: this.exchange,
          side: t.side === 'A' ? 'long' : 'short',
          price,
          size,
          usdValue: price * size,
          timestamp: t.time
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

  private handleOrderbook(data: any): void {
    // L2Book handling if needed
  }
}

