/**
 * Market Scanner Orchestrator
 *
 * Coordinates the full scan workflow:
 * 1. Fetch universe from Hyperliquid (or fallback)
 * 2. For each symbol, fetch market data from Hyperliquid API
 * 3. Apply eligibility filters
 * 4. Score all eligible symbols
 * 5. Rank and return top N candidates
 */

import type {
  MarketBias,
  ScannerConfig,
  ScannerResult,
  ScoredSymbol,
  Symbol,
  SymbolMarketData,
} from "./types";
import { DEFAULT_SCANNER_CONFIG } from "./types";
import { fetchHyperliquidUniverse } from "./universe";
import { filterSymbol, selectTopCandidates } from "./filters";
import { scoreSymbol } from "./scorer";

/** Default trading position size for slippage estimation ($1,000) */
const DEFAULT_POSITION_SIZE_USD = 1000;

/**
 * Market Scanner class.
 * Fetches the Hyperliquid perpetual universe, scores symbols, and returns
 * ranked candidates for deeper analysis.
 */
export class MarketScanner {
  private readonly config: ScannerConfig;

  constructor(config: Partial<ScannerConfig> = {}) {
    this.config = { ...DEFAULT_SCANNER_CONFIG, ...config };
  }

  /**
   * Run a complete market scan.
   *
   * Returns a ScannerResult with:
   * - Top N candidates ranked by composite score
   * - All skipped symbols with reasons
   * - Any issues encountered
   * - Source of the symbol universe (hyperliquid/fallback/failed)
   */
  async scan(
    signals?: Map<Symbol, { trend: MarketBias; icScore: number; irScore: number }>,
  ): Promise<ScannerResult> {
    const issues: string[] = [];
    const allResults: ScoredSymbol[] = [];
    const skipped: Array<{ symbol: string; reason: string }> = [];

    // Step 1: Fetch universe
    const { symbols, source, issue } = await fetchHyperliquidUniverse();
    if (issue) issues.push(issue);

    // Step 2: Fetch market data for each symbol
    const marketDataMap = await this.fetchAllMarketData(symbols);

    // Step 3: Score each symbol
    for (const symbol of symbols) {
      const data = marketDataMap.get(symbol);
      if (!data) {
        allResults.push({
          symbol,
          liquidityScore: 0,
          volatilityScore: 0,
          trendScore: 0,
          riskPenalty: 0,
          signalScore: 0,
          totalScore: 0,
          bias: "NEUTRAL",
          reason: "No market data",
          eligible: false,
          skipReason: "SKIPPED: insufficient data (fetch failed)",
        });
        continue;
      }

      // Apply eligibility filters first
      const filtered = filterSymbol(data, this.config);
      if (!filtered.eligible) {
        allResults.push(filtered);
        continue;
      }

      // Get signal data if provided, otherwise use defaults
      const signalData = signals?.get(symbol);
      const trend = signalData?.trend ?? "NEUTRAL";
      const icScore = signalData?.icScore ?? 0;
      const irScore = signalData?.irScore ?? 0;

      // Score the symbol
      const scored = scoreSymbol(data, this.config, trend, icScore, irScore);
      allResults.push(scored);
    }

    // Build skipped list from ineligible results
    for (const r of allResults) {
      if (!r.eligible && r.skipReason) {
        skipped.push({ symbol: r.symbol, reason: r.skipReason });
      }
    }

    // Step 4: Select top N candidates
    const eligible = allResults.filter((r) => r.eligible);
    const candidates = selectTopCandidates(eligible, this.config.topCandidates);

    return {
      timestamp: new Date().toISOString(),
      symbolsScanned: symbols.length,
      eligibleCount: eligible.length,
      candidates,
      skipped,
      issues,
      universeSource: source,
    };
  }

  /**
   * Fetch market data for all symbols from Hyperliquid API.
   * Returns a map of symbol -> data.
   */
  private async fetchAllMarketData(
    symbols: string[],
  ): Promise<Map<string, SymbolMarketData>> {
    const result = new Map<string, SymbolMarketData>();

    try {
      const data = await this.fetchHyperliquidBatchData();

      for (const symbol of symbols) {
        const hlSymbol = symbol.replace("/", "-");
        const entry = data[hlSymbol];
        if (!entry) {
          result.set(symbol, this.noData(symbol, "Not found in Hyperliquid response"));
          continue;
        }

        result.set(symbol, {
          symbol,
          price: (entry.midPx as number) ?? 0,
          volume24hUsd:
            ((entry.dayAvgPx as number) ?? 0) > 0
              ? ((entry.dayVol as number) ?? 0) * ((entry.dayAvgPx as number) ?? 0)
              : 0,
          spreadBps: (entry.spreadBps as number) ?? 5,
          estimatedSlippageBps: this.estimateSlippage((entry.midPx as number) ?? 0),
          candleCount: (entry.candles as unknown[])?.length ?? 0,
          fundingRate:
            entry.coin === hlSymbol ? 0 : ((entry.funding as number) ?? 0),
          oiChange24h:
            entry.openInterest !== undefined && entry.prevOpenInterest !== undefined
              ? ((entry.openInterest as number) - (entry.prevOpenInterest as number)) /
                (entry.prevOpenInterest as number)
              : 0,
          high24h: (entry.highPx as number) ?? 0,
          low24h: (entry.lowPx as number) ?? 0,
          available: ((entry.midPx as number) ?? 0) > 0,
          unavailableReason:
            ((entry.midPx as number) ?? 0) <= 0 ? "Price is zero or unavailable" : undefined,
        });
      }
    } catch {
      // Batch fetch failed -- fall back to individual fetch
      await this.fetchIndividualFallback(symbols, result);
    }

    return result;
  }

  /**
   * Fetch batch data from Hyperliquid's batch info endpoint.
   */
  private async fetchHyperliquidBatchData(): Promise<Record<string, Record<string, unknown>>> {
    const resp = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "batchApi",
        batch: [{ type: "allMids" }, { type: "meta" }],
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return (await resp.json()) as Record<string, Record<string, unknown>>;
  }

  /**
   * Fallback: fetch individual symbol data via allMids endpoint.
   */
  private async fetchIndividualFallback(
    symbols: string[],
    result: Map<string, SymbolMarketData>,
  ): Promise<void> {
    const resp = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "allMids" }),
      signal: AbortSignal.timeout(5000),
    });

    if (!resp.ok) {
      for (const symbol of symbols) {
        result.set(symbol, this.noData(symbol, `HTTP ${resp.status}`));
      }
      return;
    }

    const mids = (await resp.json()) as Record<string, number>;
    for (const symbol of symbols) {
      const hlSymbol = symbol.replace("/", "-");
      const price = mids[hlSymbol];
      if (!price || price <= 0) {
        result.set(symbol, this.noData(symbol, "Price not available"));
        continue;
      }
      result.set(symbol, {
        symbol,
        price,
        volume24hUsd: 0,
        spreadBps: 5,
        estimatedSlippageBps: this.estimateSlippage(price),
        candleCount: 0,
        fundingRate: 0,
        oiChange24h: 0,
        high24h: price * 1.03,
        low24h: price * 0.97,
        available: true,
      });
    }
  }

  /**
   * Estimate slippage for a given price and default position size.
   */
  private estimateSlippage(price: number): number {
    if (price <= 0) return this.config.maxEstimatedSlippageBps;
    const notional = DEFAULT_POSITION_SIZE_USD;
    const units = notional / price;
    const impactFactor = Math.min(50, units / 10);
    return Math.min(impactFactor, this.config.maxEstimatedSlippageBps);
  }

  /**
   * Create a "no data" SymbolMarketData entry.
   */
  private noData(symbol: string, reason: string): SymbolMarketData {
    return {
      symbol,
      price: 0,
      volume24hUsd: 0,
      spreadBps: 0,
      estimatedSlippageBps: 0,
      candleCount: 0,
      fundingRate: 0,
      oiChange24h: 0,
      high24h: 0,
      low24h: 0,
      available: false,
      unavailableReason: reason,
    };
  }
}
