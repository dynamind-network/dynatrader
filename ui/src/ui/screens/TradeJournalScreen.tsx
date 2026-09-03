import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import {
  useTerminalSize,
  createSeparator,
  getOptimalColumnWidths,
  truncateText,
  getScreenBreakpoints,
  formatPnL,
} from '../ResponsiveLayout.js';

interface Trade {
  id: string;
  timestamp: number;
  exchange: string;
  symbol: string;
  side: 'buy' | 'sell';
  size: number;
  price: number;
  pnl?: number;
  fees?: number;
  strategy?: string;
  rationale?: string;
}

interface StrategyStats {
  strategy: string;
  totalPnl: number;
  tradeCount: number;
  winRate: number;
  avgPnl: number;
  totalFees: number;
}

interface DailyPnl {
  date: string;
  pnl: number;
  tradeCount: number;
  winRate: number;
}

interface TradeJournalProps {
  onBack: () => void;
}

export function TradeJournalScreen({ onBack }: TradeJournalProps) {
  const { width } = useTerminalSize();
  const breakpoints = getScreenBreakpoints(width);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [strategyStats, setStrategyStats] = useState<StrategyStats[]>([]);
  const [dailyPnl, setDailyPnl] = useState<DailyPnl[]>([]);
  const [selectedTab, setSelectedTab] = useState<'journal' | 'strategies' | 'daily' | 'stats'>('journal');
  const [filterExchange, setFilterExchange] = useState<string>('');
  const [filterStrategy, setFilterStrategy] = useState<string>('');
  const [lastUpdate, setLastUpdate] = useState(new Date());

  useEffect(() => {
    const interval = setInterval(() => {
      setLastUpdate(new Date());
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  const tabs = ['journal', 'strategies', 'daily', 'stats'] as const;

  function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString('en-US', { hour12: false });
  }

  function formatDate(ts: number): string {
    return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function formatPrice(price: number): string {
    if (price >= 1000) return `$${price.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
    if (price >= 1) return `$${price.toFixed(2)}`;
    return `$${price.toFixed(4)}`;
  }

  function formatSize(size: number): string {
    if (size >= 1000) return size.toLocaleString(undefined, { maximumFractionDigits: 0 });
    return size.toFixed(4);
  }

  function renderJournal() {
    if (trades.length === 0) {
      return (
        <Box flexDirection="column" padding={1}>
          <Text dimColor>No trades recorded yet.</Text>
        </Box>
      );
    }

    const filteredTrades = trades.filter((t) => {
      if (filterExchange && t.exchange !== filterExchange) return false;
      if (filterStrategy && t.strategy !== filterStrategy) return false;
      return true;
    });

    const colWidths = getOptimalColumnWidths(width - 4, [
      { minWidth: 8, weight: 1 },
      { minWidth: 6, weight: 1 },
      { minWidth: 6, weight: 1 },
      { minWidth: 8, weight: 1 },
      { minWidth: 6, weight: 1 },
      { minWidth: 6, weight: 1 },
      { minWidth: 10, weight: 1 },
      { minWidth: 8, weight: 1 },
    ]);

    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyan" bold>TRADE JOURNAL ({filteredTrades.length} trades)</Text>
        <Box marginTop={1}>
          <Text>{createSeparator(width - 2)}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor bold>
            {'TIME'.padEnd(colWidths[0])}
            {'EXCH'.padEnd(colWidths[1])}
            {'SYMBOL'.padEnd(colWidths[2])}
            {'SIDE'.padEnd(colWidths[3])}
            {'SIZE'.padEnd(colWidths[4])}
            {'PRICE'.padEnd(colWidths[5])}
            {'PNL'.padEnd(colWidths[6])}
            {'STRATEGY'.padEnd(colWidths[7])}
          </Text>
        </Box>
        <Box>
          <Text>{createSeparator(width - 2)}</Text>
        </Box>
        {filteredTrades.slice(0, 30).map((trade) => {
          const pnlColor = (trade.pnl ?? 0) >= 0 ? 'green' : 'red';
          const pnlStr = trade.pnl !== undefined
            ? ((trade.pnl >= 0 ? '+' : '') + trade.pnl.toFixed(2))
            : 'N/A';

          return (
            <Box key={trade.id}>
              <Text>
                {formatTime(trade.timestamp).padEnd(colWidths[0])}
                {truncateText(trade.exchange, colWidths[1]).padEnd(colWidths[1])}
                {truncateText(trade.symbol, colWidths[2]).padEnd(colWidths[2])}
              </Text>
              <Text color={trade.side === 'buy' ? 'green' : 'red'}>
                {trade.side.toUpperCase().padEnd(colWidths[3])}
              </Text>
              <Text>
                {formatSize(trade.size).padEnd(colWidths[4])}
                {formatPrice(trade.price).padEnd(colWidths[5])}
              </Text>
              <Text color={pnlColor}>
                {pnlStr.padEnd(colWidths[6])}
              </Text>
              <Text dimColor>
                {truncateText(trade.strategy || 'manual', colWidths[7])}
              </Text>
            </Box>
          );
        })}
      </Box>
    );
  }

  function renderStrategies() {
    if (strategyStats.length === 0) {
      return (
        <Box flexDirection="column" padding={1}>
          <Text dimColor>No strategy data available.</Text>
        </Box>
      );
    }

    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyan" bold>STRATEGY PERFORMANCE</Text>
        <Box marginTop={1}>
          <Text>{createSeparator(width - 2)}</Text>
        </Box>
        {strategyStats.map((stat) => {
          const pnlColor = stat.totalPnl >= 0 ? 'green' : 'red';
          return (
            <Box key={stat.strategy} flexDirection="column" marginTop={1}>
              <Box>
                <Text color="cyan" bold>{stat.strategy}</Text>
                <Text dimColor> ({stat.tradeCount} trades)</Text>
              </Box>
              <Box marginLeft={2}>
                <Text color={pnlColor}>PnL: {(stat.totalPnl >= 0 ? '+' : '')}${stat.totalPnl.toFixed(2)}</Text>
                <Text dimColor> | Win: {stat.winRate.toFixed(1)}%</Text>
                <Text dimColor> | Avg: ${(stat.avgPnl >= 0 ? '+' : '')}${stat.avgPnl.toFixed(2)}</Text>
                <Text dimColor> | Fees: ${stat.totalFees.toFixed(2)}</Text>
              </Box>
            </Box>
          );
        })}
      </Box>
    );
  }

  function renderDaily() {
    if (dailyPnl.length === 0) {
      return (
        <Box flexDirection="column" padding={1}>
          <Text dimColor>No daily PnL data available.</Text>
        </Box>
      );
    }

    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyan" bold>DAILY PnL</Text>
        <Box marginTop={1}>
          <Text>{createSeparator(width - 2)}</Text>
        </Box>
        {dailyPnl.slice(0, 30).map((day) => {
          const pnlColor = day.pnl >= 0 ? 'green' : 'red';
          const barWidth = Math.min(30, Math.abs(day.pnl) / 100);
          const bar = day.pnl >= 0
            ? '█'.repeat(Math.max(1, Math.floor(barWidth)))
            : '░'.repeat(Math.max(1, Math.floor(barWidth)));

          return (
            <Box key={day.date}>
              <Text>
                {day.date.padEnd(12)}
              </Text>
              <Text color={pnlColor}>
                {((day.pnl >= 0 ? '+' : '') + day.pnl.toFixed(2)).padStart(12)}
              </Text>
              <Text dimColor>
                {'  '}{day.tradeCount} trades{'  '}
              </Text>
              <Text color={pnlColor}>{bar}</Text>
            </Box>
          );
        })}
      </Box>
    );
  }

  function renderStats() {
    const totalPnl = trades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
    const totalFees = trades.reduce((sum, t) => sum + (t.fees ?? 0), 0);
    const wins = trades.filter((t) => (t.pnl ?? 0) > 0);
    const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
    const avgPnl = trades.length > 0 ? totalPnl / trades.length : 0;

    let bestTrade: Trade | null = null;
    let worstTrade: Trade | null = null;
    for (const t of trades) {
      if (!bestTrade || (t.pnl ?? 0) > (bestTrade.pnl ?? 0)) bestTrade = t;
      if (!worstTrade || (t.pnl ?? 0) < (worstTrade.pnl ?? 0)) worstTrade = t;
    }

    const pnlValues = trades.map((t) => t.pnl ?? 0).filter((p) => p !== 0);
    let sharpe = 0;
    if (pnlValues.length > 1) {
      const mean = pnlValues.reduce((a, b) => a + b, 0) / pnlValues.length;
      const variance = pnlValues.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / pnlValues.length;
      const stdDev = Math.sqrt(variance);
      sharpe = stdDev > 0 ? (mean / stdDev) * Math.sqrt(252) : 0;
    }

    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyan" bold>TRADING STATISTICS</Text>
        <Box marginTop={1}>
          <Text>{createSeparator(width - 2)}</Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Box borderStyle="round" borderColor="cyan" padding={1} flexDirection="column">
            <Text bold>OVERVIEW</Text>
            <Text>  Total Trades: {trades.length}</Text>
            <Text>  Total PnL: <Text color={totalPnl >= 0 ? 'green' : 'red'}>{(totalPnl >= 0 ? '+' : '')}${totalPnl.toFixed(2)}</Text></Text>
            <Text>  Total Fees: ${totalFees.toFixed(2)}</Text>
            <Text>  Win Rate: {winRate.toFixed(1)}%</Text>
            <Text>  Avg PnL: ${(avgPnl >= 0 ? '+' : '')}${avgPnl.toFixed(2)}</Text>
            <Text>  Sharpe Ratio: {sharpe.toFixed(2)}</Text>
          </Box>
        </Box>
        {bestTrade && (
          <Box marginTop={1} flexDirection="column">
            <Box borderStyle="round" borderColor="green" padding={1} flexDirection="column">
              <Text color="green" bold>BEST TRADE</Text>
              <Text>  {bestTrade.symbol} {bestTrade.side.toUpperCase()} @ {formatPrice(bestTrade.price)}</Text>
              <Text>  PnL: <Text color="green">+${(bestTrade.pnl ?? 0).toFixed(2)}</Text></Text>
              {bestTrade.rationale && <Text dimColor>  Rationale: {bestTrade.rationale}</Text>}
            </Box>
          </Box>
        )}
        {worstTrade && (
          <Box marginTop={1} flexDirection="column">
            <Box borderStyle="round" borderColor="red" padding={1} flexDirection="column">
              <Text color="red" bold>WORST TRADE</Text>
              <Text>  {worstTrade.symbol} {worstTrade.side.toUpperCase()} @ {formatPrice(worstTrade.price)}</Text>
              <Text>  PnL: <Text color="red">${(worstTrade.pnl ?? 0).toFixed(2)}</Text></Text>
              {worstTrade.rationale && <Text dimColor>  Rationale: {worstTrade.rationale}</Text>}
            </Box>
          </Box>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height="100%">
      <Box flexDirection="column" padding={1}>
        <Text color="cyan" bold>TRADE JOURNAL [F15]</Text>
        <Box marginTop={1}>
          {tabs.map((tab) => (
            <Box key={tab} marginRight={2}>
              <Text
                color={selectedTab === tab ? 'cyan' : 'white'}
                bold={selectedTab === tab}
                underline={selectedTab === tab}
              >
                {tab.toUpperCase()}
              </Text>
            </Box>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text>{createSeparator(width - 2)}</Text>
        </Box>
      </Box>

      <Box flexDirection="column">
        {selectedTab === 'journal' && renderJournal()}
        {selectedTab === 'strategies' && renderStrategies()}
        {selectedTab === 'daily' && renderDaily()}
        {selectedTab === 'stats' && renderStats()}
      </Box>

      <Box flexDirection="column" padding={1}>
        <Text>{createSeparator(width - 2)}</Text>
        <Box>
          <Text dimColor>Last update: {lastUpdate.toLocaleTimeString()}</Text>
          <Text dimColor> | Press </Text>
          <Text color="yellow">1-4</Text>
          <Text dimColor> to switch tabs, </Text>
          <Text color="yellow">Esc</Text>
          <Text dimColor> to return</Text>
        </Box>
      </Box>
    </Box>
  );
}

export default TradeJournalScreen;
