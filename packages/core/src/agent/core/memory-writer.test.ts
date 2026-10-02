/**
 * Tests for MemoryWriter
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { MemoryWriter } from "./memory-writer";
import { MemoryStoreImpl } from "@dyna/memory-core";
import type { TradeOutcome, MarketConditions } from "./types";
import type { SkillManifest } from "@dyna/contracts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStrategy(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    id: "strat-001",
    venue: "binance",
    symbol: "BTC/USDT",
    timeframe: "1h",
    entry: { type: "crossover", fast: 10, slow: 20 },
    exits: { stopLoss: 0.02, takeProfit: 0.05 },
    sizing: { type: "fixed", notional: 1000 },
    risk: {
      maxPositionNotional: 5000,
      maxDailyLoss: 500,
      maxOpenOrders: 5,
    },
    executionMode: "paper",
    ...overrides,
  };
}

function makeMarketConditions(overrides: Partial<MarketConditions> = {}): MarketConditions {
  return {
    regime: "trending",
    volatility: 0.03,
    trend: "bullish",
    volume: "normal",
    ...overrides,
  };
}

function makeTradeOutcome(overrides: Partial<TradeOutcome> = {}): TradeOutcome {
  return {
    tradeId: `trade-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    symbol: "BTC/USDT",
    side: "buy",
    entryPrice: 50000,
    exitPrice: 51000,
    quantity: 0.1,
    pnl: 100,
    pnlPercent: 2,
    holdingTimeMs: 60 * 60 * 1000, // 1 hour
    strategy: makeStrategy(),
    marketConditions: makeMarketConditions(),
    timestamp: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MemoryWriter", () => {
  let memory: MemoryStoreImpl;
  let writer: MemoryWriter;

  beforeEach(() => {
    memory = new MemoryStoreImpl();
    writer = new MemoryWriter(memory);
  });

  describe("writeDecision()", () => {
    it("should store a decision entry", async () => {
      await writer.writeDecision({
        type: "decision",
        agentId: "agent",
        content: "Opening long position on BTC/USDT",
        context: { symbol: "BTC/USDT", strategy: "strat-001" },
        importance: 0.8,
        tags: ["entry", "btc"],
      });

      const entries = writer.getAllEntries();
      expect(entries.length).toBe(1);
      expect(entries[0]!.type).toBe("decision");
      expect(entries[0]!.content).toBe("Opening long position on BTC/USDT");
      expect(entries[0]!.context.symbol).toBe("BTC/USDT");
    });

    it("should persist to both journal and memory scopes", async () => {
      const putSpy = vi.spyOn(memory, "put");

      await writer.writeDecision({
        type: "decision",
        agentId: "agent",
        content: "Test decision",
        context: {},
        importance: 0.5,
        tags: ["test"],
      });

      const journalCalls = putSpy.mock.calls.filter(
        ([event]) => event.scope === "decision_journal" && event.kind === "decision",
      );
      const memoryCalls = putSpy.mock.calls.filter(
        ([event]) => event.scope === "memory_writer" && event.kind === "decision",
      );

      expect(journalCalls.length).toBe(1);
      expect(memoryCalls.length).toBe(1);
    });

    it("should assign unique IDs with timestamp", async () => {
      await writer.writeDecision({
        type: "decision",
        agentId: "agent",
        content: "Decision 1",
        context: {},
        importance: 0.5,
        tags: [],
      });

      // Small delay to ensure different timestamp
      await new Promise((r) => setTimeout(r, 10));

      await writer.writeDecision({
        type: "decision",
        agentId: "agent",
        content: "Decision 2",
        context: {},
        importance: 0.5,
        tags: [],
      });

      const entries = writer.getAllEntries();
      expect(entries.length).toBe(2);
      expect(entries[0]!.id).not.toBe(entries[1]!.id);
    });
  });

  describe("writeOutcome()", () => {
    it("should record a winning trade outcome", async () => {
      const outcome = makeTradeOutcome({ pnl: 100, pnlPercent: 2 });
      await writer.writeOutcome(outcome);

      const entries = writer.getAllEntries();
      expect(entries.length).toBe(1);
      expect(entries[0]!.type).toBe("outcome");
      expect(entries[0]!.content).toContain("WIN");
      expect(entries[0]!.content).toContain("BTC/USDT");
      expect(entries[0]!.metrics?.pnl).toBe(100);
    });

    it("should record a losing trade outcome", async () => {
      const outcome = makeTradeOutcome({ pnl: -100, pnlPercent: -2 });
      await writer.writeOutcome(outcome);

      const entries = writer.getAllEntries();
      expect(entries[0]!.content).toContain("LOSS");
    });

    it("should record a breakeven trade outcome", async () => {
      const outcome = makeTradeOutcome({ pnl: 0, pnlPercent: 0 });
      await writer.writeOutcome(outcome);

      const entries = writer.getAllEntries();
      expect(entries[0]!.content).toContain("BREAKEVEN");
    });

    it("should include correct tags", async () => {
      const outcome = makeTradeOutcome({
        side: "sell",
        marketConditions: makeMarketConditions({ regime: "ranging" }),
      });
      await writer.writeOutcome(outcome);

      const entries = writer.getAllEntries();
      expect(entries[0]!.tags).toContain("win");
      expect(entries[0]!.tags).toContain("sell");
      expect(entries[0]!.tags).toContain("BTC/USDT");
      expect(entries[0]!.tags).toContain("ranging");
    });

    it("should calculate importance based on PnL magnitude", async () => {
      const smallOutcome = makeTradeOutcome({ pnlPercent: 0.05 });
      await writer.writeOutcome(smallOutcome);

      const bigOutcome = makeTradeOutcome({ pnlPercent: 0.1 });
      await writer.writeOutcome(bigOutcome);

      const entries = writer.getAllEntries();
      // Formula: Math.min(1, Math.abs(pnlPercent) * 5 + 0.3)
      // 0.05: min(1, 0.55) = 0.55
      // 0.1: min(1, 0.8) = 0.8
      expect(entries[1]!.importance).toBeGreaterThan(entries[0]!.importance);
    });

    it("should store raw outcome data in memory scope", async () => {
      const putSpy = vi.spyOn(memory, "put");
      const outcome = makeTradeOutcome();
      await writer.writeOutcome(outcome);

      const memoryCalls = putSpy.mock.calls.filter(
        ([event]) => event.scope === "memory_writer" && event.kind === "outcome",
      );
      expect(memoryCalls.length).toBe(1);

      const payload = memoryCalls[0]![0].payload as Record<string, unknown>;
      expect(payload.rawOutcome).toBeDefined();
      expect((payload.rawOutcome as Record<string, unknown>).tradeId).toBe(outcome.tradeId);
    });
  });

  describe("writeEvaluation()", () => {
    it("should record a strategy evaluation", async () => {
      const strategy = makeStrategy();
      await writer.writeEvaluation(strategy, {
        analysis: "Strategy shows strong momentum signals",
        confidence: 0.8,
        riskScore: 0.6,
        recommendations: ["Increase position size", "Widen take-profit"],
      });

      const entries = writer.getAllEntries();
      expect(entries.length).toBe(1);
      expect(entries[0]!.type).toBe("evaluation");
      expect(entries[0]!.content).toBe("Strategy shows strong momentum signals");
      expect(entries[0]!.context.confidence).toBe(0.8);
      expect(entries[0]!.metrics?.riskReward).toBe(0.6);
    });

    it("should persist with recommendations", async () => {
      const putSpy = vi.spyOn(memory, "put");
      const strategy = makeStrategy();
      await writer.writeEvaluation(strategy, {
        analysis: "Test evaluation",
        confidence: 0.7,
        riskScore: 0.5,
        recommendations: ["Rec 1", "Rec 2"],
      });

      const journalCalls = putSpy.mock.calls.filter(
        ([event]) => event.scope === "decision_journal" && event.kind === "evaluation",
      );
      expect(journalCalls.length).toBe(1);

      const payload = journalCalls[0]![0].payload as Record<string, unknown>;
      expect(payload.recommendations).toEqual(["Rec 1", "Rec 2"]);
    });
  });

  describe("writeAssessment()", () => {
    it("should record a risk assessment", async () => {
      await writer.writeAssessment({
        strategyId: "strat-001",
        symbol: "BTC/USDT",
        decision: "approved",
        reasons: ["Within risk limits", "Market conditions favorable"],
        riskLevel: "low",
        confidence: 0.9,
      });

      const entries = writer.getAllEntries();
      expect(entries.length).toBe(1);
      expect(entries[0]!.type).toBe("assessment");
      expect(entries[0]!.content).toContain("approved");
      expect(entries[0]!.content).toContain("low");
      expect(entries[0]!.context.riskLevel).toBe("low");
      expect(entries[0]!.context.confidence).toBe(0.9);
    });

    it("should calculate importance from risk level and confidence", async () => {
      await writer.writeAssessment({
        strategyId: "strat-001",
        symbol: "BTC/USDT",
        decision: "approved",
        reasons: [],
        riskLevel: "low",
        confidence: 0.5,
      });

      await writer.writeAssessment({
        strategyId: "strat-001",
        symbol: "BTC/USDT",
        decision: "rejected",
        reasons: [],
        riskLevel: "high",
        confidence: 0.9,
      });

      const entries = writer.getAllEntries();
      // importance = 0.6 + confidence * 0.4
      expect(entries[1]!.importance).toBeGreaterThan(entries[0]!.importance);
    });
  });

  describe("writeObservation()", () => {
    it("should record a general observation", async () => {
      await writer.writeObservation({
        content: "BTC showing unusual volume spike",
        symbol: "BTC/USDT",
        importance: 0.7,
        tags: ["volume", "unusual"],
      });

      const entries = writer.getAllEntries();
      expect(entries.length).toBe(1);
      expect(entries[0]!.type).toBe("observation");
      expect(entries[0]!.content).toBe("BTC showing unusual volume spike");
      expect(entries[0]!.importance).toBe(0.7);
      expect(entries[0]!.tags).toContain("volume");
    });

    it("should use defaults when optional fields are omitted", async () => {
      await writer.writeObservation({
        content: "General market note",
      });

      const entries = writer.getAllEntries();
      expect(entries[0]!.importance).toBe(0.5);
      expect(entries[0]!.tags).toEqual(["observation"]);
    });
  });

  describe("getDecisionHistory()", () => {
    it("should return entries sorted by timestamp descending", async () => {
      await writer.writeDecision({
        type: "decision",
        agentId: "agent",
        content: "First decision",
        context: { symbol: "BTC/USDT" },
        importance: 0.5,
        tags: [],
      });

      await new Promise((r) => setTimeout(r, 10));

      await writer.writeDecision({
        type: "decision",
        agentId: "agent",
        content: "Second decision",
        context: { symbol: "BTC/USDT" },
        importance: 0.5,
        tags: [],
      });

      const history = await writer.getDecisionHistory();
      expect(history.length).toBe(2);
      expect(history[0]!.content).toBe("Second decision");
      expect(history[1]!.content).toBe("First decision");
    });

    it("should filter by symbol when provided", async () => {
      await writer.writeDecision({
        type: "decision",
        agentId: "agent",
        content: "BTC decision",
        context: { symbol: "BTC/USDT" },
        importance: 0.5,
        tags: [],
      });

      await writer.writeDecision({
        type: "decision",
        agentId: "agent",
        content: "ETH decision",
        context: { symbol: "ETH/USDT" },
        importance: 0.5,
        tags: [],
      });

      const btcHistory = await writer.getDecisionHistory("BTC/USDT");
      expect(btcHistory.length).toBe(1);
      expect(btcHistory[0]!.content).toBe("BTC decision");
    });

    it("should respect limit parameter", async () => {
      for (let i = 0; i < 10; i++) {
        await writer.writeDecision({
          type: "decision",
          agentId: "agent",
          content: `Decision ${i}`,
          context: {},
          importance: 0.5,
          tags: [],
        });
      }

      const history = await writer.getDecisionHistory(undefined, 5);
      expect(history.length).toBe(5);
    });
  });

  describe("getPerformanceSummary()", () => {
    it("should return empty summary when no outcomes recorded", async () => {
      const summary = await writer.getPerformanceSummary();

      expect(summary.totalTrades).toBe(0);
      expect(summary.winRate).toBe(0);
      expect(summary.totalPnl).toBe(0);
      expect(summary.bestSymbol).toBeNull();
      expect(summary.worstSymbol).toBeNull();
    });

    it("should calculate win rate correctly", async () => {
      await writer.writeOutcome(makeTradeOutcome({ pnl: 100, pnlPercent: 2 }));
      await writer.writeOutcome(makeTradeOutcome({ pnl: -50, pnlPercent: -1 }));
      await writer.writeOutcome(makeTradeOutcome({ pnl: 200, pnlPercent: 4 }));

      const summary = await writer.getPerformanceSummary();
      expect(summary.totalTrades).toBe(3);
      expect(summary.winningTrades).toBe(2);
      expect(summary.losingTrades).toBe(1);
      expect(summary.winRate).toBeCloseTo(2 / 3, 5);
    });

    it("should calculate PnL metrics correctly", async () => {
      await writer.writeOutcome(makeTradeOutcome({ pnl: 100, pnlPercent: 2 }));
      await writer.writeOutcome(makeTradeOutcome({ pnl: -50, pnlPercent: -1 }));
      await writer.writeOutcome(makeTradeOutcome({ pnl: 200, pnlPercent: 4 }));

      const summary = await writer.getPerformanceSummary();
      expect(summary.totalPnl).toBe(250);
      expect(summary.averagePnl).toBeCloseTo(250 / 3, 5);
      expect(summary.largestWin).toBe(200);
      expect(summary.largestLoss).toBe(-50);
    });

    it("should calculate profit factor correctly", async () => {
      await writer.writeOutcome(makeTradeOutcome({ pnl: 200, pnlPercent: 4 }));
      await writer.writeOutcome(makeTradeOutcome({ pnl: 100, pnlPercent: 2 }));
      await writer.writeOutcome(makeTradeOutcome({ pnl: -50, pnlPercent: -1 }));

      const summary = await writer.getPerformanceSummary();
      // profitFactor = |300 / -50| = 6
      expect(summary.profitFactor).toBeCloseTo(6, 5);
    });

    it("should handle all winning trades (infinite profit factor)", async () => {
      await writer.writeOutcome(makeTradeOutcome({ pnl: 100, pnlPercent: 2 }));
      await writer.writeOutcome(makeTradeOutcome({ pnl: 200, pnlPercent: 4 }));

      const summary = await writer.getPerformanceSummary();
      expect(summary.profitFactor).toBe(Infinity);
    });

    it("should track best and worst symbols", async () => {
      await writer.writeOutcome(makeTradeOutcome({
        symbol: "BTC/USDT",
        pnl: 200,
        pnlPercent: 4,
      }));
      await writer.writeOutcome(makeTradeOutcome({
        symbol: "ETH/USDT",
        pnl: -100,
        pnlPercent: -2,
      }));

      const summary = await writer.getPerformanceSummary();
      expect(summary.bestSymbol).toBe("BTC/USDT");
      expect(summary.worstSymbol).toBe("ETH/USDT");
    });

    it("should track best and worst regimes", async () => {
      await writer.writeOutcome(makeTradeOutcome({
        pnl: 200,
        pnlPercent: 4,
        marketConditions: makeMarketConditions({ regime: "trending" }),
      }));
      await writer.writeOutcome(makeTradeOutcome({
        pnl: -100,
        pnlPercent: -2,
        marketConditions: makeMarketConditions({ regime: "volatile" }),
      }));

      const summary = await writer.getPerformanceSummary();
      expect(summary.bestRegime).toBe("trending");
      expect(summary.worstRegime).toBe("volatile");
    });

    it("should count breakeven trades", async () => {
      await writer.writeOutcome(makeTradeOutcome({ pnl: 0.0001, pnlPercent: 0 }));
      await writer.writeOutcome(makeTradeOutcome({ pnl: 100, pnlPercent: 2 }));

      const summary = await writer.getPerformanceSummary();
      expect(summary.breakevenTrades).toBe(1);
      expect(summary.winningTrades).toBe(1);
    });
  });

  describe("getAllEntries()", () => {
    it("should return empty array initially", () => {
      expect(writer.getAllEntries()).toHaveLength(0);
    });

    it("should return all entries", async () => {
      await writer.writeDecision({
        type: "decision",
        agentId: "agent",
        content: "Decision 1",
        context: {},
        importance: 0.5,
        tags: [],
      });
      await writer.writeObservation({ content: "Observation 1" });

      const entries = writer.getAllEntries();
      expect(entries.length).toBe(2);
    });
  });
});
