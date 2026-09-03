import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { Sparkline } from './Sparkline.js';
import {
  buildMarketUrl,
  getMarketKlinesPath,
  getMarketTicker24hrPath,
} from '../../config/market-provider.js';

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
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date());

  useEffect(() => {
    fetchAllAssets();
    const interval = setInterval(fetchAllAssets, 15000);
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

  async function fetchAllAssets() {
    try {
      // Fetch prices from Hyperliquid
      const hlResponse = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'allMids' }),
      });

      const mids = (await hlResponse.json()) as Record<string, string>;

      // Fetch 24h ticker data from the configured market provider (includes volume, high, low)
      const marketResponse = await fetch(buildMarketUrl(getMarketTicker24hrPath(), {}));
      const marketTickers = (await marketResponse.json()) as Array<{
        symbol: string;
        priceChangePercent: string;
        volume: string;
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

      // Get top symbols for sparkline fetching (limit to reduce API calls)
      const topSymbols = Object.entries(mids)
        .filter(([s]) => !s.startsWith('@') && tickerMap[s])
        .sort((a, b) => (tickerMap[b[0]]?.volume || 0) - (tickerMap[a[0]]?.volume || 0))
        .slice(0, 30)
        .map(([s]) => s);

      // Fetch sparklines for top symbols
      const sparklineMap: Record<string, number[]> = {};
      await Promise.all(
        topSymbols.map(async (symbol) => {
          try {
            const klineRes = await fetch(
              buildMarketUrl(getMarketKlinesPath(), {
                symbol: `${symbol}USDT`,
                interval: '1h',
                limit: 24,
              })
            );
            const klines = (await klineRes.json()) as unknown[][];
            sparklineMap[symbol] = klines.map((k) => parseFloat(k[4] as string));
          } catch {
            sparklineMap[symbol] = [];
          }
        })
      );

      const assets: Record<string, AssetData> = {};
      for (const [symbol, price] of Object.entries(mids)) {
        // Filter out the @ prefixed symbols for cleaner display
        if (!symbol.startsWith('@')) {
          const ticker = tickerMap[symbol];
          assets[symbol] = {
            price: parseFloat(price),
            change24h: ticker?.change || 0,
            volume: ticker?.volume || 0,
            high24h: ticker?.high || parseFloat(price),
            low24h: ticker?.low || parseFloat(price),
            sparkline: sparklineMap[symbol] || [],
          };
        }
      }

      setAllAssets(assets);
      setLastUpdate(new Date());
      setLoading(false);
    } catch (err) {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyan" bold>
          SEARCH [F10]
        </Text>
        <Text dimColor>Loading assets...</Text>
      </Box>
    );
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
          <Text dimColor>No results found for "{query}"</Text>
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
