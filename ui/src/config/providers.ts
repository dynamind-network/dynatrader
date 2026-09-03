/**
 * Centralized API provider configuration.
 *
 * All external API endpoints live here so they can be swapped without
 * touching screen/tool code. Override any value via ~/.dynamind/config.json
 * under the "providers" key, or wire directly to the data-api package later.
 *
 * Usage:
 *   import { providers } from '../config/providers.js';
 *   const url = `${providers.binance.rest}/klines?symbol=<market-symbol>&interval=1h&limit=100`;
 */

import type { Exchange } from '../services/websocket/types.js';

/**
 * CRITICAL: Blocked URL patterns for SSRF protection.
 * Prevents provider URLs from targeting private/internal networks.
 */
const BLOCKED_URL_PATTERNS = [
  /^https?:\/\/(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.)/i,
  /^https?:\/\/localhost/i,
  /^https?:\/\/\[::1\]/i,
  /^https?:\/\/169\.254\./i,
];

/**
 * CRITICAL: Validate provider URL against SSRF blocklist.
 * Returns the URL if safe, undefined if blocked.
 */
function validateProviderUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (BLOCKED_URL_PATTERNS.some(p => p.test(url))) {
    console.warn(`[providers] Blocked private/internal URL: ${url}`);
    return undefined;
  }
  return url;
}

export interface ProviderConfig {
  /** Base URL for the REST API */
  rest: string;
  /** Optional API key (falls back to env var) */
  apiKey?: string;
  /** Optional additional headers */
  headers?: Record<string, string>;
}

export interface NewsProviderConfig extends ProviderConfig {
  /** News-specific endpoint path (appended to rest) */
  newsPath: string;
}

export interface Providers {
  binance: ProviderConfig & {
    /** Klines endpoint (appended to rest) */
    klines: string;
    /** 24hr ticker endpoint */
    ticker24hr: string;
    /** Price endpoint */
    tickerPrice: string;
  };
  exchangeUrls?: Partial<Record<Exchange, string>>;
  market?: ProviderConfig & {
    /** Klines endpoint (appended to rest) */
    klines: string;
    /** 24hr ticker endpoint */
    ticker24hr: string;
    /** Price endpoint */
    tickerPrice?: string;
    /** Depth endpoint */
    depth?: string;
  };
  news: NewsProviderConfig;
  /** Placeholder for future data-api integration */
  dataApi?: {
    rest: string;
    ws: string;
  };
}

/**
 * Default providers — all free, no API keys required.
 * Override via ~/.dynamind/config.json { "providers": { ... } }
 */
export const defaultProviders: Providers = {
  binance: {
    rest: 'https://api.binance.com/api/v3',
    klines: '/klines',
    ticker24hr: '/ticker/24hr',
    tickerPrice: '/ticker/price',
  },
  exchangeUrls: {},
  market: {
    rest: 'https://api.binance.com/api/v3',
    klines: '/klines',
    ticker24hr: '/ticker/24hr',
    tickerPrice: '/ticker/price',
    depth: '/depth',
  },
  news: {
    rest: 'https://min-api.cryptocompare.com',
    newsPath: '/data/v2/news/?lang=EN',
  },
};

/**
 * Merges user overrides from config.json onto the defaults.
 * Only top-level and second-level keys are merged; deeper nesting
 * uses the default if the override is partial.
 */
function mergeProviders(base: Providers, overrides?: Partial<Providers>): Providers {
  if (!overrides) return base;

  const merged = { ...base };

  // Market provider overrides — CRITICAL: Validate URLs against SSRF blocklist
  if (overrides.binance) {
    merged.binance = {
      ...merged.binance,
      ...overrides.binance,
    };
    // Validate rest URL if overridden
    if (overrides.binance.rest) {
      const validated = validateProviderUrl(overrides.binance.rest);
      if (!validated) {
        merged.binance = { ...base.binance };
      } else {
        merged.binance.rest = validated;
      }
    }
  }

  if (overrides.exchangeUrls) {
    merged.exchangeUrls = {
      ...merged.exchangeUrls,
      ...overrides.exchangeUrls,
    };
  }

  if (overrides.market) {
    merged.market = {
      ...merged.market,
      ...overrides.market,
    };
    // Validate rest URL if overridden
    if (overrides.market.rest) {
      const validated = validateProviderUrl(overrides.market.rest);
      if (!validated) {
        merged.market = { ...(base.market ?? defaultProviders.market)! };
      } else {
        merged.market.rest = validated;
      }
    }
  }

  // News overrides
  if (overrides.news) {
    merged.news = {
      ...merged.news,
      ...overrides.news,
    };
    // Validate rest URL if overridden
    if (overrides.news.rest) {
      const validated = validateProviderUrl(overrides.news.rest);
      if (!validated) {
        merged.news = { ...base.news };
      } else {
        merged.news.rest = validated;
      }
    }
  }

  // Data API (future)
  if (overrides.dataApi) {
    // Validate URLs
    const validatedRest = validateProviderUrl(overrides.dataApi.rest);
    const validatedWs = validateProviderUrl(overrides.dataApi.ws);
    merged.dataApi = {
      rest: validatedRest || base.dataApi?.rest || '',
      ws: validatedWs || base.dataApi?.ws || '',
    };
  }

  return merged;
}

/**
 * Load providers with optional overrides from config.
 * Call this once at startup; screens import the result.
 */
export function createProviders(overrides?: Partial<Providers>): Providers {
  return mergeProviders(defaultProviders, overrides);
}

/** Singleton — import this in screens and tools */
export let providers: Providers = defaultProviders;

/** Re-initialize providers at startup if config.json has overrides */
export function initProviders(overrides?: Partial<Providers>): void {
  providers = createProviders(overrides);
}
