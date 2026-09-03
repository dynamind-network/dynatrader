import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import type { NormalizedOrderbook } from '../../services/websocket/types.js';
import { getWebSocketManager, type Exchange } from '../../services/websocket/index.js';
import { MARKET_SYMBOLS } from '../common/marketSymbols.js';
import { buildMarketUrl, getMarketDepthPath } from '../../config/market-provider.js';
import { useTerminalSize, createSeparator } from '../ResponsiveLayout.js';

interface OrderBookScreenProps {
  onBack: () => void;
  terminalSize?: { width: number; height: number };
  initialSymbol?: string;
}

export function OrderBookScreen({
  onBack,
  terminalSize: providedSize,
  initialSymbol = MARKET_SYMBOLS[0] ?? '',
}: OrderBookScreenProps) {
  const internalSize = useTerminalSize();
  const terminalWidth = providedSize?.width ?? internalSize.width;
  const [symbol, setSymbol] = useState(initialSymbol);
  const [orderbook, setOrderbook] = useState<NormalizedOrderbook | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [depth, setDepth] = useState(10);
  const [exchange, setExchange] = useState<Exchange | 'aggregated'>('aggregated');

  const wsManager = getWebSocketManager();
  const exchangeOptions = [...wsManager.getSupportedExchanges(), 'aggregated' as const];

  useEffect(() => {
    initializeOrderbook();

    return () => {
      wsManager.unsubscribe([symbol], ['orderbook']);
      wsManager.removeListener('orderbook', handleOrderbookUpdate);
    };
  }, [symbol, exchange]);

  async function initializeOrderbook() {
    setLoading(true);
    setError(null);

    try {
      wsManager.on('orderbook', handleOrderbookUpdate);
      await wsManager.connect();
      wsManager.subscribe([symbol], ['orderbook']);
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect');
      setLoading(false);
      fetchOrderbookREST();
    }
  }

  const handleOrderbookUpdate = useCallback(
    (data: NormalizedOrderbook) => {
      if (data.symbol === symbol) {
        if (exchange === 'aggregated' || data.exchange === exchange) {
          setOrderbook(data);
        }
      }
    },
    [symbol, exchange]
  );

  async function fetchOrderbookREST() {
    try {
      const response = await fetch(
        buildMarketUrl(getMarketDepthPath(), { symbol: `${symbol}USDT`, limit: 20 })
      );
      const data = (await response.json()) as any;

      const orderbookData: NormalizedOrderbook = {
        symbol,
        exchange: 'binance',
        bids: data.bids.slice(0, 20).map(([price, size]: [string, string]) => ({
          price: parseFloat(price),
          size: parseFloat(size),
        })),
        asks: data.asks.slice(0, 20).map(([price, size]: [string, string]) => ({
          price: parseFloat(price),
          size: parseFloat(size),
        })),
        bestBid: parseFloat(data.bids[0][0]),
        bestAsk: parseFloat(data.asks[0][0]),
        spread: parseFloat(data.asks[0][0]) - parseFloat(data.bids[0][0]),
        spreadPercent:
          ((parseFloat(data.asks[0][0]) - parseFloat(data.bids[0][0])) /
            parseFloat(data.bids[0][0])) *
          100,
        timestamp: Date.now(),
      };

      setOrderbook(orderbookData);
      setLoading(false);
    } catch (_err) {
      setError('Failed to fetch orderbook data');
    }
  }

  useInput((input, key) => {
    if (key.upArrow) {
      const currentIndex = MARKET_SYMBOLS.indexOf(symbol);
      const nextIndex = (currentIndex + 1) % MARKET_SYMBOLS.length;
      setSymbol(MARKET_SYMBOLS[nextIndex]);
    } else if (key.downArrow) {
      const currentIndex = MARKET_SYMBOLS.indexOf(symbol);
      const prevIndex = (currentIndex - 1 + MARKET_SYMBOLS.length) % MARKET_SYMBOLS.length;
      setSymbol(MARKET_SYMBOLS[prevIndex]);
    } else if (key.pageUp || input === '=') {
      setDepth(Math.min(20, depth + 5));
    } else if (key.pageDown || input === '-') {
      setDepth(Math.max(5, depth - 5));
    } else if (input === 'e') {
      const currentIndex = exchangeOptions.indexOf(exchange);
      setExchange(exchangeOptions[(currentIndex + 1) % exchangeOptions.length]);
    }
  });

  const formatPrice = (price: number): string => {
    if (price >= 1000) return price.toFixed(2);
    if (price >= 1) return price.toFixed(4);
    return price.toFixed(6);
  };

  const formatSize = (size: number): string => {
    if (size >= 1000) return (size / 1000).toFixed(2) + 'K';
    if (size >= 1) return size.toFixed(4);
    return size.toFixed(6);
  };

  if (loading && !orderbook) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyan" bold>
          ORDER BOOK [F13]
        </Text>
        <Text dimColor>Loading orderbook for {symbol}...</Text>
      </Box>
    );
  }

  if (error && !orderbook) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyan" bold>
          ORDER BOOK [F13]
        </Text>
        <Text color="red">Error: {error}</Text>
        <Text dimColor>Press Esc to return</Text>
      </Box>
    );
  }

  const separator = createSeparator(terminalWidth, '-');
  const midPrice = orderbook ? (orderbook.bestBid + orderbook.bestAsk) / 2 : 0;

  // Calculate max sizes for depth visualization
  const maxBidSize = orderbook ? Math.max(...orderbook.bids.slice(0, depth).map((b) => b.size)) : 1;
  const maxAskSize = orderbook ? Math.max(...orderbook.asks.slice(0, depth).map((a) => a.size)) : 1;

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text color="cyan" bold>
          ORDER BOOK [F13]
        </Text>
        <Text dimColor> | </Text>
        <Text color="white" bold>
          {symbol}/USDT
        </Text>
        <Text dimColor> | </Text>
        <Text color="yellow">{exchange.toUpperCase()}</Text>
        <Text dimColor> | Depth: {depth}</Text>
      </Box>

      {orderbook && (
        <>
          <Box marginBottom={1} flexDirection="column">
            <Box>
              <Text dimColor>Spread: </Text>
              <Text color="yellow">{formatPrice(orderbook.spread)}</Text>
              <Text dimColor> ({orderbook.spreadPercent.toFixed(3)}%)</Text>
            </Box>
            <Box>
              <Text dimColor>Mid: </Text>
              <Text color="white" bold>
                {formatPrice(midPrice)}
              </Text>
            </Box>
            <Box>
              <Text dimColor>Best Bid: </Text>
              <Text color="green">{formatPrice(orderbook.bestBid)}</Text>
              <Text dimColor> | Best Ask: </Text>
              <Text color="red">{formatPrice(orderbook.bestAsk)}</Text>
            </Box>
          </Box>

          <Text dimColor>{separator}</Text>

          {/* Table Header */}
          <Box>
            <Box width={16}>
              <Text color="cyan" bold>
                Ask Size
              </Text>
            </Box>
            <Box width={16}>
              <Text color="cyan" bold>
                Ask Price
              </Text>
            </Box>
            <Box width={4}>
              <Text dimColor> </Text>
            </Box>
            <Box width={16}>
              <Text color="cyan" bold>
                Bid Price
              </Text>
            </Box>
            <Box width={16}>
              <Text color="cyan" bold>
                Bid Size
              </Text>
            </Box>
          </Box>

          <Text dimColor>{separator}</Text>

          {/* Asks (reversed - highest at top) */}
          {orderbook.asks
            .slice(0, depth)
            .reverse()
            .map((ask, idx) => {
              const bid = orderbook.bids[idx];
              const askDepthBar = Math.round((ask.size / maxAskSize) * 8);

              return (
                <Box key={`ask-${idx}`}>
                  <Box width={16}>
                    <Text color="white">{formatSize(ask.size)}</Text>
                  </Box>
                  <Box width={16}>
                    <Text color="red">
                      {formatPrice(ask.price)}
                      <Text dimColor>{'\u2588'.repeat(askDepthBar)}</Text>
                    </Text>
                  </Box>
                  <Box width={4}>
                    <Text dimColor> | </Text>
                  </Box>
                  {bid ? (
                    <>
                      <Box width={16}>
                        <Text color="green">{formatPrice(bid.price)}</Text>
                      </Box>
                      <Box width={16}>
                        <Text color="white">{formatSize(bid.size)}</Text>
                      </Box>
                    </>
                  ) : (
                    <>
                      <Box width={16} />
                      <Box width={16} />
                    </>
                  )}
                </Box>
              );
            })}

          {/* Spread Indicator */}
          <Box marginY={1}>
            <Text color="yellow" bold>
              {'\u2500'.repeat(36)} SPREAD {'\u2500'.repeat(36)}
            </Text>
          </Box>

          {/* Bids */}
          {orderbook.bids.slice(0, depth).map((bid, idx) => {
            const ask = orderbook.asks[idx];
            const bidDepthBar = Math.round((bid.size / maxBidSize) * 8);

            return (
              <Box key={`bid-${idx}`}>
                <Box width={16}>
                  {ask ? <Text color="white">{formatSize(ask.size)}</Text> : <Text />}
                </Box>
                <Box width={16}>
                  {ask ? <Text color="red">{formatPrice(ask.price)}</Text> : <Text />}
                </Box>
                <Box width={4}>
                  <Text dimColor> | </Text>
                </Box>
                <Box width={16}>
                  <Text color="green">
                    {formatPrice(bid.price)}
                    <Text dimColor>{'\u2588'.repeat(bidDepthBar)}</Text>
                  </Text>
                </Box>
                <Box width={16}>
                  <Text color="white">{formatSize(bid.size)}</Text>
                </Box>
              </Box>
            );
          })}

          <Text dimColor>{separator}</Text>

          {/* Cumulative Depth */}
          <Box marginTop={1}>
            <Text dimColor>Total Bids: </Text>
            <Text color="green" bold>
              {formatSize(orderbook.bids.slice(0, depth).reduce((sum, b) => sum + b.size, 0))}
            </Text>
            <Text dimColor> | Total Asks: </Text>
            <Text color="red" bold>
              {formatSize(orderbook.asks.slice(0, depth).reduce((sum, a) => sum + a.size, 0))}
            </Text>
          </Box>
        </>
      )}

      <Box marginTop={1}>
        <Text dimColor>Press </Text>
        <Text color="yellow">Esc</Text>
        <Text dimColor> return | </Text>
        <Text color="yellow">Up/Down</Text>
        <Text dimColor> symbol | </Text>
        <Text color="yellow">+/-</Text>
        <Text dimColor> depth | </Text>
        <Text color="yellow">E</Text>
        <Text dimColor> exchange</Text>
      </Box>
    </Box>
  );
}

export default OrderBookScreen;
