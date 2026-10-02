export interface MarketDataConfig {
  apiKey?: string;
  baseUrl?: string;
}

import { getErrorMessage } from '../utils/index.js';
import { buildMarketUrl, getMarketKlinesPath } from '../config/market-provider.js';

export interface CryptoDataResponse {
  symbol: string;
  interval: string;
  candles: Array<{
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;
  source: 'dynamind-terminal' | 'direct';
}

export interface StockDataResponse {
  symbol: string;
  price: number;
  companyName?: string;
  marketCap?: number;
  dayHigh?: number;
  dayLow?: number;
  volume?: number;
  previousClose?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  source: 'dynamind-terminal' | 'direct';
}

export interface ForexDataResponse {
  pair: string;
  rate: number;
  lastUpdated: string;
  source: 'dynamind-terminal' | 'direct';
}

export interface MarketDataUsageResponse {
  requestsToday: number;
  requestsThisMonth: number;
  tier: string;
  limit?: number;
}

interface CacheEntry<T> {
  data: T;
  expires: number;
}

export class MarketDataClient {
  private apiKey: string;
  private baseUrl: string;
  private cache: Map<string, CacheEntry<unknown>> = new Map();

  constructor(config?: MarketDataConfig) {
    this.apiKey = config?.apiKey || process.env.DYNAMIND_TERMINAL_DATA_API_KEY || '';
    this.baseUrl = config?.baseUrl || 'https://data.dynamind.network/v1';
  }

  hasKey(): boolean {
    return !!this.apiKey && this.apiKey.length > 0;
  }

  getApiKey(): string {
    return this.apiKey;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.hasKey()) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private getCached<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (entry && entry.expires > Date.now()) {
      return entry.data as T;
    }
    return null;
  }

  private setCache<T>(key: string, data: T, ttlMs: number): void {
    this.cache.set(key, { data, expires: Date.now() + ttlMs });
  }

  private clearExpiredCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expires < now) {
        this.cache.delete(key);
      }
    }
  }

  async getCryptoData(
    symbol: string,
    interval: string,
    limit: number
  ): Promise<CryptoDataResponse> {
    const cacheKey = `crypto:${symbol}:${interval}:${limit}`;
    const cached = this.getCached<CryptoDataResponse>(cacheKey);
    if (cached) {
      return cached;
    }

    if (!this.hasKey()) {
      return await this.fetchDirectCryptoData(symbol, interval, limit);
    }

    try {
      const url = `${this.baseUrl}/markets/crypto/${symbol}?interval=${interval}&limit=${limit}`;
      const response = await fetch(url, { headers: this.getHeaders() });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          console.warn('Market Data API authentication failed, falling back to direct API');
        } else if (response.status === 429) {
          throw new Error('Rate limit exceeded. Upgrade at https://dynamind.network/pricing');
        }
        return await this.fetchDirectCryptoData(symbol, interval, limit);
      }

      const data = (await response.json()) as {
        symbol?: string;
        interval?: string;
        candles?: Array<{
          time: string;
          open: number;
          high: number;
          low: number;
          close: number;
          volume: number;
        }>;
      };
      const result: CryptoDataResponse = {
        symbol: data.symbol || symbol,
        interval: data.interval || interval,
        candles: data.candles || [],
        source: 'dynamind-terminal',
      };

      this.setCache(cacheKey, result, 60000);
      return result;
    } catch (error) {
      const message = getErrorMessage(error);
      console.warn(`Market Data API error: ${message}, falling back to direct API`);
      return await this.fetchDirectCryptoData(symbol, interval, limit);
    }
  }

  private async fetchDirectCryptoData(
    symbol: string,
    interval: string,
    limit: number
  ): Promise<CryptoDataResponse> {
    const binanceSymbol = symbol.includes('USDT') ? symbol : `${symbol}USDT`;
    const url = buildMarketUrl(getMarketKlinesPath(), {
      symbol: binanceSymbol,
      interval,
      limit,
    });

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch crypto data from the configured market provider: ${response.status}`
      );
    }

    const klines = (await response.json()) as unknown[][];

    const candles = klines.map((k) => ({
      time: new Date(k[0] as number).toISOString(),
      open: parseFloat(k[1] as string),
      high: parseFloat(k[2] as string),
      low: parseFloat(k[3] as string),
      close: parseFloat(k[4] as string),
      volume: parseFloat(k[5] as string),
    }));

    return {
      symbol,
      interval,
      candles,
      source: 'direct',
    };
  }

  async getStockData(symbol: string): Promise<StockDataResponse> {
    const cacheKey = `stock:${symbol}`;
    const cached = this.getCached<StockDataResponse>(cacheKey);
    if (cached) {
      return cached;
    }

    if (!this.hasKey()) {
      return await this.fetchDirectStockData(symbol);
    }

    try {
      const url = `${this.baseUrl}/markets/stock/${symbol}`;
      const response = await fetch(url, { headers: this.getHeaders() });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          console.warn('Market Data API authentication failed, falling back to direct API');
        } else if (response.status === 429) {
          throw new Error('Rate limit exceeded. Upgrade at https://dynamind.network/pricing');
        }
        return await this.fetchDirectStockData(symbol);
      }

      const data = (await response.json()) as {
        symbol?: string;
        price?: number;
        companyName?: string;
        marketCap?: number;
        dayHigh?: number;
        dayLow?: number;
        volume?: number;
        previousClose?: number;
        fiftyTwoWeekHigh?: number;
        fiftyTwoWeekLow?: number;
      };
      const result: StockDataResponse = {
        symbol: data.symbol || symbol,
        price: data.price || 0,
        companyName: data.companyName,
        marketCap: data.marketCap,
        dayHigh: data.dayHigh,
        dayLow: data.dayLow,
        volume: data.volume,
        previousClose: data.previousClose,
        fiftyTwoWeekHigh: data.fiftyTwoWeekHigh,
        fiftyTwoWeekLow: data.fiftyTwoWeekLow,
        source: 'dynamind-terminal',
      };

      this.setCache(cacheKey, result, 120000);
      return result;
    } catch (error) {
      const message = getErrorMessage(error);
      console.warn(`Market Data API error: ${message}, falling back to direct API`);
      return await this.fetchDirectStockData(symbol);
    }
  }

  private async fetchDirectStockData(symbol: string): Promise<StockDataResponse> {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5d`;

    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch stock data from Yahoo Finance: ${response.status}`);
    }

    const data = (await response.json()) as {
      chart?: {
        result?: Array<{
          meta?: {
            shortName?: string;
            regularMarketPrice?: number;
            previousClose?: number;
            regularMarketDayLow?: number;
            regularMarketDayHigh?: number;
            fiftyTwoWeekLow?: number;
            fiftyTwoWeekHigh?: number;
            regularMarketVolume?: number;
            marketCap?: number;
          };
          indicators?: {
            quote?: Array<{
              close: number[];
            }>;
          };
        }>;
      };
    };

    const result = data.chart?.result?.[0];
    if (!result || !result.meta) {
      throw new Error(`No data found for ${symbol}`);
    }

    return {
      symbol,
      price: result.meta.regularMarketPrice || 0,
      companyName: result.meta.shortName,
      marketCap: result.meta.marketCap,
      dayHigh: result.meta.regularMarketDayHigh,
      dayLow: result.meta.regularMarketDayLow,
      volume: result.meta.regularMarketVolume,
      previousClose: result.meta.previousClose,
      fiftyTwoWeekHigh: result.meta.fiftyTwoWeekHigh,
      fiftyTwoWeekLow: result.meta.fiftyTwoWeekLow,
      source: 'direct',
    };
  }

  async getForexData(pair: string): Promise<ForexDataResponse> {
    const cacheKey = `forex:${pair}`;
    const cached = this.getCached<ForexDataResponse>(cacheKey);
    if (cached) {
      return cached;
    }

    if (!this.hasKey()) {
      return await this.fetchDirectForexData(pair);
    }

    try {
      const normalizedPair = pair.replace('/', '').toUpperCase();
      const url = `${this.baseUrl}/markets/forex/${normalizedPair}`;
      const response = await fetch(url, { headers: this.getHeaders() });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          console.warn('Market Data API authentication failed, falling back to direct API');
        } else if (response.status === 429) {
          throw new Error('Rate limit exceeded. Upgrade at https://dynamind.network/pricing');
        }
        return await this.fetchDirectForexData(pair);
      }

      const data = (await response.json()) as {
        pair?: string;
        rate?: number;
        lastUpdated?: string;
      };
      const result: ForexDataResponse = {
        pair: data.pair || pair,
        rate: data.rate || 0,
        lastUpdated: data.lastUpdated || new Date().toISOString(),
        source: 'dynamind-terminal',
      };

      this.setCache(cacheKey, result, 60000);
      return result;
    } catch (error) {
      const message = getErrorMessage(error);
      console.warn(`Market Data API error: ${message}, falling back to direct API`);
      return await this.fetchDirectForexData(pair);
    }
  }

  private async fetchDirectForexData(pair: string): Promise<ForexDataResponse> {
    const normalizedPair = pair.replace('/', '').toUpperCase();
    const base = normalizedPair.substring(0, 3);
    const quote = normalizedPair.substring(3, 6) || 'USD';

    const url = `https://open.er-api.com/v6/latest/${base}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to fetch forex data: ${response.status}`);
    }

    const data = (await response.json()) as {
      result?: string;
      rates?: Record<string, number>;
      time_last_update_utc?: string;
      error?: string;
    };

    if (data.result !== 'success') {
      throw new Error(`Forex data error: ${data.error || 'Unknown error'}`);
    }

    const rate = data.rates?.[quote];
    if (!rate) {
      throw new Error(`No rate found for ${base}/${quote}`);
    }

    return {
      pair: `${base}/${quote}`,
      rate,
      lastUpdated: data.time_last_update_utc || new Date().toISOString(),
      source: 'direct',
    };
  }

  async getUsage(): Promise<MarketDataUsageResponse> {
    if (!this.hasKey()) {
      return {
        requestsToday: 0,
        requestsThisMonth: 0,
        tier: 'free',
      };
    }

    try {
      const url = `${this.baseUrl}/usage`;
      const response = await fetch(url, { headers: this.getHeaders() });

      if (!response.ok) {
        return {
          requestsToday: 0,
          requestsThisMonth: 0,
          tier: 'unknown',
        };
      }

      const data = (await response.json()) as {
        requestsToday?: number;
        requestsThisMonth?: number;
        tier?: string;
        limit?: number;
      };
      return {
        requestsToday: data.requestsToday || 0,
        requestsThisMonth: data.requestsThisMonth || 0,
        tier: data.tier || 'free',
        limit: data.limit,
      };
    } catch (error) {
      console.warn('Failed to fetch usage data');
      return {
        requestsToday: 0,
        requestsThisMonth: 0,
        tier: 'unknown',
      };
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  getCacheSize(): number {
    return this.cache.size;
  }
}

