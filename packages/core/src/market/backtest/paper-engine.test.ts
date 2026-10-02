import { describe, expect, it, vi } from "vitest";
import type { ExchangeAdapter } from "@dyna/contracts";
import { PaperEngine } from "./paper-engine";

function createMockExchange(): ExchangeAdapter {
  return {
    id: "binance",
    capabilities: vi.fn().mockResolvedValue({}),
    fetchMarkets: vi.fn().mockResolvedValue({}),
    fetchOHLCV: vi.fn().mockResolvedValue([]),
    balances: vi.fn().mockResolvedValue({}),
  } as unknown as ExchangeAdapter;
}

describe("PaperEngine", () => {
  it("fills buy and sell orders through the backtest path", async () => {
    const engine = new PaperEngine(
      {
        initialBalance: 10_000,
        commissionRate: 0.001,
        slippageRate: 0.001,
        feeCurrency: "USD",
      },
      createMockExchange(),
    );

    const candles = [
      { timestamp: 1_000, open: 100, high: 101, low: 99, close: 100, volume: 10 },
      { timestamp: 61_000, open: 100, high: 106, low: 99, close: 105, volume: 10 },
      { timestamp: 121_000, open: 105, high: 108, low: 104, close: 107, volume: 10 },
    ];

    await engine.initialize("BTC/USDT", candles, new Date(candles[0]!.timestamp), new Date(candles[2]!.timestamp), "binance");
    await engine.step("BTC/USDT");

    const buy = await engine.placeOrder({
      venue: "binance",
      symbol: "BTC/USDT",
      side: "buy",
      type: "market",
      quantity: 1,
      strategyId: "roundtrip",
      mode: "backtest",
    });

    expect(buy.status).toBe("filled");
    expect(engine.getPortfolio().positions).toHaveLength(1);

    await engine.step("BTC/USDT");

    const sell = await engine.placeOrder({
      venue: "binance",
      symbol: "BTC/USDT",
      side: "sell",
      type: "market",
      quantity: 1,
      strategyId: "roundtrip",
      mode: "backtest",
    });

    expect(sell.status).toBe("filled");
    expect(engine.getPortfolio().positions).toHaveLength(0);
    expect(sell.realizedPnL).toBeGreaterThan(0);

    const result = engine.getResult("roundtrip", "1m");
    expect(result.summary.totalTrades).toBe(2);
    expect(result.summary.winningTrades).toBe(1);
    expect(result.equityCurve.length).toBeGreaterThan(0);
    expect(result.drawdownCurve.length).toBeGreaterThan(0);
    expect(result.trades.map((trade) => trade.side)).toEqual(["buy", "sell"]);
  });
});
