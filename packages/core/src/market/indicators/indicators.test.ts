import { describe, expect, it } from "vitest";
import { TechnicalIndicators } from "./indicators";
import type { SkillManifest } from "@dyna/contracts";

function makeData() {
  return Array.from({ length: 40 }, (_, index) => {
    const price = 100 + index;
    return {
      timestamp: Date.UTC(2026, 0, 1, 0, index),
      open: price,
      high: price + 1,
      low: price - 1,
      close: price,
      volume: 1000 + index,
    };
  });
}

describe("TechnicalIndicators.calculateStrategyIndicators", () => {
  it("uses generic entry conditions instead of hardcoded strategy IDs", async () => {
    const strategy: SkillManifest = {
      id: "workspace-ma-template",
      venue: "binance",
      symbol: "BTC/USDT",
      timeframe: "1h",
      entry: {
        condition: "ema_crossover",
        fastPeriod: 8,
        slowPeriod: 21,
      },
      exits: {
        stopLoss: 0.02,
        takeProfit: 0.04,
      },
      sizing: { amount: 0.01 },
      risk: { maxPositionNotional: 1000, maxDailyLoss: 100, maxOpenOrders: 3 },
      executionMode: "paper",
    };

    const indicators = await TechnicalIndicators.calculateStrategyIndicators(strategy, makeData());

    expect(indicators.fastMA).toBeDefined();
    expect(indicators.slowMA).toBeDefined();
    expect(indicators.fastMA!.length).toBeGreaterThan(0);
    expect(indicators.slowMA!.length).toBeGreaterThan(0);
  });

  it("detects RSI-based strategies from condition text", async () => {
    const strategy: SkillManifest = {
      id: "workspace-rsi-template",
      venue: "binance",
      symbol: "ETH/USDT",
      timeframe: "1h",
      entry: {
        condition: "rsi_mean_reversion",
        period: 14,
      },
      exits: {
        stopLoss: 0.015,
        takeProfit: 0.03,
      },
      sizing: { amount: 0.01 },
      risk: { maxPositionNotional: 1000, maxDailyLoss: 100, maxOpenOrders: 3 },
      executionMode: "paper",
    };

    const indicators = await TechnicalIndicators.calculateStrategyIndicators(strategy, makeData());

    expect(indicators.rsi).toBeDefined();
    expect(indicators.rsi).not.toHaveLength(0);
  });
});
