import { BaseAdapter } from '../baseAdapter.js';
import {
  Exchange,
  Symbol,
  MessageType,
  NormalizedTicker,
  NormalizedFunding,
  ConnectionState
} from '../types.js';

// GMX uses on-chain data via Arbitrum RPC, not traditional WebSocket
// We poll the GMX API endpoints for data
export class GmxAdapter extends BaseAdapter {
  exchange: Exchange = 'gmx';
  private pollInterval: NodeJS.Timeout | null = null;
  private pollIntervalMs = 5000; // 5 second polling

  protected getWebSocketUrl(): string {
    return ''; // GMX doesn't use WebSocket
  }

  async connect(): Promise<void> {
    this.setState('connected');
    return Promise.resolve();
  }

  disconnect(): void {
    this.setState('disconnected');
    this.stopPolling();
  }

  protected sendSubscription(symbols: Symbol[], streams: MessageType[], subscribe: boolean): void {
    if (subscribe) {
      this.subscribedSymbols = [...new Set([...this.subscribedSymbols, ...symbols])];
      this.startPolling();
    } else {
      this.subscribedSymbols = this.subscribedSymbols.filter(s => !symbols.includes(s));
      if (this.subscribedSymbols.length === 0) {
        this.stopPolling();
      }
    }
  }

  protected handleRawMessage(_data: any): void {
    // Not used for GMX
  }

  private startPolling(): void {
    if (this.pollInterval) return;

    this.fetchData(); // Initial fetch
    this.pollInterval = setInterval(() => {
      this.fetchData();
    }, this.pollIntervalMs);
  }

  private stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private async fetchData(): Promise<void> {
    try {
      // Fetch GMX prices from their API
      const pricesResponse = await fetch('https://arbitrum-api.gmxinfra.io/prices/tickers');
      const prices = await pricesResponse.json();

      // Fetch funding rates
      const fundingResponse = await fetch('https://arbitrum-api.gmxinfra.io/prices/funding-rates');
      const funding = await fundingResponse.json();

      // Process prices
      if (Array.isArray(prices)) {
        for (const item of prices) {
          const tokenSymbol = this.extractSymbol(item.tokenSymbol);
          if (!this.subscribedSymbols.includes(tokenSymbol)) continue;

          const ticker: NormalizedTicker = {
            symbol: tokenSymbol,
            exchange: this.exchange,
            markPrice: parseFloat(item.maxPrice || item.minPrice || '0') / 1e30,
            indexPrice: parseFloat(item.minPrice || '0') / 1e30,
            lastPrice: parseFloat(item.maxPrice || item.minPrice || '0') / 1e30,
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

      // Process funding rates
      if (funding && typeof funding === 'object') {
        for (const [market, rate] of Object.entries(funding)) {
          const symbol = this.extractSymbol(market);
          if (!this.subscribedSymbols.includes(symbol)) continue;

          const fundingData: NormalizedFunding = {
            symbol,
            exchange: this.exchange,
            fundingRate: parseFloat(rate as string) || 0,
            nextFundingTime: Date.now() + 3600000,
            fundingInterval: 1,
            timestamp: Date.now()
          };

          this.emitMessage({
            type: 'funding',
            exchange: this.exchange,
            data: fundingData,
            timestamp: Date.now()
          });
        }
      }
    } catch (error) {
      if (this.errorCallback) {
        this.errorCallback(error as Error);
      }
    }
  }

  private extractSymbol(input: string): Symbol {
    // GMX uses formats like "BTC", "WBTC", "WETH" etc
    const symbol = input.toUpperCase()
      .replace('WBTC', 'BTC')
      .replace('WETH', 'ETH')
      .replace(/[-_/].*/, '');
    return symbol;
  }
}
