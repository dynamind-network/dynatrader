import { Box, Text } from '@dynatrader/ink/terminal';
import Conf from 'conf';
import React, { useEffect, useState } from 'react';
import {
  buildMarketUrl,
  getMarketKlinesPath,
  getMarketTicker24hrPath,
} from '../../config/market-provider.js';
import { getDynaMindPrices, usesDynaMindMarketData } from '../../services/screen-data-provider.js';
import { Sparkline } from './Sparkline.js';
import type { PriceData } from './types.js';

interface WatchlistScreenProps {
  onBack: () => void;
}

// Persistent watchlist storage
const watchlistConfig = new Conf<{ watchlist: string[] }>({
  projectName: 'dynamind-terminal',
  defaults: { watchlist: [] },
});

// Export for use by chat commands
export function getWatchlist(): string[] {
  return watchlistConfig.get('watchlist') || [];
}

export function addToWatchlist(symbol: string): boolean {
  const watchlist = getWatchlist();
  const upperSymbol = symbol.toUpperCase();
  if (!watchlist.includes(upperSymbol)) {
    watchlist.push(upperSymbol);
    watchlistConfig.set('watchlist', watchlist);
    return true;
  }
  return false;
}

export function removeFromWatchlist(symbol: string): boolean {
  const watchlist = getWatchlist();
  const upperSymbol = symbol.toUpperCase();
  const index = watchlist.indexOf(upperSymbol);
  if (index !== -1) {
    watchlist.splice(index, 1);
    watchlistConfig.set('watchlist', watchlist);
    return true;
  }
  return false;
}

export function clearWatchlist(): void {
  watchlistConfig.set('watchlist', []);
}

/**
 * F8 - Watchlist Screen
 * Custom watchlist with live prices and persistent storage
 */
export function WatchlistScreen({ onBack }: WatchlistScreenProps) {
  const [prices, setPrices] = useState<PriceData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date());
  const [watchlist, setWatchlist] = useState<string[]>([]);

  useEffect(() => {
    // Load watchlist from persistent storage
    const stored = getWatchlist();
    setWatchlist(stored);
  }, []);

  useEffect(() => {
    if (watchlist.length > 0) {
      fetchPrices();
      const interval = setInterval(fetchPrices, 5 * 60_000);
      return () => clearInterval(interval);
    } else {
      setLoading(false);
    }
  }, [watchlist]);

  async function fetchPrices() {
    if (watchlist.length === 0) {
      setPrices([]);
      setLoading(false);
      return;
    }

    try {
      if (usesDynaMindMarketData()) {
        let successfulQuotes = 0;
        await getDynaMindPrices(watchlist, 4, ({ symbol, price }) => {
          if (price === null || !Number.isFinite(price) || price <= 0) return;
          successfulQuotes += 1;
          const update: PriceData = {
            symbol, price, change24h: 0, volume: 0,
            high24h: price, low24h: price, sparkline: [],
          };
          setPrices((current) => [...current.filter((item) => item.symbol !== symbol), update]);
          setLastUpdate(new Date());
          setLoading(false);
          setError(null);
        });
        if (successfulQuotes === 0) {
          setError('No watchlist prices are available from DynaMind.');
          setLoading(false);
        }
        return;
      }

      // Current prices come from one compact snapshot, so the first rows appear
      // without waiting for per-symbol enrichment from the exchange REST API.
      const response = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'allMids' }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`Market price API error: ${response.status}`);
      const mids = await response.json() as Record<string, string>;
      const pricesData: PriceData[] = watchlist.map((coin) => {
        const price = Number.parseFloat(mids[coin] || '0');
        return {
          symbol: coin,
          price: Number.isFinite(price) ? price : 0,
          change24h: 0,
          volume: 0,
          high24h: Number.isFinite(price) ? price : 0,
          low24h: Number.isFinite(price) ? price : 0,
          sparkline: [],
        };
      });
      setPrices(pricesData.filter((p) => p.price > 0));
      setLastUpdate(new Date());
      setLoading(false);
      setError(null);

      try {
      // Enrichment is optional and scoped to the symbols the user follows.
      const symbols = watchlist.map((coin) => `${coin}USDT`);
      const marketResponse = await fetch(buildMarketUrl(getMarketTicker24hrPath(), {
        symbols: JSON.stringify(symbols),
      }), { signal: AbortSignal.timeout(3_000) });
      if (!marketResponse.ok) return;
      const marketTickers = await marketResponse.json() as Array<{
        symbol: string;
        lastPrice: string;
        priceChangePercent: string;
        quoteVolume: string;
        highPrice: string;
        lowPrice: string;
      }>;
      const tickerBySymbol = new Map(marketTickers.map((ticker) => [ticker.symbol, ticker]));

      setPrices((current) => current.map((item) => {
        const marketTicker = tickerBySymbol.get(`${item.symbol}USDT`);
        if (!marketTicker) return item;
        return {
          ...item,
          change24h: parseFloat(marketTicker.priceChangePercent),
          volume: parseFloat(marketTicker.quoteVolume),
          high24h: parseFloat(marketTicker.highPrice),
          low24h: parseFloat(marketTicker.lowPrice),
        };
      }));

      // Prices render as soon as quote endpoints return. Sparkline history is
      // optional and must not hold the watchlist open on its loading state.
      void Promise.all(pricesData.map(async (item) => {
        try {
          const response = await fetch(buildMarketUrl(getMarketKlinesPath(), {
            symbol: `${item.symbol}USDT`, interval: '1h', limit: 24,
          }), { signal: AbortSignal.timeout(3_000) });
          const klines = await response.json() as unknown[][];
          const sparkline = klines.map((k) => parseFloat(k[4] as string));
          setPrices((current) => current.map((price) => price.symbol === item.symbol
            ? { ...price, sparkline }
            : price));
        } catch {
          // Keep prices visible if optional sparkline data is unavailable.
        }
      }));
      } catch {
        // The price snapshot remains usable if the optional exchange feed fails.
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch prices');
      setLoading(false);
    }
  }

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text color="cyan" bold>
          WATCHLIST [F8]
        </Text>
        <Text dimColor>
          {' '}
          {watchlist.length} assets | Last update: {lastUpdate.toLocaleTimeString()}
        </Text>
      </Box>

      {error && <Text color="red">{error}</Text>}

      {watchlist.length === 0 ? (
        <Box flexDirection="column">
          <Text dimColor>Your watchlist is empty.</Text>
          <Box marginTop={1}>
            <Text dimColor>Add assets via chat or set a workspace watchlist.</Text>
          </Box>
        </Box>
      ) : (
        <>
          {loading && prices.length === 0 && <Text dimColor>Fetching watchlist prices…</Text>}
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
            <Box width={14}>
              <Text bold>Volume</Text>
            </Box>
            <Box width={24}>
              <Text bold>24h Trend</Text>
            </Box>
          </Box>
          <Box marginBottom={1}>
            <Text dimColor>{'─'.repeat(70)}</Text>
          </Box>

          {/* Price Rows */}
          {prices.map((p) => (
            <Box key={p.symbol}>
              <Box width={8}>
                <Text color="white" bold>
                  {p.symbol}
                </Text>
              </Box>
              <Box width={14}>
                <Text color="white">${formatPrice(p.price)}</Text>
              </Box>
              <Box width={10}>
                <Text color={p.change24h >= 0 ? 'green' : 'red'}>
                  {p.change24h >= 0 ? '+' : ''}
                  {p.change24h.toFixed(2)}%
                </Text>
              </Box>
              <Box width={14}>
                <Text dimColor>{formatVolume(p.volume)}</Text>
              </Box>
              <Box width={24}>
                {p.sparkline.length > 0 ? (
                  <Sparkline data={p.sparkline} width={20} color="auto" />
                ) : (
                  <Text dimColor>-</Text>
                )}
              </Box>
            </Box>
          ))}
        </>
      )}

      {/* Footer */}
      <Box marginTop={1}>
        <Text dimColor>{'─'.repeat(70)}</Text>
      </Box>
      <Box>
        <Text dimColor>Press </Text>
        <Text color="yellow">Esc</Text>
        <Text dimColor>
          {' '}
          to return | "add &lt;symbol&gt; to watchlist" | "remove &lt;symbol&gt; from watchlist"
          with any configured asset symbol
        </Text>
      </Box>
    </Box>
  );
}

function formatPrice(price: number): string {
  if (price >= 1000) return price.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (price >= 1) return price.toFixed(2);
  return price.toFixed(4);
}

function formatVolume(vol: number): string {
  if (vol >= 1e9) return (vol / 1e9).toFixed(1) + 'B';
  if (vol >= 1e6) return (vol / 1e6).toFixed(1) + 'M';
  if (vol >= 1e3) return (vol / 1e3).toFixed(1) + 'K';
  return vol.toFixed(0);
}

export default WatchlistScreen;

