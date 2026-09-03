import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import Conf from 'conf';
import { Sparkline } from './Sparkline.js';
import type { PriceData } from './types.js';
import {
  buildMarketUrl,
  getMarketKlinesPath,
  getMarketTicker24hrPath,
} from '../../config/market-provider.js';

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
      const interval = setInterval(fetchPrices, 10000);
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
      // Fetch from Hyperliquid for watchlist coins
      const response = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'allMids' }),
      });

      const mids = (await response.json()) as Record<string, string>;

      // Also fetch 24hr data from the market provider for change %
      const marketResponse = await fetch(buildMarketUrl(getMarketTicker24hrPath(), {}));
      const marketTickers = (await marketResponse.json()) as Array<{
        symbol: string;
        priceChangePercent: string;
        volume: string;
        highPrice: string;
        lowPrice: string;
      }>;

      const pricesData: PriceData[] = await Promise.all(
        watchlist.map(async (coin) => {
          const price = parseFloat(mids[coin] || '0');
          const marketTicker = marketTickers.find((t) => t.symbol === `${coin}USDT`);

          let sparkline: number[] = [];
          try {
            // Fetch klines for sparkline
            const klineUrl = buildMarketUrl(getMarketKlinesPath(), {
              symbol: `${coin}USDT`,
              interval: '1h',
              limit: 24,
            });
            const klineRes = await fetch(klineUrl);
            const klines = (await klineRes.json()) as unknown[][];
            if (Array.isArray(klines)) {
              sparkline = klines.map((k) => parseFloat(k[4] as string));
            }
          } catch {
            // Sparkline fetch failed, continue without it
          }

          return {
            symbol: coin,
            price: price || (marketTicker ? parseFloat(marketTicker.highPrice) : 0),
            change24h: marketTicker ? parseFloat(marketTicker.priceChangePercent) : 0,
            volume: marketTicker ? parseFloat(marketTicker.volume) : 0,
            high24h: marketTicker ? parseFloat(marketTicker.highPrice) : 0,
            low24h: marketTicker ? parseFloat(marketTicker.lowPrice) : 0,
            sparkline,
          };
        })
      );

      setPrices(pricesData.filter((p) => p.price > 0));
      setLastUpdate(new Date());
      setLoading(false);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch prices');
      setLoading(false);
    }
  }

  if (loading && prices.length === 0 && watchlist.length > 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyan" bold>
          WATCHLIST [F8]
        </Text>
        <Text dimColor>Loading watchlist...</Text>
      </Box>
    );
  }

  if (error && prices.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyan" bold>
          WATCHLIST [F8]
        </Text>
        <Text color="red">Error: {error}</Text>
        <Text dimColor>Press Esc to return to chat</Text>
      </Box>
    );
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

      {watchlist.length === 0 ? (
        <Box flexDirection="column">
          <Text dimColor>Your watchlist is empty.</Text>
          <Box marginTop={1}>
            <Text dimColor>Add assets via chat or set a workspace watchlist.</Text>
          </Box>
        </Box>
      ) : (
        <>
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
