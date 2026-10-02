import { providers } from './providers.js';

/**
 * CRITICAL: Blocked URL patterns for SSRF protection on market data requests.
 * Expanded to cover cloud metadata endpoints, IPv6 private ranges, and DNS rebinding vectors.
 * Based on Codex CLI's network namespace isolation approach.
 */
const BLOCKED_URL_PATTERNS = [
  /^https?:\/\/(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.)/i,
  /^https?:\/\/localhost/i,
  /^https?:\/\/\[::1\]/i,
  /^https?:\/\/169\.254\./i,
  // Cloud metadata endpoints (GCP, AWS, Azure)
  /^https?:\/\/metadata\.google\.internal/i,
  /^https?:\/\/169\.254\.169\.254/i,
  /^https?:\/\/fd00::/i,
  /^https?:\/\/fc00::/i,
  /^https?:\/\/fe80:/i,
  /^https?:\/\/\[::ffff:/i,
  // mDNS and internal TLDs
  /^https?:\/\/.*\.local/i,
  /^https?:\/\/.*\.internal/i,
  /^https?:\/\/.*\.localhost/i,
  // CRITICAL: Protocol-relative URLs (can bypass checks)
  /^\/\//i,
  // CRITICAL: Non-HTTP schemes
  /^file:/i,
  /^data:/i,
  /^javascript:/i,
  /^ftp:/i,
];

/**
 * CRITICAL: Allowed URL schemes. Only https: is permitted for external calls.
 */
const ALLOWED_SCHEMES = ['https:'];

/**
 * CRITICAL: Allowed egress domains for market data.
 * Based on Codex CLI's domain allowlist approach.
 */
const ALLOWED_EGRESS_DOMAINS = new Set([
  'api.binance.com',
  'api.hyperliquid.xyz',
  'api.curve.fi',
  'query1.finance.yahoo.com',
  'open.er-api.com',
  'eth.llamarpc.com',
  'arb1.arbitrum.io',
  'polygon-rpc.com',
  'mainnet.base.org',
  'mainnet.optimism.io',
]);

/**
 * CRITICAL: Validate URL against SSRF blocklist, scheme whitelist, and egress domain allowlist.
 * Returns the URL if safe, throws if blocked or insecure.
 */
function validateMarketUrl(url: string): string {
  // CRITICAL: Validate URL scheme first
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`[market-provider] Invalid URL: ${url}`);
  }

  if (!ALLOWED_SCHEMES.includes(parsed.protocol)) {
    throw new Error(`[market-provider] Insecure URL scheme blocked: ${parsed.protocol}`);
  }

  // CRITICAL: Check against all SSRF blocklist patterns
  if (BLOCKED_URL_PATTERNS.some(p => p.test(url))) {
    throw new Error(`[market-provider] Blocked private/internal URL: ${url}`);
  }

  // CRITICAL: Egress domain allowlist (Codex-style network boundary)
  if (!ALLOWED_EGRESS_DOMAINS.has(parsed.hostname)) {
    throw new Error(`[market-provider] Domain not in egress allowlist: ${parsed.hostname}`);
  }

  return url;
}

export function getMarketRestBase(): string {
  return providers.market?.rest ?? providers.binance.rest;
}

export function getMarketKlinesPath(): string {
  return providers.market?.klines ?? providers.binance.klines;
}

export function getMarketTicker24hrPath(): string {
  return providers.market?.ticker24hr ?? providers.binance.ticker24hr;
}

export function getMarketTickerPricePath(): string {
  return providers.market?.tickerPrice ?? providers.binance.tickerPrice;
}

export function getMarketDepthPath(): string {
  return providers.market?.depth ?? '/depth';
}

export function buildMarketUrl(pathname: string, query: Record<string, string | number>): string {
  const url = new URL(`${getMarketRestBase()}${pathname}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, String(value));
  }
  // CRITICAL: Validate constructed URL against SSRF blocklist
  return validateMarketUrl(url.toString());
}

