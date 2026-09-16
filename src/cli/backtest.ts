/**
 * CLI Command: backtest
 *
 * Runs historical execution through the real PaperEngine + ExecutionRouter stack.
 */

import { join } from "node:path";

import type { DynaTraderRuntime } from "@dyna/orchestration/workspace";
import type { ExchangeAdapter, OrderIntent } from "@dyna/contracts";
import { createExchangeAdapter } from "../market/exchange/exchange-factory";
import { RunCardManager } from "../governance/run-cards";
import {
  bold,
  cyan,
  green,
  red,
  yellow,
  dim,
  formatCurrency,
  formatPercent,
  formatDate,
  printSeparator,
} from "./utils";

export interface BacktestCommandOptions {
  symbol: string;
  timeframe: string;
  days: number;
  start?: string;
  end?: string;
  venues?: string[];
}

interface VenueBacktestReport {
  venue: string;
  result: VenueBacktestResult;
  candles: number;
}

type VenueBacktestResult = Awaited<
  ReturnType<ReturnType<typeof createVenueBacktestRunner>>
>;

interface BacktestRunArtifact {
  venue: string;
  candles: number;
  trades: VenueBacktestResult["trades"];
  equityCurve: VenueBacktestResult["equityCurve"];
  drawdownCurve: VenueBacktestResult["drawdownCurve"];
  summary: VenueBacktestResult["summary"];
}

interface BacktestArtifactBundle {
  symbol: string;
  timeframe: string;
  days: number;
  window: { start: Date; end: Date };
  venues: string[];
  runs: BacktestRunArtifact[];
  aggregate?: Record<string, unknown>;
  tradeLog?: VenueBacktestResult["trades"];
  equityCurve?: Array<{ venue: string } & VenueBacktestResult["equityCurve"][number]>;
  drawdownCurve?: Array<{ venue: string } & VenueBacktestResult["drawdownCurve"][number]>;
}

export async function cmdBacktest(
  runtime: DynaTraderRuntime,
  options: BacktestCommandOptions,
): Promise<void> {
  const { symbol, timeframe, days } = options;
  const workspace = await runtime.loadWorkspace();
  const workspacePath = runtime.getStatus().workspacePath;
  const runCardManager = new RunCardManager(workspacePath);

  const venues = resolveVenueList(options.venues, runtime.getExchange().id);
  const window = resolveBacktestWindow(options.start, options.end, days);

  console.log();
  console.log(bold(cyan(`Running backtest: ${symbol} (${timeframe}, ${days} days)`)));
  console.log(dim(`Execution stack: PaperEngine + ExecutionRouter`));
  console.log(dim(`Window: ${formatDate(window.start)} -> ${formatDate(window.end)}`));
  console.log(dim(`Venues: ${venues.join(", ")}`));
  console.log();

  const runCard = await runCardManager.createRunCard({
    mode: "backtest",
    agentName: "cli-backtest",
  });
  await runCardManager.startRun(runCard.runId);

  const paperEngine = runtime.getPaperEngine();
  const executionRouter = runtime.getExecutionRouter();
  const reports: VenueBacktestReport[] = [];
  const artifactBundle: BacktestArtifactBundle = {
    symbol,
    timeframe,
    days,
    window,
    venues,
    runs: [],
  };

  try {
    for (const venue of venues) {
      console.log(dim(`Loading ${venue} historical data...`));
      const exchange = await resolveVenueExchange(venue, runtime, workspace);
      const candles = await fetchHistoricalCandles(exchange, symbol, timeframe, window.start.getTime(), window.end.getTime());

      if (candles.length === 0) {
        throw new Error(`No historical data returned for ${symbol} on ${venue}`);
      }

      console.log(`  Loaded ${candles.length} candles from ${venue}`);
      console.log(
        dim(
          `  From ${formatDate(new Date(candles[0]![0]))} to ${formatDate(new Date(candles[candles.length - 1]![0]))}`,
        ),
      );

      const runner = createVenueBacktestRunner({
        executionRouter,
        paperEngine,
        symbol,
        timeframe,
        venue,
      });

      const result = await runner(candles);
      reports.push({
        venue,
        result,
        candles: candles.length,
      });

      artifactBundle.runs.push({
        venue,
        candles: candles.length,
        trades: result.trades,
        equityCurve: result.equityCurve,
        drawdownCurve: result.drawdownCurve,
        summary: result.summary,
      });
    }

    const aggregate = aggregateReports(reports);
    artifactBundle["aggregate"] = aggregate;
    artifactBundle["tradeLog"] = reports.flatMap((report) => report.result.trades);
    artifactBundle["equityCurve"] = reports.flatMap((report) =>
      report.result.equityCurve.map((point) => ({
        venue: report.venue,
        ...point,
      })),
    );
    artifactBundle["drawdownCurve"] = reports.flatMap((report) =>
      report.result.drawdownCurve.map((point) => ({
        venue: report.venue,
        ...point,
      })),
    );

    const summaryArtifact = await runCardManager.addArtifact(runCard.runId, artifactBundle, "backtest-report");
    const tradesArtifact = await runCardManager.addArtifact(
      runCard.runId,
      artifactBundle.tradeLog,
      "trade-log",
    );
    const equityArtifact = await runCardManager.addArtifact(
      runCard.runId,
      artifactBundle.equityCurve,
      "equity-curve",
    );
    const drawdownArtifact = await runCardManager.addArtifact(
      runCard.runId,
      artifactBundle.drawdownCurve,
      "drawdown-curve",
    );

    const artifacts = [summaryArtifact, tradesArtifact, equityArtifact, drawdownArtifact];
    await runCardManager.completeRun(runCard.runId, {
      verdict: "hold",
      metrics: aggregate,
      artifacts,
      summary: `Backtest completed for ${symbol} across ${venues.length} venue(s)`,
    });

    printBacktestReport(symbol, timeframe, days, reports, aggregate);
    console.log(dim(`Artifacts persisted under ${join(workspacePath, "workspace", "runs")}`));
    console.log();
  } catch (error) {
    await runCardManager.rejectRun(
      runCard.runId,
      error instanceof Error ? error.message : String(error),
    );
    console.log();
    console.log(red(`Error: ${error instanceof Error ? error.message : String(error)}`));
    console.log();
    throw error;
  }
}

function resolveVenueList(venues: string[] | undefined, fallbackVenue: string): string[] {
  const values = (venues ?? [fallbackVenue])
    .map((venue) => venue.trim())
    .filter(Boolean);
  return values.length > 0 ? values : [fallbackVenue];
}

function resolveBacktestWindow(start?: string, end?: string, days = 30): { start: Date; end: Date } {
  const endDate = end ? new Date(end) : new Date();
  if (Number.isNaN(endDate.getTime())) {
    throw new Error(`Invalid end date: ${end}`);
  }

  const startDate = start
    ? new Date(start)
    : new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
  if (Number.isNaN(startDate.getTime())) {
    throw new Error(`Invalid start date: ${start}`);
  }

  if (startDate >= endDate) {
    throw new Error("Backtest start date must be earlier than end date");
  }

  return { start: startDate, end: endDate };
}

async function resolveVenueExchange(
  venue: string,
  runtime: DynaTraderRuntime,
  workspace: Awaited<ReturnType<DynaTraderRuntime["loadWorkspace"]>>,
): Promise<ExchangeAdapter> {
  const runtimeExchange = runtime.getExchange();
  if (runtimeExchange.id === venue) {
    return runtimeExchange;
  }

  const authConfig = workspace.auth as Record<string, unknown> | undefined;
  const exchange = createExchangeAdapter({ mode: "backtest", exchangeId: venue, auth: authConfig });
  if (!exchange) throw new Error(`Unable to create exchange adapter for ${venue}`);
  return exchange;
}

async function fetchHistoricalCandles(
  exchange: ExchangeAdapter,
  symbol: string,
  timeframe: string,
  since: number,
  until: number,
): Promise<Array<[number, number, number, number, number, number]>> {
  const limit = estimateCandlesLimit(timeframe, since, until);
  const candles = await exchange.fetchOHLCV({ symbol, timeframe, since, limit });
  return candles.filter(([timestamp]) => timestamp >= since && timestamp <= until);
}

function estimateCandlesLimit(timeframe: string, since: number, until: number): number {
  const spanMs = Math.max(until - since, 0);
  const bucketMs = timeframeToMs(timeframe);
  const base = Math.ceil(spanMs / bucketMs) + 20;
  return Math.max(100, Math.min(base, 5000));
}

function timeframeToMs(timeframe: string): number {
  const value = timeframe.trim().toLowerCase();
  const multiplier = Number(value.slice(0, -1));
  const unit = value.slice(-1);
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    throw new Error(`Invalid timeframe: ${timeframe}`);
  }
  switch (unit) {
    case "m":
      return multiplier * 60_000;
    case "h":
      return multiplier * 60 * 60_000;
    case "d":
      return multiplier * 24 * 60 * 60_000;
    case "w":
      return multiplier * 7 * 24 * 60 * 60_000;
    default:
      throw new Error(`Unsupported timeframe: ${timeframe}`);
  }
}

function createVenueBacktestRunner(input: {
  executionRouter: ReturnType<DynaTraderRuntime["getExecutionRouter"]>;
  paperEngine: ReturnType<DynaTraderRuntime["getPaperEngine"]>;
  symbol: string;
  timeframe: string;
  venue: string;
}) {
  return async function runVenueBacktest(
    candles: Array<[number, number, number, number, number, number]>,
  ) {
    const { executionRouter, paperEngine, symbol, timeframe, venue } = input;
    const strategyId = `backtest-${venue}-${symbol.replace(/\W+/g, "-")}-${timeframe}`;
    const ohlcv = candles.map(([timestamp, open, high, low, close, volume]) => ({
      timestamp,
      open,
      high,
      low,
      close,
      volume,
    }));

    await paperEngine.initialize(
      symbol,
      ohlcv,
      new Date(ohlcv[0]!.timestamp),
      new Date(ohlcv[ohlcv.length - 1]!.timestamp),
      venue,
    );

    let hasPosition = false;
    const fastPeriod = 10;
    const slowPeriod = 20;
    const targetNotional = 1000;

    for (let i = 0; i < ohlcv.length; i++) {
      await paperEngine.step(symbol);

      if (i < slowPeriod) {
        continue;
      }

      const fast = calculateSma(ohlcv, i, fastPeriod);
      const slow = calculateSma(ohlcv, i, slowPeriod);
      const prevFast = calculateSma(ohlcv, i - 1, fastPeriod);
      const prevSlow = calculateSma(ohlcv, i - 1, slowPeriod);
      const price = ohlcv[i]!.close;

      const buySignal = !hasPosition && prevFast <= prevSlow && fast > slow;
      const sellSignal = hasPosition && prevFast >= prevSlow && fast < slow;

      if (buySignal) {
        const quantity = Math.max(0.0001, targetNotional / price);
        const intent: OrderIntent = {
          venue,
          symbol,
          side: "buy",
          type: "market",
          quantity,
          strategyId,
          mode: "backtest",
        };
        const result = await executionRouter.execute(intent, "backtest");
        hasPosition = result.status === "filled";
      } else if (sellSignal) {
        const position = paperEngine.getPortfolio().positions.find((p) => p.symbol === symbol);
        if (!position) {
          hasPosition = false;
          continue;
        }

        const intent: OrderIntent = {
          venue,
          symbol,
          side: "sell",
          type: "market",
          quantity: position.quantity,
          strategyId,
          mode: "backtest",
        };
        const result = await executionRouter.execute(intent, "backtest");
        hasPosition = false;
        if (result.status !== "filled") {
          hasPosition = paperEngine.getPortfolio().positions.some((p) => p.symbol === symbol);
        }
      }
    }

    const openPosition = paperEngine.getPortfolio().positions.find((p) => p.symbol === symbol);
    if (openPosition) {
      const last = ohlcv[ohlcv.length - 1]!;
      const closeIntent: OrderIntent = {
        venue,
        symbol,
        side: "sell",
        type: "market",
        quantity: openPosition.quantity,
        strategyId,
        mode: "backtest",
      };
      await executionRouter.execute(closeIntent, "backtest");
    }

    return paperEngine.getResult(strategyId, timeframe);
  };
}

function calculateSma(
  data: Array<{ close: number }>,
  index: number,
  period: number,
): number {
  const start = Math.max(0, index - period + 1);
  const slice = data.slice(start, index + 1);
  if (slice.length === 0) {
    return 0;
  }
  return slice.reduce((sum, candle) => sum + candle.close, 0) / slice.length;
}

function aggregateReports(reports: VenueBacktestReport[]): Record<string, unknown> {
  const summaries = reports.map((report) => ({
    venue: report.venue,
    candles: report.candles,
    ...report.result.summary,
  }));
  const totalInitialEquity = reports.reduce(
    (sum, report) => sum + (report.result.portfolioHistory[0]?.equity ?? 10_000),
    0,
  );
  const totalTrades = reports.reduce((sum, report) => sum + report.result.summary.totalTrades, 0);
  const winningTrades = reports.reduce((sum, report) => sum + report.result.summary.winningTrades, 0);
  const losingTrades = reports.reduce((sum, report) => sum + report.result.summary.losingTrades, 0);
  const totalFees = reports.reduce((sum, report) => sum + report.result.summary.totalFees, 0);
  const totalSlippage = reports.reduce((sum, report) => sum + report.result.summary.totalSlippage, 0);
  const finalEquity = reports.reduce((sum, report) => sum + report.result.summary.finalEquity, 0);
  const totalVolume = reports.reduce((sum, report) => sum + report.result.summary.totalVolume, 0);
  const winRate = winningTrades + losingTrades > 0 ? winningTrades / (winningTrades + losingTrades) : 0;

  return {
    totalTrades,
    winningTrades,
    losingTrades,
    winRate,
    totalFees,
    totalSlippage,
    totalVolume,
    finalEquity,
    totalReturn: totalInitialEquity > 0 ? (finalEquity - totalInitialEquity) / totalInitialEquity : 0,
    venues: summaries,
  };
}

function printBacktestReport(
  symbol: string,
  timeframe: string,
  days: number,
  reports: VenueBacktestReport[],
  aggregate: Record<string, unknown>,
): void {
  console.log();
  console.log(bold(cyan("Backtest Results")));
  printSeparator();
  console.log(`Symbol:          ${bold(symbol)}`);
  console.log(`Timeframe:       ${timeframe}`);
  console.log(`Period:          ${days} days`);
  console.log(`Strategy:        SMA crossover routed through ExecutionRouter`);
  console.log();
  console.log(bold("Aggregate:"));
  const totalReturn = Number(aggregate.totalReturn ?? 0);
  const finalEquity = Number(aggregate.finalEquity ?? 0);
  console.log(
    `  Total Return:    ${totalReturn >= 0 ? green(formatPercent(totalReturn)) : red(formatPercent(totalReturn))}`,
  );
  console.log(
    `  Final Equity:    ${finalEquity >= 0 ? green(formatCurrency(finalEquity)) : red(formatCurrency(finalEquity))}`,
  );
  console.log(`  Total Trades:    ${aggregate.totalTrades}`);
  console.log(`  Winning:         ${green(String(aggregate.winningTrades ?? 0))}`);
  console.log(`  Losing:          ${red(String(aggregate.losingTrades ?? 0))}`);
  console.log(
    `  Win Rate:        ${Number(aggregate.winRate ?? 0) >= 0.5 ? green(formatPercent(Number(aggregate.winRate ?? 0))) : yellow(formatPercent(Number(aggregate.winRate ?? 0)))}`,
  );
  console.log(
    `  Total Fees:      ${Number(aggregate.totalFees ?? 0) >= 0 ? red(formatCurrency(Number(aggregate.totalFees ?? 0))) : green(formatCurrency(Number(aggregate.totalFees ?? 0)))}`,
  );

  for (const report of reports) {
    console.log();
    console.log(bold(cyan(`Venue: ${report.venue}`)));
    console.log(`  Candles:         ${report.candles}`);
    console.log(
      `  Trades:          ${report.result.summary.totalTrades} | Wins: ${report.result.summary.winningTrades} | Losses: ${report.result.summary.losingTrades}`,
    );
    console.log(
      `  Return:          ${report.result.summary.totalReturn >= 0 ? green(formatPercent(report.result.summary.totalReturn)) : red(formatPercent(report.result.summary.totalReturn))}`,
    );
    console.log(
      `  Final Equity:    ${formatCurrency(report.result.summary.finalEquity)}`,
    );
    console.log(
      `  Max Drawdown:    ${red(formatPercent(-Math.abs(report.result.summary.maxDrawdown)))}`,
    );
    console.log(
      `  Sharpe Ratio:    ${report.result.summary.sharpeRatio >= 1 ? green(report.result.summary.sharpeRatio.toFixed(2)) : yellow(report.result.summary.sharpeRatio.toFixed(2))}`,
    );
    console.log(
      `  Profit Factor:   ${Number.isFinite(report.result.summary.profitFactor) ? report.result.summary.profitFactor.toFixed(2) : "Infinity"}`,
    );

    if (report.result.trades.length > 0) {
      console.log();
      console.log(dim("  Trade Log:"));
      console.log(dim("    Side    Price       Qty          PnL"));
      console.log(dim("    " + "-".repeat(44)));
      for (const trade of report.result.trades) {
        const sideColor = trade.side === "buy" ? green : red;
        const pnl = trade.realizedPnL ?? 0;
        const pnlStr =
          trade.realizedPnL !== undefined
            ? pnl >= 0
              ? green(formatCurrency(pnl))
              : red(formatCurrency(pnl))
            : dim("-");
        console.log(
          `    ${sideColor(trade.side.padEnd(7))} ${formatCurrency(trade.price).padStart(11)} ${trade.quantity.toFixed(6).padStart(12)} ${pnlStr}`,
        );
      }
    }
  }

  console.log();
  console.log(dim(`Backtest completed across ${reports.length} venue(s).`));
  console.log();
}
