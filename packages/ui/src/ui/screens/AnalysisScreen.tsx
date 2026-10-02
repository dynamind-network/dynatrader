import { Box, Text, useInput } from '@dynatrader/ink/terminal';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { buildMarketUrl, getMarketKlinesPath } from '../../config/market-provider.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { getDynaMindOHLCV, usesDynaMindMarketData } from '../../services/screen-data-provider.js';
import { type AggregatedMarket, getWebSocketManager } from '../../services/websocket/index.js';
import { calculateAllIndicators, type OHLCV } from '../../utils/indicators.js';
import { getMarketSymbols } from '../common/marketSymbols.js';
import { ScreenPaneWorkspace, useScreenPaneController } from '../layout/ScreenPaneWorkspace.js';

interface Indicator {
  name: string;
  value: string | number;
  signal: 'bullish' | 'bearish' | 'neutral';
  description?: string;
}

interface AnalysisScreenProps {
  onBack: () => void;
  terminalSize?: { width: number; height: number };
  workspaceDir?: string;
  selectedMarketSymbol?: string;
  onSelectedMarketSymbolChange?: (symbol: string) => void;
}

type Timeframe = '1h' | '4h' | '1D' | '1W';
const TIMEFRAMES: { value: Timeframe; label: string; candles: number; interval: string }[] = [
  { value: '1h', label: '1h', candles: 200, interval: '1h' },
  { value: '4h', label: '4h', candles: 200, interval: '4h' },
  { value: '1D', label: '1D', candles: 100, interval: '1d' },
  { value: '1W', label: '1W', candles: 52, interval: '1w' },
];

/**
 * F6 - Analysis Screen (Enhanced)
 * Full technical analysis suite with 25+ indicators
 * Multi-timeframe support, signal strength scoring
 * Stochastic RSI, ADX, Williams %R, OBV, CVD, Ichimoku, Fibonacci, Pivot Points
 */
export function AnalysisScreen({ onBack, terminalSize: providedSize, workspaceDir, selectedMarketSymbol, onSelectedMarketSymbolChange }: AnalysisScreenProps) {
  const internalSize = useTerminalSize();
  const terminalSize = providedSize ?? internalSize;
  const paneController = useScreenPaneController({ screenId: 'analysis', workspaceDir, terminalSize, paneIds: ['analysis', 'momentum', 'levels'], defaultPanes: ['analysis'] });
  const coins = useMemo(() => getMarketSymbols(), []);
  const [indicators, setIndicators] = useState({
    momentum: [] as Indicator[],
    trend: [] as Indicator[],
    volatility: [] as Indicator[],
    volume: [] as Indicator[],
    levels: [] as Indicator[],
  });
  const [overallSignal, setOverallSignal] = useState({
    signal: 'neutral' as 'bullish' | 'bearish' | 'neutral',
    bullish: 0,
    bearish: 0,
    neutral: 0,
    confidence: 0,
  });
  const [loading, setLoading] = useState(true);
  const [loadingOverall, setLoadingOverall] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date());
  const [currentPrice, setCurrentPrice] = useState(0);
  const [coinIndex, setCoinIndex] = useState(0);
  const [timeframeIndex, setTimeframeIndex] = useState(0);
  const [showSection, setShowSection] = useState<
    'all' | 'momentum' | 'trend' | 'volume' | 'levels'
  >('all');

  useEffect(() => {
    if (!selectedMarketSymbol) return;
    const nextIndex = coins.indexOf(selectedMarketSymbol);
    if (nextIndex >= 0) setCoinIndex(nextIndex);
  }, [selectedMarketSymbol, coins]);

  const coin = coins[coinIndex] ?? coins[0] ?? '';
  const timeframe = TIMEFRAMES[timeframeIndex];
  const wsManager = getWebSocketManager();

  useInput((input, key) => {
    if (key.leftArrow || input === '<' || input === ',') {
      setCoinIndex((prev) => { const next = (prev - 1 + coins.length) % coins.length; onSelectedMarketSymbolChange?.(coins[next] ?? ''); return next; });
    } else if (key.rightArrow || input === '>' || input === '.') {
      setCoinIndex((prev) => { const next = (prev + 1) % coins.length; onSelectedMarketSymbolChange?.(coins[next] ?? ''); return next; });
    } else if (input === '1') {
      setTimeframeIndex(0); // 1h
    } else if (input === '2') {
      setTimeframeIndex(1); // 4h
    } else if (input === '3') {
      setTimeframeIndex(2); // 1D
    } else if (input === '4') {
      setTimeframeIndex(3); // 1W
    } else if (input === 'm') {
      setShowSection('momentum');
    } else if (input === 't') {
      setShowSection('trend');
    } else if (input === 'v') {
      setShowSection('volume');
    } else if (input === 'l') {
      setShowSection('levels');
    } else if (input === 'a') {
      setShowSection('all');
    }
  }, { isActive: paneController.isInputActive('analysis') });

  useEffect(() => {
    if (usesDynaMindMarketData()) return;
    initializeWebSocket();
    return () => {
      // Only remove our own listener, not all aggregated listeners on the shared singleton
      wsManager.removeListener('aggregated', handleAggregatedUpdate);
    };
  }, [coin, timeframe]);

  useEffect(() => {
    fetchAnalysis();
    const interval = setInterval(fetchAnalysis, usesDynaMindMarketData() ? 5 * 60_000 : 30000);
    return () => clearInterval(interval);
  }, [coin, timeframe]);

  useEffect(() => {
    // Check if we have valid overall signal data
    if (overallSignal && overallSignal.confidence > 0) {
      setLoadingOverall(false);
    }
  }, [overallSignal]);

  async function initializeWebSocket() {
    try {
      wsManager.on('aggregated', handleAggregatedUpdate);
      if (!wsManager.isConnected()) {
        await wsManager.connect([coin.toLowerCase() as any]);
      }
      wsManager.subscribe([coin], ['ticker']);
    } catch (err) {
      console.error('WebSocket error:', err);
    }
  }

  const handleAggregatedUpdate = useCallback(
    (data: AggregatedMarket) => {
      if (data.symbol === coin) {
        setCurrentPrice(data.weightedAvgPrice);
      }
    },
    [coin]
  );

  async function fetchAnalysis() {
    try {
      setLoading(true);
      setLoadingOverall(true);

      // Fetch klines from the configured market data provider (works for all timeframes)
      let candles: OHLCV[];
      if (usesDynaMindMarketData()) {
        const snapshot = await getDynaMindOHLCV(coin, timeframe.interval, timeframe.candles);
        candles = snapshot.map((candle) => ({ ...candle }));
      } else {
        const klineUrl = buildMarketUrl(getMarketKlinesPath(), {
          symbol: `${coin}USDT`, interval: timeframe.interval, limit: timeframe.candles,
        });
        const response = await fetch(klineUrl, { signal: AbortSignal.timeout(5_000) });
        if (!response.ok) throw new Error(`Market data API error: ${response.status} ${response.statusText}`);
        const klines = (await response.json()) as unknown[][];
        candles = klines.map((k) => ({
          open: parseFloat(k[1] as string), high: parseFloat(k[2] as string),
          low: parseFloat(k[3] as string), close: parseFloat(k[4] as string),
          volume: parseFloat(k[5] as string), timestamp: parseInt(k[0] as string),
        }));
      }
      if (candles.length === 0) throw new Error('No data returned for this symbol/timeframe');

      const price = candles[candles.length - 1]?.close || 0;
      setCurrentPrice(price);

      // Calculate all indicators
      const results = calculateAllIndicators(candles, price);

      setIndicators({
        momentum: results.momentum,
        trend: results.trend,
        volatility: results.volatility,
        volume: results.volume,
        levels: results.levels,
      });

      setOverallSignal(results.overall);
      setLastUpdate(new Date());
      setLoading(false);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch analysis');
      setLoading(false);
      setLoadingOverall(false);
    }
  }

  const overallColor =
    overallSignal?.signal === 'bullish'
      ? 'green'
      : overallSignal?.signal === 'bearish'
        ? 'red'
        : 'yellow';

  const allIndicators = [
    ...indicators.momentum,
    ...indicators.trend,
    ...indicators.volatility,
    ...indicators.volume,
    ...indicators.levels,
  ].filter(() => showSection === 'all' || true); // Filter by section if needed

  const mainPane = (
    <Box flexDirection="column" padding={1}>
      {error && <Text color="red">Analysis data unavailable: {error}</Text>}
      {/* Header */}
      <Box marginBottom={1}>
        <Text color="cyan" bold>
          ANALYSIS [F6]
        </Text>
        <Text dimColor> </Text>
        <Text color="yellow" bold>
          {coin}
        </Text>
        <Text dimColor> | </Text>
        <Text color="white" bold>
          ${currentPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}
        </Text>
        <Text dimColor> | Live | {lastUpdate.toLocaleTimeString()}</Text>
      </Box>

      {/* Timeframe and Section Selector */}
      <Box marginBottom={1}>
        <Text dimColor>Timeframe: </Text>
        {TIMEFRAMES.map((tf, i) => (
          <Text key={tf.value}>
            <Text color={i === timeframeIndex ? 'cyan' : 'white'} bold={i === timeframeIndex}>
              {tf.label}
            </Text>
            <Text dimColor>{i < TIMEFRAMES.length - 1 ? ' ' : ''}</Text>
          </Text>
        ))}
        <Text dimColor> | Section: </Text>
        <Text color="yellow" bold>
          {showSection === 'all' ? 'ALL' : showSection.toUpperCase()}
        </Text>
      </Box>

      {/* Overall Signal with Confidence */}
      <Box marginBottom={1}>
        <Text>Overall Signal: </Text>
        <Text color={overallColor} bold>
          {(overallSignal?.signal || 'neutral')?.toUpperCase()}
        </Text>
        <Text dimColor> ({(overallSignal?.confidence || 0).toFixed(0)}% confidence)</Text>
        <Text dimColor> | </Text>
        <Text color="green">{overallSignal?.bullish || 0}</Text>
        <Text dimColor>/</Text>
        <Text color="red">{overallSignal?.bearish || 0}</Text>
        <Text dimColor>/</Text>
        <Text color="yellow">{overallSignal?.neutral || 0}</Text>
      </Box>

      {/* Momentum Indicators */}
      {(showSection === 'all' || showSection === 'momentum') && (
        <>
          <Box marginBottom={1}>
            <Text color="magenta" bold>
              MOMENTUM
            </Text>
          </Box>
          <Box>
            <Box width={14}>
              <Text bold>Indicator</Text>
            </Box>
            <Box width={12}>
              <Text bold>Value</Text>
            </Box>
            <Box width={10}>
              <Text bold>Signal</Text>
            </Box>
            <Box width={20}>
              <Text bold>Description</Text>
            </Box>
          </Box>
          <Box marginBottom={1}>
            <Text dimColor>{'─'.repeat(56)}</Text>
          </Box>
          {indicators.momentum.map((ind) => (
            <Box key={ind.name}>
              <Box width={14}>
                <Text color="white">{ind.name}</Text>
              </Box>
              <Box width={12}>
                <Text color="white" bold>
                  {ind.value}
                </Text>
              </Box>
              <Box width={10}>
                <Text
                  color={
                    ind?.signal === 'bullish'
                      ? 'green'
                      : ind?.signal === 'bearish'
                        ? 'red'
                        : 'yellow'
                  }
                >
                  {ind?.signal?.toUpperCase() || 'NEUTRAL'}
                </Text>
              </Box>
              <Box width={20}>
                <Text dimColor>{ind.description || ''}</Text>
              </Box>
            </Box>
          ))}
          <Box marginBottom={1}></Box>
        </>
      )}

      {/* Trend Indicators */}
      {(showSection === 'all' || showSection === 'trend') && (
        <>
          <Box marginBottom={1}>
            <Text color="magenta" bold>
              TREND
            </Text>
          </Box>
          <Box>
            <Box width={14}>
              <Text bold>Indicator</Text>
            </Box>
            <Box width={12}>
              <Text bold>Value</Text>
            </Box>
            <Box width={10}>
              <Text bold>Signal</Text>
            </Box>
            <Box width={20}>
              <Text bold>Description</Text>
            </Box>
          </Box>
          <Box marginBottom={1}>
            <Text dimColor>{'─'.repeat(56)}</Text>
          </Box>
          {indicators.trend.map((ind) => (
            <Box key={ind.name}>
              <Box width={14}>
                <Text color="white">{ind.name}</Text>
              </Box>
              <Box width={12}>
                <Text color="white" bold>
                  {ind.value}
                </Text>
              </Box>
              <Box width={10}>
                <Text
                  color={
                    ind?.signal === 'bullish'
                      ? 'green'
                      : ind?.signal === 'bearish'
                        ? 'red'
                        : 'yellow'
                  }
                >
                  {ind?.signal?.toUpperCase() || 'NEUTRAL'}
                </Text>
              </Box>
              <Box width={20}>
                <Text dimColor>{ind.description || ''}</Text>
              </Box>
            </Box>
          ))}
          <Box marginBottom={1}></Box>
        </>
      )}

      {/* Volume Indicators */}
      {(showSection === 'all' || showSection === 'volume') && (
        <>
          <Box marginBottom={1}>
            <Text color="magenta" bold>
              VOLUME
            </Text>
          </Box>
          <Box>
            <Box width={14}>
              <Text bold>Indicator</Text>
            </Box>
            <Box width={12}>
              <Text bold>Value</Text>
            </Box>
            <Box width={10}>
              <Text bold>Signal</Text>
            </Box>
            <Box width={20}>
              <Text bold>Description</Text>
            </Box>
          </Box>
          <Box marginBottom={1}>
            <Text dimColor>{'─'.repeat(56)}</Text>
          </Box>
          {indicators.volume.map((ind) => (
            <Box key={ind.name}>
              <Box width={14}>
                <Text color="white">{ind.name}</Text>
              </Box>
              <Box width={12}>
                <Text color="white" bold>
                  {ind.value}
                </Text>
              </Box>
              <Box width={10}>
                <Text
                  color={
                    ind?.signal === 'bullish'
                      ? 'green'
                      : ind?.signal === 'bearish'
                        ? 'red'
                        : 'yellow'
                  }
                >
                  {ind?.signal?.toUpperCase() || 'NEUTRAL'}
                </Text>
              </Box>
              <Box width={20}>
                <Text dimColor>{ind.description || ''}</Text>
              </Box>
            </Box>
          ))}
          <Box marginBottom={1}></Box>
        </>
      )}

      {/* Levels */}
      {(showSection === 'all' || showSection === 'levels') && (
        <>
          <Box marginBottom={1}>
            <Text color="magenta" bold>
              LEVELS
            </Text>
          </Box>
          <Box>
            <Box width={14}>
              <Text bold>Indicator</Text>
            </Box>
            <Box width={12}>
              <Text bold>Value</Text>
            </Box>
            <Box width={10}>
              <Text bold>Signal</Text>
            </Box>
            <Box width={20}>
              <Text bold>Description</Text>
            </Box>
          </Box>
          <Box marginBottom={1}>
            <Text dimColor>{'─'.repeat(56)}</Text>
          </Box>
          {indicators.levels.map((ind) => (
            <Box key={ind.name}>
              <Box width={14}>
                <Text color="white">{ind.name}</Text>
              </Box>
              <Box width={12}>
                <Text color="white" bold>
                  {ind.value}
                </Text>
              </Box>
              <Box width={10}>
                <Text
                  color={
                    ind?.signal === 'bullish'
                      ? 'green'
                      : ind?.signal === 'bearish'
                        ? 'red'
                        : 'yellow'
                  }
                >
                  {ind?.signal?.toUpperCase() || 'NEUTRAL'}
                </Text>
              </Box>
              <Box width={20}>
                <Text dimColor>{ind.description || ''}</Text>
              </Box>
            </Box>
          ))}
        </>
      )}

      {/* Footer */}
      <Box marginTop={1}>
        <Text dimColor>{'─'.repeat(56)}</Text>
      </Box>
      <Box flexDirection="column">
        <Box>
          <Text dimColor>Coins: </Text>
          {coins.map((c, i) => (
            <Text key={c}>
              <Text color={i === coinIndex ? 'cyan' : 'white'} bold={i === coinIndex}>
                {c}
              </Text>
              <Text dimColor>{i < coins.length - 1 ? ' ' : ''}</Text>
            </Text>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Controls: </Text>
          <Text color="yellow">Left/Right</Text>
          <Text dimColor> coin | </Text>
          <Text color="yellow">1-4</Text>
          <Text dimColor> timeframe | </Text>
          <Text color="yellow">M/T/V/L</Text>
          <Text dimColor> sections | </Text>
          <Text color="yellow">A</Text>
          <Text dimColor> all | </Text>
          <Text color="yellow">Esc</Text>
          <Text dimColor> return</Text>
        </Box>
      </Box>
    </Box>
  );

  const signalColor = overallSignal.signal === 'bullish' ? 'green' : overallSignal.signal === 'bearish' ? 'red' : 'yellow';
  const indicatorReadout = [...indicators.momentum, ...indicators.trend, ...indicators.volatility, ...indicators.volume, ...indicators.levels]
    .slice(0, 8);
  const signalPane = (
    <Box flexDirection="column" paddingX={1}>
      <Text dimColor>{coin} · {timeframe.value} · refreshed {lastUpdate.toLocaleTimeString()}</Text>
      <Text dimColor> </Text>
      <Text color={signalColor} bold>{overallSignal.signal.toUpperCase()} · {overallSignal.confidence.toFixed(0)}% confidence</Text>
      <Text><Text color="green">{overallSignal.bullish} bullish</Text><Text dimColor> · </Text><Text color="red">{overallSignal.bearish} bearish</Text><Text dimColor> · {overallSignal.neutral} neutral</Text></Text>
      {currentPrice > 0 && <Text color="white">${currentPrice.toLocaleString(undefined, { maximumFractionDigits: 4 })}</Text>}
      <Text dimColor> </Text>
      <Text color="yellow" bold>INDICATOR READOUT</Text>
      {indicatorReadout.length ? indicatorReadout.map((indicator) => (
        <Box key={indicator.name} justifyContent="space-between">
          <Text>{indicator.name}</Text>
          <Text color={indicator.signal === 'bullish' ? 'green' : indicator.signal === 'bearish' ? 'red' : 'yellow'}>{String(indicator.value)} · {indicator.signal}</Text>
        </Box>
      )) : <Text dimColor>{loading ? 'Calculating technical indicators…' : 'No indicator values available.'}</Text>}
      {error && <Text color="red">{error}</Text>}
    </Box>
  );

  return (
    <ScreenPaneWorkspace
      controller={paneController}
      terminalSize={terminalSize}
      panes={[
        { id: 'analysis', title: `ANALYSIS · ${coin}`, content: mainPane },
        { id: 'signals', title: 'SIGNAL & INDICATORS', content: signalPane },
      ]}
    />
  );
}

export default AnalysisScreen;

