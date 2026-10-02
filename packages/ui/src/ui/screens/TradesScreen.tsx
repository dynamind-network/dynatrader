import { Box, Text } from '@dynatrader/ink/terminal';
import React, { useEffect, useState } from 'react';
import { MARKET_SYMBOLS } from '../common/marketSymbols.js';
import { ScreenPaneWorkspace, useScreenPaneController } from '../layout/ScreenPaneWorkspace.js';
import {
  createSeparator,
  getOptimalColumnWidths,
  getScreenBreakpoints,
  truncateText,
  useTerminalSize,
} from '../ResponsiveLayout.js';

interface Trade {
  coin: string;
  side: 'buy' | 'sell';
  px: string;
  sz: string;
  time: number;
  hash: string;
}

interface TradesScreenProps {
  onBack: () => void;
  terminalSize?: { width: number; height: number };
  workspaceDir?: string;
}

export function TradesScreen({ onBack, terminalSize: providedSize, workspaceDir }: TradesScreenProps) {
  const internalSize = useTerminalSize();
  const terminalSize = providedSize ?? internalSize;
  const paneController = useScreenPaneController({ screenId: 'trades', workspaceDir, terminalSize, paneIds: ['tape', 'volume', 'activity'], defaultPanes: ['tape'] });
  const terminalWidth = paneController.viewportFor('tape').width;
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date());
  const [selectedCoin, setSelectedCoin] = useState(MARKET_SYMBOLS[0] ?? '');

  const breakpoints = getScreenBreakpoints(terminalWidth);

  useEffect(() => {
    fetchTrades();
    const interval = setInterval(fetchTrades, 5000);
    return () => clearInterval(interval);
  }, [selectedCoin]);

  async function fetchTrades() {
    try {
      const response = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'recentTrades',
            coin: selectedCoin,
          }),
          signal: AbortSignal.timeout(5_000),
        });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = (await response.json()) as Array<{
        coin: string;
        side: string;
        px: string;
        sz: string;
        time: number;
        hash: string;
      }>;

      const formattedTrades: Trade[] = data.slice(0, 15).map((t) => ({
        coin: t.coin,
        side: t.side.toLowerCase() as 'buy' | 'sell',
        px: t.px,
        sz: t.sz,
        time: t.time,
        hash: t.hash,
      }));

      setTrades(formattedTrades);
      setLastUpdate(new Date());
      setLoading(false);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch trades');
      setLoading(false);
    }
  }

  const columnConfigs = breakpoints.isCompact
    ? [
        { key: 'time', header: 'Time', minWidth: 8, maxWidth: 10, weight: 1 },
        { key: 'side', header: 'Side', minWidth: 4, maxWidth: 6, weight: 1 },
        { key: 'price', header: 'Price', minWidth: 10, maxWidth: 14, weight: 1 },
        { key: 'size', header: 'Size', minWidth: 8, maxWidth: 12, weight: 1 },
      ]
    : [
        { key: 'time', header: 'Time', minWidth: 10, maxWidth: 12, weight: 1 },
        { key: 'coin', header: 'Coin', minWidth: 6, maxWidth: 8, weight: 1 },
        { key: 'side', header: 'Side', minWidth: 5, maxWidth: 8, weight: 1 },
        { key: 'price', header: 'Price', minWidth: 12, maxWidth: 16, weight: 1 },
        { key: 'size', header: 'Size', minWidth: 10, maxWidth: 14, weight: 1 },
        { key: 'value', header: 'Value', minWidth: 10, maxWidth: 16, weight: 1 },
      ];

  const columnWidths = getOptimalColumnWidths(terminalWidth, columnConfigs);
  const separator = createSeparator(terminalWidth, '-');
  const headerSeparator = createSeparator(terminalWidth, '=');

  if (loading && trades.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyan" bold>
          TRADES [F4]
        </Text>
        <Text dimColor>Loading trades...</Text>
      </Box>
    );
  }

  if (error && trades.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyan" bold>
          TRADES [F4]
        </Text>
        <Text color="red">Error: {error}</Text>
        <Text dimColor>Press Esc to return to chat</Text>
      </Box>
    );
  }

  const formatTradeRow = (t: Trade, index: number) => {
    const time = new Date(t.time).toLocaleTimeString();
    const price = parseFloat(t.px);
    const size = parseFloat(t.sz);
    const value = price * size;

    const values: Record<string, string> = {
      time,
      coin: t.coin,
      side: t.side.toUpperCase(),
      price: `$${formatPrice(price)}`,
      size: formatSize(size),
      value: `$${formatValue(value)}`,
    };

    return (
      <Box key={`${t.hash}-${index}`}>
        {columnConfigs.map((col, i) => {
          const value = values[col.key] || '';
          const truncated = truncateText(value, columnWidths[i]);
          let color = 'white';

          if (col.key === 'side') {
            color = t.side === 'buy' ? 'green' : 'red';
          } else if (col.key === 'value') {
            color = 'yellow';
          } else if (col.key === 'coin') {
            color = 'white';
          }

          return (
            <Box key={col.key} width={columnWidths[i]}>
              <Text color={color}>{truncated}</Text>
            </Box>
          );
        })}
      </Box>
    );
  };

  const mainPane = (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text color="cyan" bold>
          TRADES [F4]
        </Text>
        <Text dimColor>
          {' '}
          {selectedCoin} | Last update: {lastUpdate.toLocaleTimeString()}
        </Text>
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

      {trades.slice(0, breakpoints.isCompact ? 10 : 15).map((t, i) => formatTradeRow(t, i))}

      <Text dimColor>{separator}</Text>

      <Box>
        <Text dimColor>Press </Text>
        <Text color="yellow">Esc</Text>
        <Text dimColor> to return | </Text>
        <Text color="yellow">Alt+M</Text>
        <Text dimColor> for markets | </Text>
        <Text color="yellow">Alt+P</Text>
        <Text dimColor> for portfolio</Text>
      </Box>
    </Box>
  );

  const buys = trades.filter((trade) => trade.side === 'buy');
  const sells = trades.filter((trade) => trade.side === 'sell');
  const notional = (items: Trade[]) => items.reduce((sum, trade) => sum + Number(trade.px) * Number(trade.sz), 0);
  const flowPane = (
    <Box flexDirection="column" paddingX={1}>
      <Text dimColor>RECENT PRINTS · {selectedCoin}</Text>
      <Text color="white" bold>{trades.length} trades observed</Text>
      <Text color="green">BUY  {buys.length.toString().padStart(3)} · ${formatValue(notional(buys))}</Text>
      <Text color="red">SELL {sells.length.toString().padStart(3)} · ${formatValue(notional(sells))}</Text>
      <Text dimColor> </Text>
      {trades.slice(0, 8).map((trade, index) => (
        <Box key={`${trade.hash}-${index}`}>
          <Text dimColor>{new Date(trade.time).toLocaleTimeString()} </Text>
          <Text color={trade.side === 'buy' ? 'green' : 'red'}>{trade.side.toUpperCase()} </Text>
          <Text color="yellow">${formatValue(Number(trade.px) * Number(trade.sz))}</Text>
        </Box>
      ))}
      {error && <Text color="red">Feed issue: {error}</Text>}
    </Box>
  );

  return (
    <ScreenPaneWorkspace
      controller={paneController}
      terminalSize={terminalSize}
      panes={[
        { id: 'tape', title: `TRADES · ${selectedCoin}`, content: mainPane },
        { id: 'flow', title: 'TAPE FLOW', content: flowPane },
      ]}
    />
  );
}

function formatPrice(price: number): string {
  if (price >= 1000) return price.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (price >= 1) return price.toFixed(2);
  return price.toFixed(6);
}

function formatSize(size: number): string {
  if (size >= 1000) return size.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (size >= 1) return size.toFixed(4);
  return size.toFixed(6);
}

function formatValue(val: number): string {
  if (val >= 1e6) return (val / 1e6).toFixed(2) + 'M';
  if (val >= 1e3) return (val / 1e3).toFixed(2) + 'K';
  return val.toFixed(2);
}

export default TradesScreen;

