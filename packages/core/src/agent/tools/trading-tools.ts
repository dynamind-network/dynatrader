import { randomUUID } from 'node:crypto';
import { PaperEngine } from '../../market/backtest/paper-engine';
import type { Candle, MarketDataProvider } from '../../plugins/types';
import { ExecutionRouterImpl } from '../../runtime/execution/execution-router';
import { positionNotionalPct } from '../../runtime/execution/risk-snapshot';
import type { ApprovalToken, ExchangeAdapter, OrderIntent, ToolCall, ToolHandler, ToolResult } from '../../types';
import { consumeLiveOrderApproval } from '../core/live-order-approval';

export interface TradingRiskLimits {
  /** Maximum planned loss at stop as a fraction of account equity. */
  maxPositionPct: number;
  /** Stop new orders after this fraction of equity is lost during the UTC day. */
  maxDailyLossPct: number;
  maxConcurrentPositions: number;
}

interface TradeProposal {
  id: string;
  intent: OrderIntent;
  stopLoss: number;
  takeProfit: number;
  evidence: { venue: string; timeframe: string; fetchedAt: string; asOf: string; stalenessMs: number };
  createdAt: number;
}

export interface TradingToolsOptions {
  exchange: ExchangeAdapter;
  marketDataProvider?: MarketDataProvider;
  marketDataSource?: string;
  paperEngine: PaperEngine;
  executionRouter: ExecutionRouterImpl;
  defaultMode: 'paper' | 'live' | 'backtest' | 'research';
  getRiskLimits: () => TradingRiskLimits | undefined;
  getEquity?: (mode: 'paper' | 'live') => Promise<number | undefined>;
}

function result(data: unknown, started: number): ToolResult {
  return { success: true, data, durationMs: Date.now() - started, truncated: false };
}

function failure(error: unknown, started: number): ToolResult {
  return { success: false, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started, truncated: false };
}

function timeframeMs(timeframe: string): number {
  const match = timeframe.match(/^(\d+)(m|h|d)$/);
  if (!match) throw new Error(`Unsupported timeframe: ${timeframe}`);
  return Number(match[1]) * ({ m: 60_000, h: 3_600_000, d: 86_400_000 } as const)[match[2] as 'm' | 'h' | 'd'];
}

function readLimits(getLimits: TradingToolsOptions['getRiskLimits']): TradingRiskLimits {
  const limits = getLimits();
  if (!limits) throw new Error('Trading is disabled until maxPositionPct, maxDailyLossPct, and maxConcurrentPositions are configured in workspace/config.yaml.');
  if (!(limits.maxPositionPct > 0 && limits.maxPositionPct <= 1) || !(limits.maxDailyLossPct > 0 && limits.maxDailyLossPct <= 1) || !Number.isInteger(limits.maxConcurrentPositions) || limits.maxConcurrentPositions < 1) {
    throw new Error('Trading risk configuration is invalid. Percent limits must be in (0, 1] and maxConcurrentPositions must be a positive integer.');
  }
  return limits;
}

export function createTradingTools(options: TradingToolsOptions): ToolHandler[] {
  const proposals = new Map<string, TradeProposal>();
  const shared = new Map<string, { symbol: string; timeframe: string; candles: Array<[number, number, number, number, number, number]>; fetchedAt: string }>();
  const marketDataSource = options.marketDataSource ?? (options.marketDataProvider ? 'configured market-data provider' : options.exchange.id);
  const fetchCandles = async (symbol: string, timeframe: string, limit: number): Promise<Array<[number, number, number, number, number, number]>> => {
    if (!options.marketDataProvider) return options.exchange.fetchOHLCV({ symbol, timeframe, limit });
    const candles: Candle[] = await options.marketDataProvider.getOHLCV(symbol, timeframe, limit);
    return candles.map(({ timestamp, open, high, low, close, volume }) => [timestamp, open, high, low, close, volume]);
  };
  const fetchUniverse = async (): Promise<Array<{ symbol: string }>> => {
    if (options.marketDataProvider) return (await options.marketDataProvider.fetchUniverse()).map((symbol) => ({ symbol }));
    const catalogue = await options.exchange.fetchMarkets();
    const markets = Array.isArray(catalogue.markets) ? catalogue.markets : Array.isArray(catalogue) ? catalogue : [];
    return markets.flatMap((market) => market && typeof market === 'object' && typeof (market as Record<string, unknown>).symbol === 'string'
      ? [{ symbol: String((market as Record<string, unknown>).symbol) }]
      : []);
  };
  const isProviderAccessError = (error: unknown): boolean => /(?:rate limit|quota|unauthori[sz]ed|api key|payment required|plan limit|upgrade)/i
    .test(error instanceof Error ? error.message : String(error));

  const handlers: ToolHandler[] = [
    {
      definition: {
        name: 'indicators', description: 'Calculate SMA, RSI, and ATR from current exchange OHLCV. Returns source venue, candle time, and freshness.', category: 'analysis',
        inputSchema: { symbol: 'string', timeframe: 'string', period: 'number?' }, outputSchema: { indicators: 'object' }, permissionsRequired: ['tool.market_data'], sideEffects: [], riskLevel: 'low', timeoutMs: 30_000, readOnly: true, canRunInParallel: true,
      },
      execute: async (call) => {
        const started = Date.now();
        try {
          const symbol = String(call.args.symbol ?? '').trim();
          const timeframe = String(call.args.timeframe ?? '').trim();
          const period = Math.max(2, Math.min(100, Number(call.args.period) || 14));
          if (!symbol || !timeframe) throw new Error('symbol and timeframe are required.');
          const candles = await fetchCandles(symbol, timeframe, Math.max(100, period * 3));
          if (candles.length < period + 2) throw new Error(`Only ${candles.length} candles returned; at least ${period + 2} are required.`);
          const now = new Date();
          const last = candles[candles.length - 1]!;
          const data = candles.map(([timestamp, open, high, low, close, volume]) => ({ timestamp, open, high, low, close, volume }));
          const { TechnicalIndicators } = await import('../../market/indicators/indicators');
          const [sma, rsi, atr] = await Promise.all([
            TechnicalIndicators.SMA({ period }, data),
            TechnicalIndicators.RSI({ period }, data),
            TechnicalIndicators.ATR({ period }, data),
          ]);
          const evidence = { venue: options.exchange.id, source: marketDataSource, symbol, timeframe, fetchedAt: now.toISOString(), asOf: new Date(last[0]).toISOString(), stalenessMs: now.getTime() - last[0] };
          shared.set(`${symbol}:${timeframe}`, { symbol, timeframe, candles, fetchedAt: evidence.fetchedAt });
          return result({ evidence, latest: { close: last[4], sma: sma.at(-1)?.value, rsi: rsi.at(-1)?.value, atr: atr.at(-1)?.value }, series: { sma: sma.slice(-20), rsi: rsi.slice(-20), atr: atr.slice(-20) } }, started);
        } catch (error) { return failure(error, started); }
      },
    },
    {
      definition: {
        name: 'scan_market', description: 'Discover and rank active exchange markets using fetched OHLCV and deterministic trend/volatility evidence. Ranking is a research aid, never an order.', category: 'market',
        inputSchema: { timeframe: 'string', limit: 'number?' }, outputSchema: { candidates: 'array' }, permissionsRequired: ['tool.market_data'], sideEffects: [], riskLevel: 'low', timeoutMs: 120_000, readOnly: true, canRunInParallel: false,
      },
      execute: async (call) => {
        const started = Date.now();
        try {
          const timeframe = String(call.args.timeframe ?? '').trim();
          if (!timeframe) throw new Error('timeframe is required.');
          timeframeMs(timeframe);
          const limit = Math.max(1, Math.min(20, Number(call.args.limit) || 10));
          const markets = await fetchUniverse();
          const candidates: Array<Record<string, unknown>> = [];
          for (const market of markets.slice(0, limit * 3)) {
            const symbol = market && typeof market === 'object' ? String((market as Record<string, unknown>).symbol ?? '') : '';
            if (!symbol) continue;
            try {
              const candles = await fetchCandles(symbol, timeframe, 60);
              if (candles.length < 30) continue;
              const latest = candles[candles.length - 1]!;
              const closes = candles.map((candle) => candle[4]);
              const fast = closes.slice(-10).reduce((sum, value) => sum + value, 0) / 10;
              const slow = closes.slice(-30).reduce((sum, value) => sum + value, 0) / 30;
              const change = (latest[4] - closes[closes.length - 10]!) / closes[closes.length - 10]!;
              const fetchedAt = new Date().toISOString();
              const evidence = { venue: options.exchange.id, source: marketDataSource, symbol, timeframe, fetchedAt, asOf: new Date(latest[0]).toISOString(), stalenessMs: Date.now() - latest[0] };
              shared.set(`${symbol}:${timeframe}`, { symbol, timeframe, candles, fetchedAt });
              candidates.push({ symbol, price: latest[4], trend: fast >= slow ? 'up' : 'down', changePct: change * 100, score: Math.abs(change) + Math.abs((fast - slow) / latest[4]), evidence });
            } catch (error) {
              if (isProviderAccessError(error)) throw error;
              // Keep scanning other markets; report only successful evidence.
            }
          }
          candidates.sort((a, b) => Number(b.score) - Number(a.score));
          return result({ venue: options.exchange.id, source: marketDataSource, timeframe, fetchedAt: new Date().toISOString(), candidates: candidates.slice(0, limit) }, started);
        } catch (error) { return failure(error, started); }
      },
    },
    {
      definition: {
        name: 'size_position', description: 'Calculate a cash-only quantity from account equity, entry, stop, and configured maximum loss per position.', category: 'analysis',
        inputSchema: { entry: 'number', stopLoss: 'number', equity: 'number' }, outputSchema: { quantity: 'number', riskAmount: 'number' }, permissionsRequired: ['tool.market_data'], sideEffects: [], riskLevel: 'low', timeoutMs: 5_000, readOnly: true,
      },
      execute: async (call) => {
        const started = Date.now();
        try {
          const limits = readLimits(options.getRiskLimits);
          const entry = Number(call.args.entry); const stopLoss = Number(call.args.stopLoss); const equity = Number(call.args.equity);
          if (!(entry > 0 && stopLoss > 0 && equity > 0) || entry === stopLoss) throw new Error('entry, stopLoss, and equity must be positive, with stopLoss different from entry.');
          const riskAmount = equity * limits.maxPositionPct;
          const riskQuantity = riskAmount / Math.abs(entry - stopLoss);
          const cashQuantity = equity / entry;
          const quantity = Math.min(riskQuantity, cashQuantity);
          return result({ quantity, notional: quantity * entry, riskAmount: quantity * Math.abs(entry - stopLoss), riskCap: riskAmount, riskPct: quantity * Math.abs(entry - stopLoss) / equity }, started);
        } catch (error) { return failure(error, started); }
      },
    },
    {
      definition: {
        name: 'backtest', description: 'Backtest a deterministic moving-average crossover on historical exchange data using the paper engine fill model.', category: 'analysis',
        inputSchema: { symbol: 'string', timeframe: 'string', fastPeriod: 'number?', slowPeriod: 'number?', initialBalance: 'number?' }, outputSchema: { summary: 'object', trades: 'array' }, permissionsRequired: ['tool.market_data'], sideEffects: ['runs_backtest'], riskLevel: 'low', timeoutMs: 120_000, readOnly: true,
      },
      execute: async (call) => {
        const started = Date.now();
        try {
          const symbol = String(call.args.symbol ?? '').trim(); const timeframe = String(call.args.timeframe ?? '').trim();
          const fastPeriod = Math.max(2, Math.min(50, Number(call.args.fastPeriod) || 10));
          const slowPeriod = Math.max(fastPeriod + 1, Math.min(200, Number(call.args.slowPeriod) || 30));
          if (!symbol || !timeframe) throw new Error('symbol and timeframe are required.');
          const candles = await fetchCandles(symbol, timeframe, 500);
          if (candles.length < slowPeriod + 3) throw new Error(`Backtest requires at least ${slowPeriod + 3} candles.`);
          const engine = new PaperEngine({ initialBalance: Number(call.args.initialBalance) > 0 ? Number(call.args.initialBalance) : 10_000, commissionRate: 0.001, slippageRate: 0.001, feeCurrency: 'USD' }, options.exchange);
          const rows = candles.map(([timestamp, open, high, low, close, volume]) => ({ timestamp, open, high, low, close, volume }));
          await engine.initialize(symbol, rows, new Date(candles[0]![0]), new Date(candles[candles.length - 1]![0]));
          const closes = rows.map((row) => row.close);
          let held = false;
          for (let index = 0; index < rows.length; index++) {
            await engine.step(symbol);
            if (index < slowPeriod) continue;
            const fast = closes.slice(index - fastPeriod + 1, index + 1).reduce((sum, value) => sum + value, 0) / fastPeriod;
            const slow = closes.slice(index - slowPeriod + 1, index + 1).reduce((sum, value) => sum + value, 0) / slowPeriod;
            const previousFast = closes.slice(index - fastPeriod, index).reduce((sum, value) => sum + value, 0) / fastPeriod;
            const previousSlow = closes.slice(index - slowPeriod, index).reduce((sum, value) => sum + value, 0) / slowPeriod;
            const portfolio = engine.getPortfolio();
            if (!held && previousFast <= previousSlow && fast > slow) {
              const quantity = Math.max(0, portfolio.balance / closes[index]! * 0.95);
              if (quantity > 0) { await engine.placeOrder({ venue: options.exchange.id, symbol, side: 'buy', type: 'market', quantity, price: closes[index], strategyId: `sma-${fastPeriod}-${slowPeriod}`, mode: 'backtest' }); held = true; }
            } else if (held && previousFast >= previousSlow && fast < slow) {
              const position = portfolio.positions.find((item) => item.symbol === symbol);
              if (position && position.quantity > 0) await engine.placeOrder({ venue: options.exchange.id, symbol, side: 'sell', type: 'market', quantity: position.quantity, price: closes[index], strategyId: `sma-${fastPeriod}-${slowPeriod}`, mode: 'backtest' });
              held = false;
            }
          }
          const backtest = engine.getResult(`sma-${fastPeriod}-${slowPeriod}`, timeframe);
          const fetchedAt = new Date().toISOString();
          return result({ evidence: { venue: options.exchange.id, source: marketDataSource, symbol, timeframe, fetchedAt, asOf: new Date(candles[candles.length - 1]![0]).toISOString(), candleCount: candles.length, fillModel: { commissionRate: 0.001, slippageRate: 0.001 } }, summary: backtest.summary, trades: backtest.trades, equityCurve: backtest.equityCurve }, started);
        } catch (error) { return failure(error, started); }
      },
    },
    {
      definition: {
        name: 'propose_order', description: 'Create an expiring, evidence-linked paper/live order proposal. It does not execute; the agent must call execute_order with this proposal.', category: 'execution',
        inputSchema: { symbol: 'string', timeframe: 'string', side: 'string', quantity: 'number', stopLoss: 'number', takeProfit: 'number', thesis: 'string', invalidation: 'string', mode: 'string?' }, outputSchema: { proposalId: 'string', intent: 'object', evidence: 'object' }, permissionsRequired: ['trading.propose'], sideEffects: ['creates_order_proposal'], riskLevel: 'low', timeoutMs: 30_000,
      },
      execute: async (call) => {
        const started = Date.now();
        try {
          const limits = readLimits(options.getRiskLimits);
          const symbol = String(call.args.symbol ?? '').trim(); const timeframe = String(call.args.timeframe ?? '').trim();
          const side = String(call.args.side ?? '').toLowerCase(); const quantity = Number(call.args.quantity);
          const stopLoss = Number(call.args.stopLoss); const takeProfit = Number(call.args.takeProfit);
          const thesis = String(call.args.thesis ?? '').trim(); const invalidation = String(call.args.invalidation ?? '').trim();
          const mode = String(call.args.mode ?? options.defaultMode) as OrderIntent['mode'];
          if (!symbol || !timeframe || !['buy', 'sell'].includes(side) || !(quantity > 0)) throw new Error('symbol, timeframe, valid side, and positive quantity are required.');
          if (!['paper', 'live'].includes(mode)) throw new Error('Order proposals support only paper or live mode.');
          const tradableMode = mode as 'paper' | 'live';
          if (!(stopLoss > 0 && takeProfit > 0)) throw new Error('Every proposal requires a positive stop loss and take profit.');
          if (!thesis || !invalidation) throw new Error('Every order needs an evidence-based thesis and a clear invalidation condition.');
          const candles = await fetchCandles(symbol, timeframe, 3);
          if (candles.length === 0) throw new Error(`No price data returned for ${symbol}.`);
          const now = Date.now(); const last = candles[candles.length - 1]!;
          const stalenessMs = now - last[0];
          if (stalenessMs > timeframeMs(timeframe) * 2) throw new Error(`Market data for ${symbol} is stale (${stalenessMs} ms).`);
          const entry = last[4];
          if ((side === 'buy' && !(stopLoss < entry && takeProfit > entry)) || (side === 'sell' && !(takeProfit < entry && stopLoss > entry))) throw new Error('Stop loss and take profit must be on the correct sides of entry.');
          const equity = await options.getEquity?.(tradableMode);
          if (!(equity && equity > 0)) throw new Error(`Cannot calculate risk without a valid ${mode} account equity snapshot.`);
          const positionPct = positionNotionalPct(quantity, entry, equity);
          if (positionPct > limits.maxPositionPct) throw new Error(`Proposed position size ${(positionPct * 100).toFixed(3)}% exceeds configured maxPositionPct ${(limits.maxPositionPct * 100).toFixed(3)}%.`);
          const evidence = { venue: options.exchange.id, source: marketDataSource, timeframe, fetchedAt: new Date(now).toISOString(), asOf: new Date(last[0]).toISOString(), stalenessMs };
          const intent: OrderIntent = { venue: options.exchange.id, symbol, side: side as 'buy' | 'sell', type: 'market', quantity, price: entry, strategyId: `agent-${randomUUID()}`, mode, stopLoss, takeProfit, thesis, invalidation, marketEvidence: evidence };
          const proposal: TradeProposal = { id: randomUUID(), intent, stopLoss, takeProfit, evidence, createdAt: now };
          proposals.set(proposal.id, proposal);
          return result({ proposalId: proposal.id, intent, stopLoss, takeProfit, maxDailyLossPct: limits.maxDailyLossPct, maxConcurrentPositions: limits.maxConcurrentPositions, evidence, expiresAt: new Date(now + 5 * 60_000).toISOString(), status: 'proposed' }, started);
        } catch (error) { return failure(error, started); }
      },
    },
    {
      definition: {
        name: 'execute_order', description: 'Execute a previously validated order proposal through DynaTrader ExecutionRouter. Paper execution is autonomous inside the configured risk policy; live execution requires an interactive approval and a fresh supported-exchange risk snapshot.', category: 'execution',
        inputSchema: { proposalId: 'string', venue: 'string', symbol: 'string', side: 'string', quantity: 'number', price: 'number', stopLoss: 'number', takeProfit: 'number', thesis: 'string', invalidation: 'string', mode: 'string' }, outputSchema: { execution: 'object' }, permissionsRequired: ['trading.execute'], sideEffects: ['executes_trade'], riskLevel: 'high', timeoutMs: 60_000,
      },
      execute: async (call: ToolCall) => {
        const started = Date.now();
        try {
          const limits = readLimits(options.getRiskLimits);
          const proposalId = String(call.args.proposalId ?? ''); const proposal = proposals.get(proposalId);
          if (!proposal) throw new Error('Order proposal is missing or expired. Create a fresh proposal with current market evidence.');
          if (Date.now() - proposal.createdAt > 5 * 60_000) { proposals.delete(proposalId); throw new Error('Order proposal expired.'); }
          if (call.args.venue !== proposal.intent.venue || call.args.symbol !== proposal.intent.symbol || call.args.side !== proposal.intent.side
            || Number(call.args.quantity) !== proposal.intent.quantity || Number(call.args.price) !== proposal.intent.price
            || Number(call.args.stopLoss) !== proposal.stopLoss || Number(call.args.takeProfit) !== proposal.takeProfit
            || call.args.thesis !== proposal.intent.thesis || call.args.invalidation !== proposal.intent.invalidation
            || call.args.mode !== proposal.intent.mode) throw new Error('Execution arguments do not match the approved proposal.');
          if (proposal.intent.mode === 'live') {
            const token = consumeLiveOrderApproval(call);
            if (!token) throw new Error('Live order is missing its one-shot interactive approval.');
            const execution = await options.executionRouter.execute(proposal.intent, 'live', token);
            proposals.delete(proposalId);
            return result({ execution, proposal }, started);
          }
          const candles = await fetchCandles(proposal.intent.symbol, proposal.evidence.timeframe, 120);
          if (candles.length < 2) throw new Error('Fresh paper execution candles are unavailable.');
          const latest = candles[candles.length - 1]!;
          if (Date.now() - latest[0] > timeframeMs(proposal.evidence.timeframe) * 2) throw new Error('Market data became stale before execution.');
          await options.paperEngine.refreshPaperMarketData(proposal.intent.symbol, candles.map(([timestamp, open, high, low, close, volume]) => ({ timestamp, open, high, low, close, volume })), options.exchange.id);
          const portfolio = options.paperEngine.getPortfolio();
          if (!(portfolio.equity > 0)) throw new Error('Paper portfolio equity is unavailable.');
          const dailyLossPct = Math.max(0, -portfolio.dailyPnL / portfolio.equity);
          if (dailyLossPct >= limits.maxDailyLossPct) throw new Error(`Daily loss limit reached (${(dailyLossPct * 100).toFixed(2)}%).`);
          const existing = portfolio.positions.find((position) => position.symbol === proposal.intent.symbol);
          const openCount = portfolio.positions.filter((position) => position.quantity > 0).length;
          if (!existing && proposal.intent.side === 'buy' && openCount >= limits.maxConcurrentPositions) throw new Error('Maximum concurrent positions reached.');
          const actualEntry = latest[4];
          const actualPositionPct = positionNotionalPct(proposal.intent.quantity, actualEntry, portfolio.equity);
          if (actualPositionPct > limits.maxPositionPct) throw new Error(`Price moved; current position size ${(actualPositionPct * 100).toFixed(3)}% exceeds the configured cap.`);
          const intent = { ...proposal.intent, price: actualEntry };
          const execution = await options.executionRouter.execute(intent, 'paper');
          proposals.delete(proposalId);
          return result({ execution, proposal: { ...proposal, intent, executionEvidence: { ...proposal.evidence, asOf: new Date(latest[0]).toISOString(), fetchedAt: new Date().toISOString() } } }, started);
        } catch (error) { return failure(error, started); }
      },
    },
  ];

  return handlers;
}
