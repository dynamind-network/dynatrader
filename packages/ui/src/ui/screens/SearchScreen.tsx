import { Box, Text } from '@dynatrader/ink/terminal';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  buildMarketUrl,
  getMarketKlinesPath,
  getMarketTicker24hrPath,
} from '../../config/market-provider.js';
import { getDynaMindPrices, getDynaMindUniverse, usesDynaMindMarketData } from '../../services/screen-data-provider.js';
import { getMarketSymbols } from '../common/marketSymbols.js';
import { TerminalTextInput as TextInput } from '../common/TerminalTextInput.js';
import { Sparkline } from './Sparkline.js';

interface AssetData {
  price: number;
  change24h: number;
  volume: number;
  high24h: number;
  low24h: number;
  sparkline: number[];
}

interface SearchResult {
  symbol: string;
  price: number;
  change24h: number;
  volume: number;
  high24h: number;
  low24h: number;
  sparkline: number[];
}

interface SearchScreenProps {
  onBack: () => void;
}

/**
 * F10 - Search Screen
 * Search for assets by symbol with live prices and 24h change
 */
export function SearchScreen({ onBack }: SearchScreenProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [allAssets, setAllAssets] = useState<Record<string, AssetData>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date());
  const [dynaUniverse, setDynaUniverse] = useState<Array<{ symbol: string; apiSymbol: string }>>([]);
  const requestedDynaSymbols = useRef(new Set<string>());

  const loadDynaQuotes = useCallback(async (candidates: Array<{ symbol: string; apiSymbol: string }>) => {
    const missing = candidates.filter(({ symbol }) => !requestedDynaSymbols.current.has(symbol));
    missing.forEach(({ symbol }) => requestedDynaSymbols.current.add(symbol));
    await getDynaMindPrices(missing.map(({ apiSymbol }) => apiSymbol), 4, ({ symbol: apiSymbol, price }) => {
      const candidate = missing.find((item) => item.apiSymbol === apiSymbol);
      if (price === null || !Number.isFinite(price) || price <= 0 || !candidate) {
        if (candidate) requestedDynaSymbols.current.delete(candidate.symbol);
        return;
      }
      setAllAssets((current) => ({
        ...current,
        [candidate.symbol]: { price, change24h: 0, volume: 0, high24h: price, low24h: price, sparkline: [] },
      }));
      setLastUpdate(new Date());
    });
  }, []);

  useEffect(() => {
    fetchAllAssets();
    const interval = setInterval(fetchAllAssets, 5 * 60_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (query.length > 0 && Object.keys(allAssets).length > 0) {
      const filtered = Object.entries(allAssets)
        .filter(([symbol]) => symbol.toLowerCase().includes(query.toLowerCase()))
        .slice(0, 12)
        .map(([symbol, data]) => ({
          symbol,
          price: data.price,
          change24h: data.change24h,
          volume: data.volume,
          high24h: data.high24h,
          low24h: data.low24h,
          sparkline: data.sparkline,
        }));
      setResults(filtered);
    } else if (query.length === 0) {
      // Show top assets by volume when no search query
      const top = Object.entries(allAssets)
        .sort((a, b) => b[1].volume - a[1].volume)
        .slice(0, 12)
        .map(([symbol, data]) => ({
          symbol,
          price: data.price,
          change24h: data.change24h,
          volume: data.volume,
          high24h: data.high24h,
          low24h: data.low24h,
          sparkline: data.sparkline,
        }));
      setResults(top);
    }
  }, [query, allAssets]);

  useEffect(() => {
    if (!usesDynaMindMarketData() || !query.trim() || dynaUniverse.length === 0) return;
    const timer = setTimeout(() => {
      const matching = dynaUniverse
        .filter(({ symbol }) => symbol.toLowerCase().includes(query.trim().toLowerCase()))
        .slice(0, 12);
      void loadDynaQuotes(matching);
    }, 250);
    return () => clearTimeout(timer);
  }, [dynaUniverse, loadDynaQuotes, query]);

  async function fetchAllAssets() {
    try {
      if (usesDynaMindMarketData()) {
        requestedDynaSymbols.current.clear();
        const pairs = await getDynaMindUniverse();
        const byDisplaySymbol = new Map<string, { symbol: string; apiSymbol: string }>();
        for (const apiSymbol of pairs) {
          const symbol = apiSymbol.trim().toUpperCase().replaceAll('/', '').replace(/USDT$|USDC$|USD$/, '');
          if (/^[A-Z0-9._-]{1,24}$/.test(symbol) && !byDisplaySymbol.has(symbol)) {
            byDisplaySymbol.set(symbol, { symbol, apiSymbol });
          }
        }
        const universe = [...byDisplaySymbol.values()];
        setDynaUniverse(universe);
        const preferred = getMarketSymbols().map((symbol) =>
          symbol.trim().toUpperCase().replaceAll('/', '').replace(/USDT$|USDC$|USD$/, '')
        );
        const initial = preferred
          .map((symbol) => byDisplaySymbol.get(symbol))
          .filter((candidate): candidate is { symbol: string; apiSymbol: string } => Boolean(candidate))
          .slice(0, 4);
        await loadDynaQuotes(initial.length > 0 ? initial : universe.slice(0, 4));
        setLoading(false);
        setLoadError(null);
        return;
      }

      // Render the first working quote source immediately. 24h stats and
      // sparklines are enrichment; they must not hold Search behind a second
      // provider (or prevent it working where Binance is unavailable).
      const midsResponse = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'allMids' }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!midsResponse.ok) throw new Error(`Market price API error: ${midsResponse.status}`);
      const mids = await midsResponse.json() as Record<string, string>;
      const assets: Record<string, AssetData> = {};
      for (const [symbol, rawPrice] of Object.entries(mids)) {
        if (symbol.startsWith('@')) continue;
        const price = Number.parseFloat(rawPrice);
        if (!Number.isFinite(price) || price <= 0) continue;
        assets[symbol] = {
          price, change24h: 0, volume: 0, high24h: price, low24h: price, sparkline: [],
        };
      }
      setAllAssets(assets);
      setLastUpdate(new Date());
      setLoading(false);
      setLoadError(null);

      try {
        const marketResponse = await fetch(buildMarketUrl(getMarketTicker24hrPath(), {}), {
          signal: AbortSignal.timeout(3_000),
        });
        if (!marketResponse.ok) return;
        const marketTickers = await marketResponse.json() as Array<{
        symbol: string;
        priceChangePercent: string;
        quoteVolume: string;
        highPrice: string;
        lowPrice: string;
        }>;

      // Create a map of symbol to full ticker data
      const tickerMap: Record<
        string,
        { change: number; volume: number; high: number; low: number }
      > = {};
      for (const ticker of marketTickers) {
        if (ticker.symbol.endsWith('USDT')) {
          const symbol = ticker.symbol.replace('USDT', '');
          tickerMap[symbol] = {
            change: parseFloat(ticker.priceChangePercent),
            volume: parseFloat(ticker.quoteVolume), // Use quote volume (USDT)
            high: parseFloat(ticker.highPrice),
            low: parseFloat(ticker.lowPrice),
          };
        }
      }

      const topSymbols = Object.entries(tickerMap)
        .sort((a, b) => b[1].volume - a[1].volume)
        .slice(0, 12)
        .map(([s]) => s);

      setAllAssets((current) => {
        const enriched = { ...current };
        for (const [symbol, stats] of Object.entries(tickerMap)) {
          const existing = enriched[symbol];
          if (existing) enriched[symbol] = {
            ...existing,
            change24h: stats.change,
            volume: stats.volume,
            high24h: stats.high,
            low24h: stats.low,
          };
        }
        return enriched;
      });

      // Quotes are enough to render/search immediately. Sparklines are
      // decoration, so load only the visible leaders after the page is usable.
      void Promise.all(topSymbols.map(async (symbol) => {
        try {
          const response = await fetch(buildMarketUrl(getMarketKlinesPath(), {
            symbol: `${symbol}USDT`, interval: '1h', limit: 24,
          }), { signal: AbortSignal.timeout(3_000) });
          const klines = await response.json() as unknown[][];
          const sparkline = klines.map((k) => parseFloat(k[4] as string));
          setAllAssets((current) => current[symbol]
            ? { ...current, [symbol]: { ...current[symbol], sparkline } }
            : current);
        } catch {
          // Keep the quote row if optional sparkline data is unavailable.
        }
      }));
      } catch {
        // Keep the immediately displayed prices when 24h stats are unavailable.
      }
    } catch (err) {
      setLoading(false);
      setLoadError(err instanceof Error ? err.message : 'Failed to load market data');
    }
  }

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text color="cyan" bold>
          SEARCH [F10]
        </Text>
        <Text dimColor>
          {' '}
          {Object.keys(allAssets).length} assets | {lastUpdate.toLocaleTimeString()}
        </Text>
      </Box>

      {/* Search Input */}
      <Box marginBottom={1}>
        <Text color="yellow">Search: </Text>
        <TextInput
          value={query}
          onChange={setQuery}
          placeholder="Type to search configured symbols..."
        />
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>{'─'.repeat(95)}</Text>
      </Box>

      {/* Column Headers */}
      <Box>
        <Box width={8}>
          <Text bold>Symbol</Text>
        </Box>
        <Box width={14}>
          <Text bold>Price</Text>
        </Box>
        <Box width={10}>
          <Text bold>24h %</Text>
        </Box>
        <Box width={12}>
          <Text bold>Volume</Text>
        </Box>
        <Box width={12}>
          <Text bold>High</Text>
        </Box>
        <Box width={12}>
          <Text bold>Low</Text>
        </Box>
        <Box width={20}>
          <Text bold>24h Trend</Text>
        </Box>
      </Box>
      <Box marginBottom={1}>
        <Text dimColor>{'─'.repeat(95)}</Text>
      </Box>

      {/* Results */}
      {results.length === 0 ? (
        <Box>
          <Text color={loadError ? 'red' : undefined} dimColor={!loadError}>
            {loading ? 'Fetching prices…' : loadError ?? `No results found for "${query}"`}
          </Text>
        </Box>
      ) : (
        results.map((r) => (
          <Box key={r.symbol}>
            <Box width={8}>
              <Text color="white" bold>
                {r.symbol}
              </Text>
            </Box>
            <Box width={14}>
              <Text color="white">${formatPrice(r.price)}</Text>
            </Box>
            <Box width={10}>
              <Text color={r.change24h >= 0 ? 'green' : 'red'}>
                {r.change24h >= 0 ? '+' : ''}
                {r.change24h.toFixed(2)}%
              </Text>
            </Box>
            <Box width={12}>
              <Text dimColor>{formatVolume(r.volume)}</Text>
            </Box>
            <Box width={12}>
              <Text color="green">${formatPrice(r.high24h)}</Text>
            </Box>
            <Box width={12}>
              <Text color="red">${formatPrice(r.low24h)}</Text>
            </Box>
            <Box width={20}>
              {r.sparkline.length > 0 ? (
                <Sparkline data={r.sparkline} width={16} color="auto" />
              ) : (
                <Text dimColor>--</Text>
              )}
            </Box>
          </Box>
        ))
      )}

      {/* Footer */}
      <Box marginTop={1}>
        <Text dimColor>{'─'.repeat(95)}</Text>
      </Box>
      <Box>
        <Text dimColor>Press </Text>
        <Text color="yellow">Esc</Text>
        <Text dimColor>
          {' '}
          to return | Sorted by volume | Trade via chat: "buy 0.1 &lt;symbol&gt;"
        </Text>
      </Box>
    </Box>
  );
}

function formatPrice(price: number): string {
  if (price >= 1000) return price.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (price >= 1) return price.toFixed(2);
  if (price >= 0.01) return price.toFixed(4);
  return price.toFixed(6);
}

function formatVolume(vol: number): string {
  if (vol >= 1e9) return (vol / 1e9).toFixed(1) + 'B';
  if (vol >= 1e6) return (vol / 1e6).toFixed(1) + 'M';
  if (vol >= 1e3) return (vol / 1e3).toFixed(1) + 'K';
  return vol.toFixed(0);
}

export default SearchScreen;

