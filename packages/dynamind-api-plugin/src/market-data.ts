/**
 * DynaMind API — Market Data Provider
 *
 * Wraps the DynaMind Data API's market data endpoints as a MarketDataProvider.
 * Provides: universe discovery, prices, OHLCV, order books, volume.
 */

import type { Candle, MarketDataProvider, OrderBook } from "@dyna/core";
import { requestDynaMindApi } from "./http.js";

export interface DynaMindMarketDataConfig {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
}
export function createMarketDataProvider(
  config: DynaMindMarketDataConfig,
): MarketDataProvider {
  const timeoutMs = Math.min(25_000, Math.max(1_000, config.timeoutMs ?? 20_000));

  async function request<T>(path: string): Promise<T> {
    return requestDynaMindApi<T>(config, path, { timeoutMs });
  }

  return {
    async fetchUniverse(): Promise<string[]> {
      const pairs = await request<string[] | Array<{ symbol: string }>>(
        "/api/v1/pairs",
      );
      return pairs.map((pair) => typeof pair === "string" ? pair : pair.symbol);
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
      const candles = await request<Array<{
          timestamp: number;
          open: number;
          high: number;
          low: number;
          close: number;
          volume: number;
        }>>(`/api/v1/ohlcv/${encodeURIComponent(symbol)}?${params}`);
      return candles.map((c) => ({
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
        bids: Array<[number, number] | { price: number; quantity: number }>;
        asks: Array<[number, number] | { price: number; quantity: number }>;
        timestamp?: number;
      }>(`/api/v1/orderbook/${encodeURIComponent(symbol)}`);
      return {
        bids: (data.bids ?? []).map((level) => Array.isArray(level) ? level : [level.price, level.quantity]),
        asks: (data.asks ?? []).map((level) => Array.isArray(level) ? level : [level.price, level.quantity]),
        timestamp: data.timestamp ?? Date.now(),
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
