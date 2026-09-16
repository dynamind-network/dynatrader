/**
 * CLI Command: trade
 */

import type { DynaTraderRuntime } from '@dyna/orchestration/workspace';
import type { AgentTurnContext, StrategySource, TradeMode, ExchangeAdapter } from '@dyna/types';
import { bold, cyan, green, red, yellow, dim, formatCurrency, formatPercent, formatDuration, printSeparator } from './utils';
import { normalizeMarketRecord } from '../market/utils';

export async function cmdTrade(
  runtime: DynaTraderRuntime,
  mode: TradeMode,
  options: { execute?: boolean } = {},
): Promise<void> {
  console.log();
  console.log(bold(cyan('Analyzing current market universe...')));
  console.log(dim(`Mode: ${mode}`));
  console.log();

  const agent = runtime.getAgent();
  const exchange = runtime.getExchange();
  const marketUniverse = await buildMarketUniverse(exchange);

  // Build agent turn context
  const context: AgentTurnContext = {
    now: new Date(),
    mode,
    accountId: 'cli-account',
    portfolioId: 'cli-portfolio',
    correlationId: `cli-${Date.now()}`,
  };

  // Build strategy source
  const source: StrategySource = {
    kind: 'llm-plan',
    body: [
      'Choose the best trade from the current market universe.',
      'Do not wait for the operator to provide market selection details.',
      'Prefer liquid, tradable markets with clear risk definition.',
      '',
      'Market universe:',
      marketUniverse.summary,
    ].join('\n'),
    params: {
      venue: exchange.id,
      marketUniverse: marketUniverse.items,
    },
  };

  const result = await agent.executeTurn(context, source);

  if (result.error) {
    console.log(red(`Error: ${result.error}`));
    console.log();
  }

  // Print iterations
  for (const iter of result.iterations) {
    const confColor =
      iter.output.confidence >= 0.8
        ? green
        : iter.output.confidence >= 0.5
          ? yellow
          : red;
    console.log(
      `  [${iter.iteration}/${result.iterations.length}] Iteration ${iter.iteration} - Confidence: ${confColor(iter.output.confidence.toFixed(2))}`,
    );
    if (iter.output.analysis) {
      const analysisLines = iter.output.analysis.split('\n').slice(0, 5);
      for (const line of analysisLines) {
        if (line.trim()) {
          console.log(dim(`    ${line.trim()}`));
        }
      }
    }
  }

  console.log();

  // Print final strategies
  if (result.finalStrategies.length > 0) {
    for (const strategy of result.finalStrategies) {
      const exits = strategy.exits as { takeProfit?: number; stopLoss?: number };
      const sizing = strategy.sizing as { amount?: number; percentage?: number };
      const entryVal =
        typeof strategy.entry === 'object' && strategy.entry !== null
          ? (strategy.entry as Record<string, unknown>)
          : {};

      console.log(bold('Strategy:'));
      console.log(`  ID: ${dim(strategy.id)}`);
      console.log(`  Symbol: ${bold(strategy.symbol)}`);
      console.log(`  Venue: ${strategy.venue}`);

      // Extract action from entry if available
      const action = (entryVal.action as string) || 'ANALYZE';
      console.log(`  Action: ${bold(action)}`);

      if (exits?.stopLoss) {
        console.log(`  Stop Loss: ${red(formatPercent(-Math.abs(exits.stopLoss)))}`);
      }
      if (exits?.takeProfit) {
        console.log(`  Take Profit: ${green(formatPercent(exits.takeProfit))}`);
      }
      if (sizing?.amount) {
        console.log(`  Position Size: ${sizing.amount}`);
      }

      console.log(`  Risk:`);
      console.log(`    Max Position: ${formatCurrency(strategy.risk.maxPositionNotional)}`);
      console.log(`    Max Daily Loss: ${formatCurrency(strategy.risk.maxDailyLoss)}`);
      console.log(`    Max Open Orders: ${strategy.risk.maxOpenOrders}`);
    }
  } else {
    console.log(yellow('No strategies generated.'));
  }

  console.log();

  // Print order intents
  const allOrders = result.iterations.flatMap((i) => i.output.orderIntents);
  if (allOrders.length > 0) {
    console.log();
    console.log(bold('Orders Generated:'));
    let orderNum = 1;
    for (const order of allOrders) {
      const sideColor = order.side === 'buy' ? green : red;
      console.log(
        `  ${orderNum}. ${bold(order.type.toUpperCase())} ${sideColor(order.side.toUpperCase())} ${order.quantity} ${order.symbol} ${order.price ? `@ ${formatCurrency(order.price)}` : '@ market'}`,
      );
      orderNum++;
    }
  }

  // Execute only the final agent iteration's intents. Earlier iterations are
  // proposals, not independent orders; submitting all of them would duplicate
  // exposure and violate the agent's final decision.
  const finalIntents = result.iterations.at(-1)?.output.orderIntents ?? [];
  const shouldExecute = options.execute ?? (mode === 'paper' || mode === 'backtest');
  if (shouldExecute && finalIntents.length > 0) {
    console.log();
    console.log(bold('Execution:'));
    const executionResults = await runtime.executeOrderIntents(finalIntents, mode);
    for (const [index, execution] of executionResults.entries()) {
      const intent = finalIntents[index];
      const statusColor = execution.status === 'filled' ? green : red;
      console.log(`  ${statusColor(execution.status.toUpperCase())} ${intent.side.toUpperCase()} ${intent.quantity} ${intent.symbol} (${execution.orderId})`);
      if (execution.rejectionReason) console.log(`    ${red(execution.rejectionReason)}`);
    }
  } else if (!shouldExecute && finalIntents.length > 0) {
    console.log(dim('Execution skipped: pass --execute or use paper/backtest mode.'));
  }

  // Summary
  console.log();
  console.log(
    dim(
      `Completed in ${formatDuration(result.totalTime)} (${result.iterations.length} iterations, ${result.totalApiCalls} API calls)`,
    ),
  );
  console.log();
}

async function buildMarketUniverse(exchange: ExchangeAdapter): Promise<{ summary: string; items: Array<Record<string, unknown>> }> {
  const marketsResponse = await exchange.fetchMarkets().catch(() => null);
  const rawMarkets = marketsResponse && typeof marketsResponse === 'object'
    ? ((marketsResponse as { markets?: unknown }).markets ?? marketsResponse)
    : null;
  const markets = Array.isArray(rawMarkets) ? rawMarkets : [];
  const items = markets
    .map((market) => normalizeMarketRecord(market))
    .filter((market): market is Record<string, unknown> => market !== null)
    .slice(0, 12);

  if (items.length === 0) {
    return {
      summary: 'No market catalogue was returned by the exchange. Use connected tools and current context to choose a tradable symbol.',
      items: [],
    };
  }

  const summary = items
    .map((market, index) => {
      const symbol = String(market.symbol ?? 'unknown');
      const status = market.status ? `, status=${String(market.status)}` : '';
      const tradable = market.tradable !== undefined ? `, tradable=${String(market.tradable)}` : '';
      const type = market.type ? `, type=${String(market.type)}` : '';
      return `${index + 1}. ${symbol}${type}${status}${tradable}`;
    })
    .join('\n');

  return { summary, items };
}

// normalizeMarketRecord imported from ../market/utils
