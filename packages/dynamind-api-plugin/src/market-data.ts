/**
 * DynaMind API — Market Data Provider
 *
 * Wraps the DynaMind Data API's market data endpoints as a MarketDataProvider.
 * Provides: universe discovery, prices, OHLCV, order books, volume.
 */

import type { MarketDataProvider, Candle, OrderBook } from "dynatrader";

export interface DynaMindMarketDataConfig {
  baseUrl: string;
  apiKey?: string;
}

export function createMarketDataProvider(
  config: DynaMindMarketDataConfig,
): MarketDataProvider {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  async function request<T>(path: string): Promise<T> {
    const resp = await fetch(`${config.baseUrl}${path}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      throw new Error(`DynaMind API ${resp.status}: ${resp.statusText}`);
    }
    return resp.json() as Promise<T>;
  }

  return {
    async fetchUniverse(): Promise<string[]> {
      const data = await request<{ pairs: Array<{ symbol: string }> }>(
        "/api/v1/pairs",
      );
      return data.pairs.map((p) => p.symbol);
    },

    async getPrice(symbol: string): Promise<number> {
      const data = await request<{ price: number }>(
        `/api/v1/price/${encodeURIComponent(symbol)}`,
      );
      return data.price;
    },

    async getOHLCV(
      symbol: string,
      timeframe: string,
      limit?: number,
    ): Promise<Candle[]> {
      const params = new URLSearchParams({ timeframe });
      if (limit) params.set("limit", String(limit));
      const data = await request<{
        candles: Array<{
          timestamp: number;
          open: number;
          high: number;
          low: number;
          close: number;
          volume: number;
        }>;
      }>(`/api/v1/ohlcv/${encodeURIComponent(symbol)}?${params}`);
      return data.candles.map((c) => ({
        timestamp: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      }));
    },

    async getOrderBook(symbol: string): Promise<OrderBook> {
      const data = await request<{
        bids: Array<[number, number]>;
        asks: Array<[number, number]>;
      }>(`/api/v1/orderbook/${encodeURIComponent(symbol)}`);
      return {
        bids: data.bids ?? [],
        asks: data.asks ?? [],
        timestamp: Date.now(),
      };
    },

    async get24hVolume(symbol: string): Promise<number> {
      const data = await request<{ volume24h: number }>(
        `/api/v1/price/${encodeURIComponent(symbol)}`,
      );
      return data.volume24h ?? 0;
    },
  };
}
