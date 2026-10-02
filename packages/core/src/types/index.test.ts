/**
 * Tests for Dyna-Trader shared contracts
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ChannelEnvelopeSchema } from "./index";
import type {
  ChannelEnvelope,
  TradeMode,
  AgentTurnContext,
  StrategySource,
  SkillManifest,
  OrderIntent,
  RiskDecision,
} from "./index";

describe("Contracts", () => {
  describe("ChannelEnvelope", () => {
    it("should validate a minimal channel envelope", () => {
      const envelope: ChannelEnvelope = {
        channel: "discord",
        senderId: "user123",
        sessionId: "session456",
        trusted: false,
        metadata: {},
      };

      const result = ChannelEnvelopeSchema.safeParse(envelope);
      expect(result.success).toBe(true);
    });

    it("should validate a complete channel envelope", () => {
      const envelope: ChannelEnvelope = {
        channel: "discord",
        senderId: "user123",
        sessionId: "session456",
        text: "Hello, I want to place a trade",
        attachments: [{
          kind: "image",
          url: "https://example.com/chart.png",
          mimeType: "image/png",
        }],
        trusted: true,
        metadata: {
          command: "place_order",
          priority: "high",
        },
      };

      const result = ChannelEnvelopeSchema.safeParse(envelope);
      expect(result.success).toBe(true);
    });

    it("should reject invalid channel envelope", () => {
      const envelope = {
        channel: "discord",
        // missing required fields
        metadata: {},
      };

      const result = ChannelEnvelopeSchema.safeParse(envelope);
      expect(result.success).toBe(false);
    });
  });

  describe("TradeMode", () => {
    it("should have all trade modes", () => {
      const modes: TradeMode[] = ["backtest", "paper", "live"];
      expect(modes).toHaveLength(3);
      expect(modes).toContain("backtest");
      expect(modes).toContain("paper");
      expect(modes).toContain("live");
    });
  });

  describe("AgentTurnContext", () => {
    it("should create valid context", () => {
      const ctx: AgentTurnContext = {
        now: new Date(),
        mode: "paper",
        accountId: "acc123",
        portfolioId: "port456",
        correlationId: "corr789",
      };

      expect(ctx.mode).toBe("paper");
      expect(ctx.accountId).toBe("acc123");
      expect(typeof ctx.correlationId).toBe("string");
    });
  });

  describe("StrategySource", () => {
    it("should validate template strategy", () => {
      const source: StrategySource = {
        kind: "template",
        body: "MovingAverageCrossover",
        params: {
          fastPeriod: 10,
          slowPeriod: 20,
        },
      };

      expect(source.kind).toBe("template");
      expect(source.body).toBe("MovingAverageCrossover");
      expect(source.params).toBeDefined();
    });

    it("should validate LLM plan strategy", () => {
      const source: StrategySource = {
        kind: "llm-plan",
        body: "Buy when RSI < 30 and MACD crosses above signal",
        params: {
          timeframe: "1h",
          symbols: ["BTC/USDT"],
        },
      };

      expect(source.kind).toBe("llm-plan");
    });
  });

  describe("SkillManifest", () => {
    it("should create valid strategy IR", () => {
      const ir: SkillManifest = {
        id: "strat123",
        venue: "binance",
        symbol: "BTC/USDT",
        timeframe: "1h",
        entry: { condition: "rsi < 30" },
        exits: { takeProfit: 0.05, stopLoss: 0.02 },
        sizing: { amount: 0.01, currency: "BTC" },
        risk: {
          maxPositionNotional: 1000,
          maxDailyLoss: 100,
          maxOpenOrders: 3,
        },
        executionMode: "paper",
      };

      expect(ir.id).toBe("strat123");
      expect(ir.venue).toBe("binance");
      expect(ir.risk.maxPositionNotional).toBe(1000);
    });
  });

  describe("OrderIntent", () => {
    it("should create valid market buy intent", () => {
      const intent: OrderIntent = {
        venue: "binance",
        symbol: "BTC/USDT",
        side: "buy",
        type: "market",
        quantity: 0.01,
        strategyId: "strat123",
        mode: "paper",
      };

      expect(intent.side).toBe("buy");
      expect(intent.type).toBe("market");
      expect(intent.mode).toBe("paper");
    });

    it("should create valid limit sell intent", () => {
      const intent: OrderIntent = {
        venue: "binance",
        symbol: "BTC/USDT",
        side: "sell",
        type: "limit",
        quantity: 0.01,
        price: 45000,
        strategyId: "strat123",
        mode: "paper",
      };

      expect(intent.side).toBe("sell");
      expect(intent.type).toBe("limit");
      expect(intent.price).toBe(45000);
    });
  });

  describe("RiskDecision", () => {
    it("should create approved decision", () => {
      const decision: RiskDecision = {
        decision: "approved",
        reasons: [],
        approvedIntent: {
          venue: "binance",
          symbol: "BTC/USDT",
          side: "buy",
          type: "market",
          quantity: 0.01,
          strategyId: "strat123",
          mode: "paper",
        },
      };

      expect(decision.decision).toBe("approved");
      expect(decision.reasons).toHaveLength(0);
      expect(decision.approvedIntent).toBeDefined();
    });

    it("should create rejected decision", () => {
      const decision: RiskDecision = {
        decision: "rejected",
        reasons: ["Exceeds max position size", "Market volatility too high"],
      };

      expect(decision.decision).toBe("rejected");
      expect(decision.reasons).toHaveLength(2);
      expect(decision.approvedIntent).toBeUndefined();
    });

    it("should create manual approval decision", () => {
      const decision: RiskDecision = {
        decision: "manual-approval",
        reasons: ["Requires manual review due to large position size"],
      };

      expect(decision.decision).toBe("manual-approval");
    });
  });
});