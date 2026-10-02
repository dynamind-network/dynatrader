import { Box, Text, useInput } from '@dynatrader/ink/terminal';
import asciichart from 'asciichart';
import React, { useEffect, useMemo, useState } from 'react';
import { buildMarketUrl, getMarketKlinesPath } from '../../config/market-provider.js';
import { getDynaMindOHLCV, usesDynaMindMarketData } from '../../services/screen-data-provider.js';
import { getMarketSymbols } from '../common/marketSymbols.js';
import { ScreenPaneWorkspace, useScreenPaneController } from '../layout/ScreenPaneWorkspace.js';
import { useTerminalSize } from '../ResponsiveLayout.js';

interface ChartScreenProps {
  symbol?: string;
  onBack: () => void;
  terminalSize?: { width: number; height: number };
  workspaceDir?: string;
  selectedMarketSymbol?: string;
  onSelectedMarketSymbolChange?: (symbol: string) => void;
}

const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'];
const REFRESH_RATES: Record<string, number> = {
  '1m': 5000,
  '5m': 15000,
  '15m': 30000,
  '1h': 60000,
  '4h': 120000,
  '1d': 300000,
};

const CHART_MIN_HEIGHT = 10;
const CHART_MAX_HEIGHT = 18;

export function ChartScreen({ symbol: initialSymbol = '', onBack, terminalSize: providedSize, workspaceDir, selectedMarketSymbol, onSelectedMarketSymbolChange }: ChartScreenProps) {
  const internalSize = useTerminalSize();
  const outerSize = providedSize ?? internalSize;
  const paneController = useScreenPaneController({ screenId: 'chart', workspaceDir, terminalSize: outerSize, paneIds: ['chart', 'technicals'], defaultPanes: ['chart'] });
  const terminalSize = paneController.viewportFor('chart');
  const coins = useMemo(() => getMarketSymbols(), []);
  const [chartData, setChartData] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [intervalIndex, setIntervalIndex] = useState(3);
  const [coinIndex, setCoinIndex] = useState(Math.max(0, coins.indexOf(initialSymbol)));
  const [stats, setStats] = useState({
    price: 0,
    high: 0,
    low: 0,
    change: 0,
    first: 0,
  });
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date());

  useEffect(() => {
    const nextSymbol = selectedMarketSymbol || initialSymbol;
    const nextIndex = coins.indexOf(nextSymbol);
    if (nextIndex >= 0) setCoinIndex(nextIndex);
  }, [selectedMarketSymbol, initialSymbol, coins]);

  const interval = INTERVALS[intervalIndex];
  const symbol = coins[coinIndex] ?? coins[0] ?? '';
  const chartHeight = getChartHeight(terminalSize.height);

  useInput((input, key) => {
    const num = Number.parseInt(input, 10);
    if (num >= 1 && num <= 6) {
      setIntervalIndex(num - 1);
      return;
    }

    if (key.leftArrow) {
      setCoinIndex((prev) => { const next = (prev - 1 + coins.length) % coins.length; onSelectedMarketSymbolChange?.(coins[next] ?? ''); return next; });
      return;
    }

    if (key.rightArrow) {
      setCoinIndex((prev) => { const next = (prev + 1) % coins.length; onSelectedMarketSymbolChange?.(coins[next] ?? ''); return next; });
      return;
    }

    if (key.upArrow) {
      setIntervalIndex((prev) => (prev + 1) % INTERVALS.length);
      return;
    }

    if (key.downArrow) {
      setIntervalIndex((prev) => (prev - 1 + INTERVALS.length) % INTERVALS.length);
      return;
    }

    if (input === '<' || input === ',') {
      setCoinIndex((prev) => { const next = (prev - 1 + coins.length) % coins.length; onSelectedMarketSymbolChange?.(coins[next] ?? ''); return next; });
    } else if (input === '>' || input === '.') {
      setCoinIndex((prev) => { const next = (prev + 1) % coins.length; onSelectedMarketSymbolChange?.(coins[next] ?? ''); return next; });
    }
  }, { isActive: paneController.isInputActive('chart') });

  useEffect(() => {
    fetchChartData();
    // The bundled API is rate limited; cached snapshots are refreshed only
    // when their five minute cache expires. Exchange REST keeps its old cadence.
    const refreshRate = usesDynaMindMarketData()
      ? 5 * 60_000
      : REFRESH_RATES[interval] || 60000;
    const timer = setInterval(fetchChartData, refreshRate);
    return () => clearInterval(timer);
  }, [symbol, interval]);

  async function fetchChartData() {
    try {
      let closes: number[];
      if (usesDynaMindMarketData()) {
        const candles = await getDynaMindOHLCV(symbol, interval, 100);
        closes = candles.map((candle) => candle.close);
      } else {
        const url = buildMarketUrl(getMarketKlinesPath(), {
          symbol: `${symbol}USDT`, interval, limit: 100,
        });
        const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
        if (!response.ok) throw new Error('Failed to fetch chart data');
        const klines = (await response.json()) as unknown[][];
        closes = klines.map((k) => Number.parseFloat(k[4] as string));
      }
      if (closes.length === 0) throw new Error('No chart data returned');

      const high = Math.max(...closes);
      const low = Math.min(...closes);
      const current = closes[closes.length - 1];
      const first = closes[0];
      const change = first > 0 ? ((current - first) / first) * 100 : 0;

      setChartData(closes);
      setStats({ price: current, high, low, change, first });
      setLastUpdate(new Date());
      setLoading(false);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load chart');
      setLoading(false);
    }
  }

  const chartWidth = Math.max(20, terminalSize.width - 16);
  const chartConfig = {
    height: chartHeight,
    colors: [stats.change >= 0 ? asciichart.green : asciichart.red],
    format: (x: number) => ('$' + formatPrice(x)).padStart(10),
  };

  let chart: string;
  try {
    const maxPoints = Math.max(2, Math.floor(chartWidth / 11));
    chart = chartData.length > 0
      ? asciichart.plot(chartData.slice(-maxPoints), chartConfig)
      : error ? 'Chart data unavailable' : 'Fetching chart data…';
  } catch {
    chart = 'Unable to render chart';
  }

  const chartSeparator = '─'.repeat(Math.max(56, Math.min(terminalSize.width - 2, 88)));
  const rangePercent = stats.low > 0 ? ((stats.high - stats.low) / stats.low) * 100 : 0;
  const positionInRange =
    stats.high > stats.low ? ((stats.price - stats.low) / (stats.high - stats.low)) * 100 : 50;
  const trendSummary = getTrendSummary(chartData, stats.change);
  const volatilitySummary = getVolatilitySummary(chartData, stats.price);

  const mainPane = (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text color="cyan" bold>
          CHART [F9]
        </Text>
        <Text dimColor> </Text>
        <Text color="yellow" bold>
          {symbol}
        </Text>
        <Text color="white">/USDT</Text>
        <Text dimColor> {interval}</Text>
        <Text dimColor> | Updated {lastUpdate.toLocaleTimeString()}</Text>
      </Box>

      {error && <Text color="red">Chart data unavailable: {error}</Text>}

      <Box marginBottom={1}>
        <Text dimColor>Spot </Text>
        <Text color="white" bold>
          ${formatPrice(stats.price)}
        </Text>
        <Text dimColor> | 24h </Text>
        <Text color={stats.change >= 0 ? 'green' : 'red'} bold>
          {stats.change >= 0 ? '+' : ''}
          {stats.change.toFixed(2)}%
        </Text>
        <Text dimColor> | High </Text>
        <Text color="green">${formatPrice(stats.high)}</Text>
        <Text dimColor> | Low </Text>
        <Text color="red">${formatPrice(stats.low)}</Text>
        <Text dimColor> | Range </Text>
        <Text color="white">{rangePercent.toFixed(2)}%</Text>
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>Position in range </Text>
        <Text color="yellow">{positionInRange.toFixed(0)}%</Text>
        <Text dimColor> | Trend </Text>
        <Text color={stats.change >= 0 ? 'green' : 'red'}>{trendSummary}</Text>
        <Text dimColor> | Volatility </Text>
        <Text color="white">{volatilitySummary}</Text>
      </Box>

      <Text dimColor>{chartSeparator}</Text>
      <Box marginBottom={1}>
        <Text dimColor>Max </Text>
        <Text color="green">${formatPrice(stats.high)}</Text>
      </Box>

      <Box flexDirection="column">
        <Text>{chart}</Text>
      </Box>

      <Box marginTop={1} marginBottom={1}>
        <Text dimColor>Min </Text>
        <Text color="red">${formatPrice(stats.low)}</Text>
        <Text dimColor> | </Text>
        <Text dimColor>{`<-- 100 ${interval} candles ago`}</Text>
        <Text dimColor>{''.padEnd(Math.max(2, chartWidth - 42), ' ')}</Text>
        <Text dimColor>now --&gt;</Text>
      </Box>
      <Text dimColor>{chartSeparator}</Text>

      <Box marginTop={1} marginBottom={1}>
        <Text dimColor>Coins: </Text>
        {coins.map((coin, index) => (
          <Text key={coin}>
            <Text
              color={index === coinIndex ? 'cyan' : 'white'}
              bold={index === coinIndex}
              dimColor={index !== coinIndex}
            >
              {coin}
            </Text>
            <Text dimColor>{index < coins.length - 1 ? ' ' : ''}</Text>
          </Text>
        ))}
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>Intervals: </Text>
        {INTERVALS.map((int, index) => (
          <Text key={int}>
            <Text
              color={interval === int ? 'cyan' : 'white'}
              bold={interval === int}
              dimColor={interval !== int}
            >
              {index + 1}:{int}
            </Text>
            <Text dimColor>{index < INTERVALS.length - 1 ? '  ' : ''}</Text>
          </Text>
        ))}
      </Box>

      <Text dimColor>{chartSeparator}</Text>
      <Box>
        <Text dimColor>Keys: </Text>
        <Text color="yellow">1-6</Text>
        <Text dimColor> interval | </Text>
        <Text color="yellow">Up/Down</Text>
        <Text dimColor> cycle timeframe | </Text>
        <Text color="yellow">Left/Right</Text>
        <Text dimColor> coin | </Text>
        <Text color="yellow">Esc</Text>
        <Text dimColor> return</Text>
      </Box>
    </Box>
  );

  return (
    <ScreenPaneWorkspace
      controller={paneController}
      terminalSize={outerSize}
      panes={[
        { id: 'chart', title: `CHART · ${symbol}/USDT`, content: mainPane },
        {
          id: 'technicals',
          title: 'TECHNICAL SNAPSHOT',
          content: (
            <Box flexDirection="column" paddingX={1}>
              <Text dimColor>LAST PRICE</Text>
              <Text color="white" bold>${formatPrice(stats.price)}</Text>
              <Text dimColor>24H CHANGE</Text>
              <Text color={stats.change >= 0 ? 'green' : 'red'} bold>{stats.change >= 0 ? '+' : ''}{stats.change.toFixed(2)}%</Text>
              <Text dimColor>RANGE</Text>
              <Text color="yellow">{rangePercent.toFixed(2)}% · {positionInRange.toFixed(0)}% through range</Text>
              <Text dimColor>TREND</Text>
              <Text color={stats.change >= 0 ? 'green' : 'red'}>{trendSummary}</Text>
              <Text dimColor>VOLATILITY</Text>
              <Text>{volatilitySummary}</Text>
              <Text dimColor>Updated {lastUpdate.toLocaleTimeString()}</Text>
            </Box>
          ),
        },
      ]}
    />
  );
}

function getChartHeight(terminalHeight: number): number {
  const suggested = Math.floor(terminalHeight * 0.38);
  return Math.max(CHART_MIN_HEIGHT, Math.min(CHART_MAX_HEIGHT, suggested));
}

function getTrendSummary(data: number[], change: number): string {
  if (data.length < 2) {
    return 'Flat';
  }

  const recent = data.slice(-8);
  const first = recent[0];
  const last = recent[recent.length - 1];
  const recentChange = first > 0 ? ((last - first) / first) * 100 : 0;

  if (Math.abs(recentChange) < 0.35 && Math.abs(change) < 0.5) {
    return 'Flat';
  }

  if (recentChange > 0) {
    return recentChange > 1.5 ? 'Strong up' : 'Up';
  }

  return recentChange < -1.5 ? 'Strong down' : 'Down';
}

function getVolatilitySummary(data: number[], currentPrice: number): string {
  if (data.length < 2 || currentPrice <= 0) {
    return 'Low';
  }

  const min = Math.min(...data);
  const max = Math.max(...data);
  const rangePct = ((max - min) / currentPrice) * 100;

  if (rangePct < 1.5) {
    return 'Low';
  }

  if (rangePct < 4) {
    return 'Moderate';
  }

  return 'High';
}

function formatPrice(price: number): string {
  if (price >= 10000) return price.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (price >= 1000) return price.toLocaleString(undefined, { maximumFractionDigits: 1 });
  if (price >= 1) return price.toFixed(2);
  return price.toFixed(4);
}

export default ChartScreen;

