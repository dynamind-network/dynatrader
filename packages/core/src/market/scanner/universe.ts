/**
 * Hyperliquid Universe Fetcher
 *
 * Fetches the active perpetual futures universe from Hyperliquid API.
 * Returns an empty universe if the API is unavailable; instruments are never
 * invented by the runtime and must come from the configured data source.
 */

import type { ScannerResult, UniverseFetchResult } from "./types";

/** Empty fallback when the configured universe source is unavailable. */
export const FALLBACK_UNIVERSE: string[] = [];

/**
 * Fetch the perpetual futures universe from Hyperliquid API.
 *
 * Uses the allMids endpoint which returns mid prices for all active perps.
 * Any symbol with a price > 0 is considered active.
 */
export async function fetchHyperliquidUniverse(): Promise<UniverseFetchResult> {
  try {
    const resp = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "allMids" }),
      signal: AbortSignal.timeout(5000),
    });

    if (!resp.ok) {
      return {
        symbols: FALLBACK_UNIVERSE,
        source: "fallback",
        issue: `Hyperliquid API returned HTTP ${resp.status}. Using fallback symbol list.`,
      };
    }

    const data = (await resp.json()) as Record<string, number>;

    const symbols: string[] = [];
    for (const [key, price] of Object.entries(data)) {
      if (price > 0 && !key.includes("TEST") && key.length <= 20) {
        const normalized = normalizeHyperliquidSymbol(key);
        if (normalized) {
          symbols.push(normalized);
        }
      }
    }

    if (symbols.length === 0) {
      return {
        symbols: FALLBACK_UNIVERSE,
        source: "fallback",
        issue: `Hyperliquid returned 0 active symbols. Using fallback symbol list.`,
      };
    }

    return { symbols, source: "hyperliquid" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      symbols: FALLBACK_UNIVERSE,
      source: "fallback",
      issue: `Hyperliquid universe fetch failed: ${msg}. Using fallback symbol list.`,
    };
  }
}

/**
 * Normalize a Hyperliquid symbol (for example, BASE-QUOTE -> BASE/QUOTE).
 * Returns null if the symbol is not a valid perpetual pair.
 */
function normalizeHyperliquidSymbol(key: string): string | null {
  const upper = key.toUpperCase();

  // Remove -PERP suffix if present
  const base = upper.endsWith("-PERP") ? upper.slice(0, -5) : upper;

  // Handle known USDT-based pairs
  if (base.endsWith("-USDT")) {
    const base2 = base.slice(0, -5);
    if (base2.length >= 2 && base2.length <= 8) {
      return `${base2}/USDT`;
    }
  }

  // Some pairs use USDC
  if (base.endsWith("-USDC")) {
    const base2 = base.slice(0, -6);
    if (base2.length >= 2 && base2.length <= 8) {
      return `${base2}/USDC`;
    }
  }

  return null;
}

/**
 * Build a ScannerResult with issues from the universe fetch.
 */
export function buildEmptyScannerResult(
  issues: string[],
  source: "hyperliquid" | "fallback" | "failed",
): ScannerResult {
  return {
    timestamp: new Date().toISOString(),
    symbolsScanned: 0,
    eligibleCount: 0,
    candidates: [],
    skipped: [],
    issues: [...issues],
    universeSource: source,
  };
}
