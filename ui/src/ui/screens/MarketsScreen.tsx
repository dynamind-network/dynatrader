import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { Sparkline } from './Sparkline.js';
import type { PriceData } from './types.js';
import {
  getWebSocketManager,
  type AggregatedMarket,
  type NormalizedLiquidation,
  type Exchange,
  type ExchangeConnection,
} from '../../services/websocket/index.js';
import { MARKET_SYMBOLS } from '../common/marketSymbols.js';
import { ScreenPaneWorkspace, useScreenPaneController } from '../layout/ScreenPaneWorkspace.js';
import { buildMarketUrl, getMarketTicker24hrPath } from '../../config/market-provider.js';
import {
  useTerminalSize,
  createSeparator,
  getOptimalColumnWidths,
  truncateText,
  getScreenBreakpoints,
} from '../ResponsiveLayout.js';

interface MarketsScreenProps {
  onBack: () => void;
  terminalSize?: { width: number; height: number };
  workspaceDir?: string;
  selectedMarketSymbol?: string;
  onSelectedMarketSymbolChange?: (symbol: string) => void;
}

interface ExtendedMarketData extends PriceData {
  avgFunding: number;
  totalOI: number;
  spread: number;
  spreadPercent: number;
  exchangeCount: number;
  exchanges: Map<Exchange, { price: number; funding: number; volume: number }>;
}

export function MarketsScreen({ onBack, terminalSize: providedSize, workspaceDir, onSelectedMarketSymbolChange }: MarketsScreenProps) {
  const internalSize = useTerminalSize();
  const outerSize = providedSize ?? internalSize;
  const paneController = useScreenPaneController({ screenId: 'markets', workspaceDir, terminalSize: outerSize, paneIds: ['tape', 'flow', 'momentum'], defaultPanes: ['tape'] });
  const terminalWidth = paneController.viewportFor('tape').width;
  const [markets, setMarkets] = useState<ExtendedMarketData[]>([]);
  const [liquidations, setLiquidations] = useState<NormalizedLiquidation[]>([]);
  const [connections, setConnections] = useState<Map<Exchange, ExchangeConnection>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date());
  const [showExpanded, setShowExpanded] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [sortBy, setSortBy] = useState<'symbol' | 'price' | 'change' | 'funding' | 'oi' | 'spread'>(
    'symbol'
  );

  useEffect(() => {
    const selected = markets[selectedIndex];
    if (selected) onSelectedMarketSymbolChange?.(selected.symbol.replace(/USDT$/, ''));
  }, [markets, selectedIndex, onSelectedMarketSymbolChange]);

  const wsManager = getWebSocketManager();
  const breakpoints = getScreenBreakpoints(terminalWidth);

  useEffect(() => {
    initializeWebSocket();

    return () => {
      // Only remove our own listeners, not all listeners on the shared singleton
      wsManager.removeListener('aggregated', handleAggregatedUpdate);
      wsManager.removeListener('liquidation', handleLiquidation);
      wsManager.removeListener('connectionChange', handleConnectionChange);
      wsManager.removeListener('exchangeError', handleError);
    };
  }, []);

  async function initializeWebSocket() {
    try {
      wsManager.on('aggregated', handleAggregatedUpdate);
      wsManager.on('liquidation', handleLiquidation);
      wsManager.on('connectionChange', handleConnectionChange);
      wsManager.on('exchangeError', handleError);

      await wsManager.connect();

      const symbols = MARKET_SYMBOLS.slice(0, 16);
      wsManager.subscribe(symbols, ['ticker', 'funding', 'liquidation']);

      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect');
      setLoading(false);
      fetchFallbackPrices();
    }
  }

  const handleAggregatedUpdate = useCallback(
    (data: AggregatedMarket) => {
      setMarkets((prev) => {
        const updated = [...prev];
        const index = updated.findIndex((m) => m.symbol === data.symbol);

        const marketData: ExtendedMarketData = {
          symbol: data.symbol,
          price: data.weightedAvgPrice,
          change24h: data.priceChangePercent24h,
          volume: data.totalVolume24h,
          high24h: data.maxPrice,
          low24h: data.minPrice,
          sparkline: [],
          avgFunding: data.avgFundingRate * 100,
          totalOI: data.totalOpenInterest,
          spread: data.spread,
          spreadPercent: data.spreadPercent,
          exchangeCount: data.exchangeCount,
          exchanges: new Map(),
        };

        for (const [exchange, ticker] of data.exchanges) {
          marketData.exchanges.set(exchange, {
            price: ticker.lastPrice,
            funding: ticker.fundingRate * 100,
            volume: ticker.volumeUsd24h,
          });
        }

        if (index >= 0) {
          updated[index] = marketData;
        } else {
          updated.push(marketData);
        }

        return updated.sort((a, b) => {
          switch (sortBy) {
            case 'price':
              return b.price - a.price;
            case 'change':
              return b.change24h - a.change24h;
            case 'funding':
              return Math.abs(b.avgFunding) - Math.abs(a.avgFunding);
            case 'oi':
              return b.totalOI - a.totalOI;
            case 'spread':
              return b.spreadPercent - a.spreadPercent;
            default:
              return compareSymbols(a.symbol, b.symbol);
          }
        });
      });
      setLastUpdate(new Date());
    },
    [sortBy]
  );

  const handleLiquidation = useCallback((liq: NormalizedLiquidation) => {
    setLiquidations((prev) => {
      const updated = [liq, ...prev].slice(0, 10);
      return updated;
    });
  }, []);

  const handleConnectionChange = useCallback((conns: Map<Exchange, ExchangeConnection>) => {
    setConnections(new Map(conns));
  }, []);

  const handleError = useCallback((exchange: Exchange, err: Error) => {
    console.error(`[${exchange}] Error:`, err.message);
  }, []);

  async function fetchFallbackPrices() {
    try {
      const symbols = MARKET_SYMBOLS.slice(0, 8).map((symbol) => `${symbol}USDT`);
      const response = await fetch(buildMarketUrl(getMarketTicker24hrPath(), {}));
      const tickers = (await response.json()) as any[];

      const filtered = tickers.filter((t: any) => symbols.includes(t.symbol));
      const marketsData: ExtendedMarketData[] = filtered.map((t: any) => ({
        symbol: t.symbol.replace('USDT', ''),
        price: parseFloat(t.lastPrice),
        change24h: parseFloat(t.priceChangePercent),
        volume: parseFloat(t.quoteVolume),
        high24h: parseFloat(t.highPrice),
        low24h: parseFloat(t.lowPrice),
        sparkline: [],
        avgFunding: 0,
        totalOI: 0,
        spread: 0,
        spreadPercent: 0,
        exchangeCount: 1,
        exchanges: new Map(),
      }));

      setMarkets(marketsData);
      setLoading(false);
    } catch (err) {
      setError('Failed to fetch fallback data');
    }
  }

  useInput((input, key) => {
    if (key.upArrow && selectedIndex > 0) {
      setSelectedIndex(selectedIndex - 1);
    } else if (key.downArrow && selectedIndex < markets.length - 1) {
      setSelectedIndex(selectedIndex + 1);
    } else if (input === 'e') {
      setShowExpanded(!showExpanded);
    } else if (input === 's') {
      const sortOptions: (typeof sortBy)[] = [
        'symbol',
        'price',
        'change',
        'funding',
        'oi',
        'spread',
      ];
      const currentIdx = sortOptions.indexOf(sortBy);
      setSortBy(sortOptions[(currentIdx + 1) % sortOptions.length]);
    }
  }, { isActive: paneController.isInputActive('tape') });

  const connectedCount = Array.from(connections.values()).filter(
    (c) => c.state === 'connected'
  ).length;
  const totalExchanges = connections.size || 10;

  const columnConfigs = breakpoints.isCompact
    ? [
        { key: 'symbol', header: 'Sym', minWidth: 4, maxWidth: 6, weight: 1 },
        { key: 'price', header: 'Price', minWidth: 8, maxWidth: 12, weight: 1 },
        { key: 'change', header: '24h%', minWidth: 6, maxWidth: 8, weight: 1 },
      ]
    : [
        { key: 'symbol', header: 'Symbol', minWidth: 6, maxWidth: 8, weight: 1 },
        { key: 'price', header: 'Avg Price', minWidth: 10, maxWidth: 14, weight: 1 },
        { key: 'change', header: '24h %', minWidth: 7, maxWidth: 9, weight: 1 },
        { key: 'funding', header: 'Funding', minWidth: 8, maxWidth: 10, weight: 1 },
        { key: 'oi', header: 'Total OI', minWidth: 8, maxWidth: 12, weight: 1 },
        { key: 'spread', header: 'Spread', minWidth: 6, maxWidth: 8, weight: 1 },
        { key: 'volume', header: 'Volume', minWidth: 8, maxWidth: 12, weight: 1 },
        { key: 'exchanges', header: 'Exch', minWidth: 4, maxWidth: 6, weight: 1 },
      ];

  const columnWidths = getOptimalColumnWidths(terminalWidth, columnConfigs);
  const separator = createSeparator(terminalWidth, '-');
  const headerSeparator = createSeparator(terminalWidth, '=');

  if (loading && markets.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyan" bold>
          MARKETS [F2]
        </Text>
        <Text dimColor>Connecting to {totalExchanges} exchanges...</Text>
        <Box marginTop={1}>
          {Array.from(connections.entries()).map(([exchange, conn]) => (
            <Text
              key={exchange}
              color={
                conn.state === 'connected'
                  ? 'green'
                  : conn.state === 'connecting'
                    ? 'yellow'
                    : 'red'
              }
            >
              {exchange.toUpperCase().slice(0, 3)}{' '}
              {conn.state === 'connected' ? '[OK]' : '[...]'}{' '}
            </Text>
          ))}
        </Box>
      </Box>
    );
  }

  if (error && markets.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyan" bold>
          MARKETS [F2]
        </Text>
        <Text color="red">Error: {error}</Text>
        <Text dimColor>Press Esc to return</Text>
      </Box>
    );
  }

  const formatMarketRow = (market: ExtendedMarketData, isSelected: boolean) => {
    const values: Record<string, string> = {
      symbol: market.symbol,
      price: `$${formatPrice(market.price)}`,
      change: `${market.change24h >= 0 ? '+' : ''}${market.change24h.toFixed(2)}%`,
      funding: `${market.avgFunding >= 0 ? '+' : ''}${market.avgFunding.toFixed(4)}%`,
      oi: formatVolume(market.totalOI),
      spread: `${market.spreadPercent.toFixed(3)}%`,
      volume: formatVolume(market.volume),
      exchanges: String(market.exchangeCount),
    };

    const cells = columnConfigs.map((col, i) => {
      const value = values[col.key] || '';
      const truncated = truncateText(value, columnWidths[i]);
      const isHighlighted = isSelected && i === 0;

      let color = 'gray';
      let dimColor = true;
      let bold = false;

      if (col.key === 'symbol') {
        color = isHighlighted ? 'cyan' : 'white';
        dimColor = false;
        bold = true;
      } else if (col.key === 'price') {
        color = 'white';
        dimColor = false;
        bold = true;
      } else if (col.key === 'change') {
        color = market.change24h >= 0 ? 'green' : 'red';
        dimColor = false;
        bold = true;
      } else if (col.key === 'funding') {
        color = market.avgFunding > 0.01 ? 'red' : market.avgFunding < -0.01 ? 'green' : 'yellow';
      } else if (col.key === 'spread') {
        color = market.spreadPercent > 0.05 ? 'yellow' : 'green';
      }

      return (
        <Box key={col.key} width={columnWidths[i]}>
          <Text
            color={color}
            dimColor={dimColor}
            bold={
              isSelected
                ? col.key === 'symbol' || col.key === 'price' || col.key === 'change'
                : bold
            }
          >
            {isSelected && i === 0 ? '>' : ''}
            {truncated}
          </Text>
        </Box>
      );
    });

    return (
      <Box key={market.symbol} flexDirection="column">
        <Box>{cells}</Box>

        {showExpanded && isSelected && market.exchanges.size > 0 && (
          <Box marginLeft={2} flexDirection="column">
            <Text dimColor> Per-Exchange Breakdown:</Text>
            <Box flexWrap="wrap">
              {Array.from(market.exchanges.entries())
                .slice(0, breakpoints.isCompact ? 4 : 6)
                .map(([ex, data]) => (
                  <Box key={ex} width={breakpoints.isCompact ? 16 : 20}>
                    <Text dimColor>{ex.slice(0, 4).toUpperCase()}: </Text>
                    <Text color="white">${formatPrice(data.price)}</Text>
                  </Box>
                ))}
            </Box>
            <Box flexWrap="wrap">
              <Text dimColor> Funding: </Text>
              {Array.from(market.exchanges.entries())
                .slice(0, breakpoints.isCompact ? 4 : 6)
                .map(([ex, data]) => (
                  <Text
                    key={ex}
                    color={data.funding > 0.01 ? 'red' : data.funding < -0.01 ? 'green' : 'yellow'}
                  >
                    {ex.slice(0, 2).toUpperCase()}:{data.funding >= 0 ? '+' : ''}
                    {data.funding.toFixed(3)}%{' '}
                  </Text>
                ))}
            </Box>
          </Box>
        )}
      </Box>
    );
  };

  const mainPane = (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text color="cyan" bold>
          MARKETS [F2]
        </Text>
        <Text dimColor> </Text>
        <Text color={connectedCount === totalExchanges ? 'green' : 'yellow'}>
          Live | {connectedCount}/{totalExchanges} Exchanges
        </Text>
        <Text dimColor> | {lastUpdate.toLocaleTimeString()}</Text>
        <Text dimColor> | Sort: </Text>
        <Text color="yellow">{sortBy.toUpperCase()}</Text>
      </Box>

      <Text dimColor>{headerSeparator}</Text>

      <Box>
        {columnConfigs.map((col, i) => (
          <Box key={col.key} width={columnWidths[i]}>
            <Text bold>{truncateText(col.header, columnWidths[i])}</Text>
          </Box>
        ))}
      </Box>

      <Text dimColor>{separator}</Text>

      {markets
        .slice(0, breakpoints.isCompact ? 8 : 12)
        .map((m, idx) => formatMarketRow(m, idx === selectedIndex))}

      {liquidations.length > 0 && (
        <>
          <Text dimColor>{separator}</Text>
          <Box marginBottom={1}>
            <Text color="magenta" bold>
              Recent Liquidations
            </Text>
          </Box>
          {liquidations.slice(0, breakpoints.isCompact ? 3 : 5).map((liq, idx) => (
            <Box key={idx}>
              <Text dimColor>{new Date(liq.timestamp).toLocaleTimeString()}</Text>
              <Text> | </Text>
              <Text color="white" bold>
                {liq.symbol}
              </Text>
              <Text> </Text>
              <Text color={liq.side === 'long' ? 'red' : 'green'}>{liq.side.toUpperCase()}</Text>
              <Text> </Text>
              <Text color="yellow">${formatVolume(liq.usdValue)}</Text>
              <Text dimColor> @ ${formatPrice(liq.price)}</Text>
              <Text dimColor> ({liq.exchange})</Text>
            </Box>
          ))}
        </>
      )}

      <Text dimColor>{separator}</Text>

      <Box>
        <Text dimColor>Press </Text>
        <Text color="yellow">Esc</Text>
        <Text dimColor> return | </Text>
        <Text color="yellow">Tab</Text>
        <Text dimColor> expand | </Text>
        <Text color="yellow">S</Text>
        <Text dimColor> sort | </Text>
        <Text color="yellow">Up/Down</Text>
        <Text dimColor> navigate</Text>
      </Box>
    </Box>
  );

  const strongest = [...markets].sort((a, b) => b.change24h - a.change24h).slice(0, 5);
  const funding = [...markets].sort((a, b) => Math.abs(b.avgFunding) - Math.abs(a.avgFunding)).slice(0, 5);
  const liquidationPane = (
    <Box flexDirection="column" paddingX={1}>
      {liquidations.length ? liquidations.slice(0, 10).map((liq, index) => (
        <Box key={`${liq.timestamp}-${liq.symbol}-${index}`}>
          <Text color={liq.side === 'long' ? 'red' : 'green'}>{liq.side.toUpperCase().padEnd(5)}</Text>
          <Text color="white" bold> {liq.symbol}</Text>
          <Text color="yellow"> ${formatVolume(liq.usdValue)}</Text>
          <Text dimColor> {new Date(liq.timestamp).toLocaleTimeString()}</Text>
        </Box>
      )) : <Text dimColor>Waiting for liquidation events…</Text>}
      <Text dimColor>Live aggregate from connected exchanges</Text>
    </Box>
  );
  const momentumPane = (
    <Box flexDirection="column" paddingX={1}>
      <Text color="green" bold>TOP 24H MOVERS</Text>
      {strongest.map((market) => <Box key={market.symbol} justifyContent="space-between"><Text color="white" bold>{market.symbol}</Text><Text color={market.change24h >= 0 ? 'green' : 'red'}>{market.change24h >= 0 ? '+' : ''}{market.change24h.toFixed(2)}%</Text></Box>)}
      <Text dimColor> </Text>
      <Text color="yellow" bold>FUNDING EXTREMES</Text>
      {funding.map((market) => <Box key={`funding-${market.symbol}`} justifyContent="space-between"><Text>{market.symbol}</Text><Text color={market.avgFunding > 0 ? 'red' : 'green'}>{market.avgFunding >= 0 ? '+' : ''}{market.avgFunding.toFixed(4)}%</Text></Box>)}
      <Text dimColor>Cross-venue aggregate · refreshed {lastUpdate.toLocaleTimeString()}</Text>
    </Box>
  );

  return (
    <ScreenPaneWorkspace
      controller={paneController}
      terminalSize={outerSize}
      panes={[
        { id: 'tape', title: 'MARKET TAPE', content: mainPane },
        { id: 'flow', title: 'LIQUIDATION FLOW', content: liquidationPane },
        { id: 'momentum', title: 'CROSS-MARKET PULSE', content: momentumPane },
      ]}
    />
  );
}

function formatPrice(price: number): string {
  if (price >= 10000) return price.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (price >= 1000) return price.toLocaleString(undefined, { maximumFractionDigits: 1 });
  if (price >= 1) return price.toFixed(2);
  if (price >= 0.01) return price.toFixed(4);
  return price.toFixed(6);
}

function formatVolume(vol: number): string {
  if (vol >= 1e12) return (vol / 1e12).toFixed(1) + 'T';
  if (vol >= 1e9) return (vol / 1e9).toFixed(1) + 'B';
  if (vol >= 1e6) return (vol / 1e6).toFixed(1) + 'M';
  if (vol >= 1e3) return (vol / 1e3).toFixed(1) + 'K';
  return vol.toFixed(0);
}

function compareSymbols(a: string, b: string): number {
  return a.localeCompare(b, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

export default MarketsScreen;
