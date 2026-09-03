/**
 * DynaMind API — Backtest Provider
 *
 * Wraps the DynaMind Data API's backtesting endpoints as a BacktestProvider.
 * Provides: strategy backtesting, strategy listing.
 */

import type { BacktestProvider, BacktestConfig, BacktestResult, StrategyInfo } from "dynatrader";

export interface DynaMindBacktestConfig {
  baseUrl: string;
  apiKey?: string;
}

export function createBacktestProvider(
  config: DynaMindBacktestConfig,
): BacktestProvider {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  async function request<T>(path: string, body?: unknown): Promise<T> {
    const resp = await fetch(`${config.baseUrl}${path}`, {
      method: body ? "POST" : "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
      throw new Error(`DynaMind API ${resp.status}: ${resp.statusText}`);
    }
    return resp.json() as Promise<T>;
  }

  return {
    async runBacktest(config: BacktestConfig): Promise<BacktestResult> {
      const data = await request<{
        result: {
          strategy: string;
          symbol: string;
          total_return: number;
          sharpe_ratio: number;
          max_drawdown: number;
          win_rate: number;
          total_trades: number;
          profit_factor: number;
          trades: Array<{
            entry: { price: number; timestamp: string };
            exit: { price: number; timestamp: string };
            side: string;
            pnl: number;
          }>;
        };
      }>("/api/v1/backtest/run", {
        strategy: config.strategy,
        symbol: config.symbol,
        timeframe: config.timeframe,
        start_date: config.startDate,
        end_date: config.endDate,
        initial_capital: config.initialCapital,
        parameters: config.parameters,
      });

      return {
        strategy: data.result.strategy,
        symbol: data.result.symbol,
        totalReturn: data.result.total_return,
        sharpeRatio: data.result.sharpe_ratio,
        maxDrawdown: data.result.max_drawdown,
        winRate: data.result.win_rate,
        totalTrades: data.result.total_trades,
        profitFactor: data.result.profit_factor,
        trades: data.result.trades.map((t) => ({
          entry: t.entry,
          exit: t.exit,
          side: t.side as "buy" | "sell",
          pnl: t.pnl,
        })),
      };
    },

    async listStrategies(): Promise<StrategyInfo[]> {
      const data = await request<{
        strategies: Array<{
          id: string;
          name: string;
          description: string;
          parameters: Record<string, {
            type: string;
            default: unknown;
            description: string;
          }>;
        }>;
      }>("/api/v1/backtest/strategies");

      return data.strategies.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        parameters: s.parameters,
      }));
    },
  };
}
