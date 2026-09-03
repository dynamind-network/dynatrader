import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Box, Text } from 'ink';
import logUpdate from 'log-update';
import type { NormalizedTicker, ExchangeConnection } from '../../services/websocket/types.js';
import { getWebSocketManager } from '../../services/websocket/index.js';
import { MARKET_SYMBOLS } from './marketSymbols.js';
import { buildMarketUrl, getMarketTicker24hrPath } from '../../config/market-provider.js';

interface LiveTickerProps {
  symbols?: string[];
  compact?: boolean;
  maxItems?: number;
}

interface TickerData {
  symbol: string;
  price: number;
  change24h: number;
  volume24h: number;
  funding: number;
  lastUpdate: Date;
}

export function LiveTicker({
  symbols = MARKET_SYMBOLS.slice(0, 3),
  compact = false,
  maxItems = 6,
}: LiveTickerProps) {
  const [tickers, setTickers] = useState<Map<string, TickerData>>(new Map());
  const [isConnected, setIsConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const wsManager = getWebSocketManager();

  useEffect(() => {
    initializeTicker();

    return () => {
      wsManager.unsubscribe(symbols.slice(0, maxItems), ['ticker']);
      wsManager.removeListener('ticker', handleTickerUpdate);
    };
  }, [symbols, maxItems]);

  const initializeTicker = async () => {
    try {
      wsManager.on('ticker', handleTickerUpdate);
      wsManager.on('connectionChange', (conns: Map<string, ExchangeConnection>) => {
        const connected = Array.from(conns.values()).some(
          (c: ExchangeConnection) => c.state === 'connected'
        );
        setIsConnected(connected);
      });

      await wsManager.connect();
      wsManager.subscribe(symbols.slice(0, maxItems), ['ticker']);
    } catch (err) {
      console.error('Failed to connect ticker:', err);
      fetchFallbackPrices();
    }
  };

  const handleTickerUpdate = useCallback((data: NormalizedTicker) => {
    setTickers((prev) => {
      const updated = new Map(prev);
      const existing = updated.get(data.symbol);

      updated.set(data.symbol, {
        symbol: data.symbol,
        price: data.lastPrice,
        change24h: data.priceChangePercent24h,
        volume24h: data.volumeUsd24h,
        funding: data.fundingRate * 100,
        lastUpdate: new Date(),
      });

      return updated;
    });
    setLastUpdate(new Date());
  }, []);

  const fetchFallbackPrices = async () => {
    try {
      const response = await fetch(buildMarketUrl(getMarketTicker24hrPath(), {}));
      const tickers = (await response.json()) as any[];

      const filtered = tickers.filter((t: any) =>
        symbols.slice(0, maxItems).includes(t.symbol.replace('USDT', ''))
      );

      const newTickers = new Map<string, TickerData>();
      filtered.forEach((t: any) => {
        const symbol = t.symbol.replace('USDT', '');
        newTickers.set(symbol, {
          symbol,
          price: parseFloat(t.lastPrice),
          change24h: parseFloat(t.priceChangePercent),
          volume24h: parseFloat(t.quoteVolume),
          funding: 0,
          lastUpdate: new Date(),
        });
      });

      setTickers(newTickers);
      setLastUpdate(new Date());
    } catch (err) {
      console.error('Failed to fetch fallback prices:', err);
    }
  };

  const formatPrice = (price: number): string => {
    if (price >= 10000) return price.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (price >= 1000) return price.toFixed(1);
    if (price >= 1) return price.toFixed(2);
    return price.toFixed(4);
  };

  const formatVolume = (vol: number): string => {
    if (vol >= 1e9) return (vol / 1e9).toFixed(2) + 'B';
    if (vol >= 1e6) return (vol / 1e6).toFixed(1) + 'M';
    if (vol >= 1e3) return (vol / 1e3).toFixed(1) + 'K';
    return vol.toFixed(0);
  };

  // Render ticker as string for log-update (for standalone mode)
  const renderTickerString = (): string => {
    const tickerArray = Array.from(tickers.values()).slice(0, maxItems);
    if (tickerArray.length === 0) return 'Loading...';

    const parts = tickerArray.map((t) => {
      const changeColor = t.change24h >= 0 ? '\x1b[32m' : '\x1b[31m';
      const changeSign = t.change24h >= 0 ? '+' : '';
      return `${t.symbol}: $${formatPrice(t.price)} ${changeColor}${changeSign}${t.change24h.toFixed(2)}%\x1b[0m`;
    });

    return parts.join('  |  ');
  };

  // Use log-update for compact standalone mode
  useEffect(() => {
    if (compact && tickers.size > 0) {
      const interval = setInterval(() => {
        logUpdate(renderTickerString());
      }, 500);

      return () => clearInterval(interval);
    }
  }, [compact, tickers]);

  // Compact mode uses Ink components
  if (compact) {
    const tickerArray = Array.from(tickers.values()).slice(0, maxItems);
    return (
      <Box>
        {tickerArray.map((t, idx) => (
          <React.Fragment key={t.symbol}>
            {idx > 0 && <Text dimColor> | </Text>}
            <Text bold>{t.symbol}</Text>
            <Text> ${formatPrice(t.price)}</Text>
            <Text color={t.change24h >= 0 ? 'green' : 'red'}>
              {t.change24h >= 0 ? '+' : ''}
              {t.change24h.toFixed(2)}%
            </Text>
          </React.Fragment>
        ))}
      </Box>
    );
  }

  // Full mode with detailed view
  const tickerArray = Array.from(tickers.values()).slice(0, maxItems);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan" bold>
          LIVE TICKER
        </Text>
        <Text dimColor> | </Text>
        <Text color={isConnected ? 'green' : 'yellow'}>
          {isConnected ? 'Connected' : 'Connecting...'}
        </Text>
        {lastUpdate && (
          <>
            <Text dimColor> | </Text>
            <Text dimColor>{lastUpdate.toLocaleTimeString()}</Text>
          </>
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        {tickerArray.length === 0 ? (
          <Text dimColor>Loading prices...</Text>
        ) : (
          tickerArray.map((t) => (
            <Box key={t.symbol}>
              <Box width={8}>
                <Text bold>{t.symbol}</Text>
              </Box>
              <Box width={14}>
                <Text>${formatPrice(t.price)}</Text>
              </Box>
              <Box width={12}>
                <Text color={t.change24h >= 0 ? 'green' : 'red'}>
                  {t.change24h >= 0 ? '+' : ''}
                  {t.change24h.toFixed(2)}%
                </Text>
              </Box>
              <Box width={14}>
                <Text dimColor>Vol: {formatVolume(t.volume24h)}</Text>
              </Box>
              <Box width={12}>
                <Text color={t.funding > 0.01 ? 'red' : t.funding < -0.01 ? 'green' : 'yellow'}>
                  {t.funding >= 0 ? '+' : ''}
                  {t.funding.toFixed(4)}%
                </Text>
              </Box>
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}

// Hook for using live ticker data in other components
export function useLiveTicker(symbols: string[] = MARKET_SYMBOLS.slice(0, 3)) {
  const [tickers, setTickers] = useState<Map<string, TickerData>>(new Map());
  const [isConnected, setIsConnected] = useState(false);
  const pendingTickersRef = useRef<Map<string, TickerData>>(new Map());
  const throttleTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastUpdateRef = useRef<number>(0);

  const wsManager = getWebSocketManager();

  const flushTickers = useCallback(() => {
    throttleTimerRef.current = null;
    const pending = pendingTickersRef.current;
    if (pending.size === 0) return;

    setTickers((prev) => {
      let changed = false;
      const updated = new Map(prev);
      for (const [symbol, data] of pending.entries()) {
        const existing = updated.get(symbol);
        // Only update if price changed by more than 0.01% or data is new
        if (!existing || Math.abs(existing.price - data.price) / existing.price > 0.0001) {
          updated.set(symbol, data);
          changed = true;
        }
      }
      return changed ? updated : prev;
    });
    pendingTickersRef.current = new Map();
  }, []);

  const scheduleFlush = useCallback(() => {
    if (throttleTimerRef.current) return;
    const now = Date.now();
    const elapsed = now - lastUpdateRef.current;
    const delay = Math.max(0, 1000 - elapsed);

    throttleTimerRef.current = setTimeout(() => {
      lastUpdateRef.current = Date.now();
      flushTickers();
    }, delay);
  }, [flushTickers]);

  useEffect(() => {
    const initialize = async () => {
      try {
        wsManager.on('ticker', handleTickerUpdate);
        wsManager.on('connectionChange', (conns: Map<string, ExchangeConnection>) => {
          const connected = Array.from(conns.values()).some(
            (c: ExchangeConnection) => c.state === 'connected'
          );
          setIsConnected(connected);
        });

        await wsManager.connect();
        wsManager.subscribe(symbols, ['ticker']);
      } catch (err) {
        console.error('Failed to connect ticker:', err);
      }
    };

    initialize();

    return () => {
      if (throttleTimerRef.current) {
        clearTimeout(throttleTimerRef.current);
        throttleTimerRef.current = null;
      }
      wsManager.unsubscribe(symbols, ['ticker']);
      wsManager.removeListener('ticker', handleTickerUpdate);
    };
  }, [symbols]);

  const handleTickerUpdate = useCallback(
    (data: NormalizedTicker) => {
      pendingTickersRef.current.set(data.symbol, {
        symbol: data.symbol,
        price: data.lastPrice,
        change24h: data.priceChangePercent24h,
        volume24h: data.volumeUsd24h,
        funding: data.fundingRate * 100,
        lastUpdate: new Date(),
      });
      scheduleFlush();
    },
    [scheduleFlush]
  );

  return { tickers, isConnected };
}

export default LiveTicker;
