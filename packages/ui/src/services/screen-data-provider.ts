import type { MarketDataProvider, NewsProvider } from '@dyna/core';
import { providers } from '../config/providers.js';

const DYNAMIND_API_BASE_URL = 'https://api.dynamind.network';
const CACHE_LIMIT = 256;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();

let providerPromise: Promise<{ market: MarketDataProvider; news: NewsProvider }> | undefined;

export function usesDynaMindMarketData(): boolean {
  return providers.market?.source === 'dynamind';
}

export function usesDynaMindNews(): boolean {
  return providers.news.source === 'dynamind';
}

async function getProviders(): Promise<{ market: MarketDataProvider; news: NewsProvider }> {
  providerPromise ??= import('@dyna/plugin-dynamind-api').then(({ createMarketDataProvider, createNewsProvider }) => {
    const config = {
      baseUrl: process.env.DYNAMIND_API_URL?.trim() || DYNAMIND_API_BASE_URL,
      apiKey: process.env.DYNAMIND_API_KEY,
      timeoutMs: 5_000,
    };
    return {
      market: createMarketDataProvider(config),
      news: createNewsProvider(config),
    };
  });
  return providerPromise;
}

function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const entry = cache.get(key);
  if (entry && entry.expiresAt > Date.now()) return Promise.resolve(entry.value as T);

  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;

  const request = load().then((value) => {
    if (cache.size >= CACHE_LIMIT) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey) cache.delete(oldestKey);
    }
    cache.delete(key);
    cache.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
  }).finally(() => {
    inFlight.delete(key);
  });

  inFlight.set(key, request);
  return request;
}

/** These short-lived process caches deduplicate page requests and reduce plan usage. */
export function getDynaMindUniverse(): Promise<string[]> {
  return cached('universe', 30 * 60_000, async () => (await getProviders()).market.fetchUniverse());
}

export function getDynaMindPrice(symbol: string): Promise<number> {
  const normalized = normalizeApiSymbol(symbol);
  return cached(`price:${normalized}`, 5 * 60_000, async () => (await getProviders()).market.getPrice(normalized));
}

/** Fetch a bounded number of per-symbol quotes at once to avoid bursty plan usage. */
export async function getDynaMindPrices(
  symbols: string[],
  concurrency = 4,
  onQuote?: (quote: { symbol: string; price: number | null }) => void,
): Promise<Array<{ symbol: string; price: number | null }>> {
  const results: Array<{ symbol: string; price: number | null }> = new Array(symbols.length);
  let nextIndex = 0;
  const workerCount = Math.min(symbols.length, Math.max(1, Math.floor(concurrency)));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < symbols.length) {
      const index = nextIndex++;
      const symbol = symbols[index]!;
      try {
        results[index] = { symbol, price: await getDynaMindPrice(symbol) };
      } catch {
        results[index] = { symbol, price: null };
      }
      onQuote?.(results[index]!);
    }
  }));
  return results;
}

export function getDynaMindOHLCV(symbol: string, timeframe: string, limit: number) {
  const normalized = normalizeApiSymbol(symbol);
  return cached(`ohlcv:${normalized}:${timeframe}:${limit}`, 5 * 60_000, async () =>
    (await getProviders()).market.getOHLCV(normalized, timeframe, limit));
}

export function getDynaMindOrderBook(symbol: string) {
  const normalized = normalizeApiSymbol(symbol);
  return cached(`orderbook:${normalized}`, 60_000, async () => (await getProviders()).market.getOrderBook(normalized));
}

export function getDynaMindNews(limit: number) {
  return cached(`news:${limit}`, 5 * 60_000, async () => (await getProviders()).news.getNews({ limit }));
}

function normalizeApiSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/\//g, '');
}
