/**
 * Dyna-Trader Execution Router Tests
 *
 * Tests for mode-based order dispatch, risk integration, approval tokens,
 * audit trail recording, and mode transition validation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExecutionRouterImpl } from "./execution-router";
import type {
  OrderIntent,
  ExecutionResult,
  ApprovalToken,

  ExecutionMode,
  TradeMode,
} from "@dyna/contracts";
import type { AuditTrail } from "@dyna/audit";
import type { PaperEngine } from "@dyna/backtest";
import type { CCXTAdapter } from "@dyna/exchange-ccxt";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function createMockAuditTrail(): AuditTrail {
  return {
    record: vi.fn().mockResolvedValue(undefined),
    getEvents: vi.fn().mockResolvedValue([]),
    searchEvents: vi.fn().mockResolvedValue([]),
    getEventSummary: vi.fn().mockResolvedValue({
      totalEvents: 0,
      eventsByType: {},
      eventsByResult: {},
      lastEvent: null,
    }),
  } as unknown as AuditTrail;
}

function createMockPaperEngine(): PaperEngine {
  return {
    placeOrder: vi.fn().mockImplementation(async (intent: OrderIntent) => ({
      id: `mock-trade-${Date.now()}`,
      timestamp: new Date(),
      symbol: intent.symbol,
      side: intent.side,
      type: intent.type,
      quantity: intent.quantity,
      price: intent.price ?? 100.0,
      value: intent.quantity * (intent.price ?? 100.0),
      fees: intent.quantity * (intent.price ?? 100.0) * 0.001,
      slippage: 0,
      status: "filled",
    })),
    cancelOrder: vi.fn().mockResolvedValue(undefined),
    getPortfolio: vi.fn().mockReturnValue({
      balance: 10000,
      positions: [],
      totalValue: 10000,
      equity: 10000,
      margin: 0,
      dailyPnL: 0,
      totalPnL: 0,
    }),
    getTrades: vi.fn().mockReturnValue([]),
    getResult: vi.fn(),
    initialize: vi.fn().mockResolvedValue(undefined),
    step: vi.fn().mockResolvedValue(undefined),
  } as unknown as PaperEngine;
}

function createMockCCXTAdapter(): CCXTAdapter {
  return {
    id: "mock-exchange",
    placeOrder: vi.fn().mockImplementation(async (intent: OrderIntent) => ({
      orderId: `ccxt-${Date.now()}`,
      raw: {},
    })),
    cancelOrder: vi.fn().mockResolvedValue(undefined),
    capabilities: vi.fn().mockResolvedValue({}),
    fetchMarkets: vi.fn().mockResolvedValue({}),
    fetchOHLCV: vi.fn().mockResolvedValue([]),
    balances: vi.fn().mockResolvedValue({}),
  } as unknown as CCXTAdapter;
}

function createMockApprovalToken(overrides: Partial<ApprovalToken> = {}): ApprovalToken {
  return {
    id: "token-001",
    approvalRequestId: "req-001",
    approvedBy: "risk-manager",
    channel: "slack",
    action: "execute_live_order",
    artifactType: "order",
    artifactHash: "hash-001",
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 3600000),
    singleUse: true,
    used: false,
    signature: "mock-signature",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createOrderIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    venue: "binance",
    symbol: "BTC/USDT",
    side: "buy",
    type: "market",
    quantity: 0.01,
    price: 50000,
    strategyId: "strat-001",
    mode: "paper",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ExecutionRouterImpl", () => {
  let audit: AuditTrail;
  let paperEngine: PaperEngine;
  let ccxtAdapter: CCXTAdapter;
  let exchangeAdapters: Map<string, CCXTAdapter>;

  beforeEach(() => {
    audit = createMockAuditTrail();
    paperEngine = createMockPaperEngine();
    ccxtAdapter = createMockCCXTAdapter();
    exchangeAdapters = new Map();
    exchangeAdapters.set("binance", ccxtAdapter);
  });

  it("rejects orders at the router boundary when the runtime risk policy fails", async () => {
    const router = new ExecutionRouterImpl({
      liveTradingEnabled: false,
      microLiveEnabled: false,
      requireApprovalForLive: true,
      maxMicroLiveOrderValue: 1000,
      audit,
      paperEngine,
      exchangeAdapters,
      validateOrder: vi.fn().mockResolvedValue("risk cap exceeded"),
    });

    const result = await router.execute(createOrderIntent({ mode: "paper" as TradeMode }), "paper");

    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toBe("risk cap exceeded");
    expect(paperEngine.placeOrder).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 1. should reject live trading when disabled in config
  // -----------------------------------------------------------------------
  it("should reject live trading when disabled in config", async () => {
    const router = new ExecutionRouterImpl({
      liveTradingEnabled: false,
      microLiveEnabled: false,
      requireApprovalForLive: true,
      maxMicroLiveOrderValue: 1000,
      audit,
      paperEngine,
      exchangeAdapters,
    });

    const intent = createOrderIntent({ mode: "live" as TradeMode });
    const result = await router.execute(intent, "live");

    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toContain("Live trading");
    expect(audit.record).toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 2. should route paper orders to PaperEngine and emit a learning signal
  // -----------------------------------------------------------------------
  it("should route paper orders to PaperEngine", async () => {
    const executionObserver = vi.fn().mockResolvedValue(undefined);
    const router = new ExecutionRouterImpl({
      liveTradingEnabled: false,
      microLiveEnabled: false,
      requireApprovalForLive: true,
      maxMicroLiveOrderValue: 1000,
      audit,
      paperEngine,
      exchangeAdapters,
      onExecution: executionObserver,
    });

    const intent = createOrderIntent({ mode: "paper" as TradeMode });
    const result = await router.execute(intent, "paper");

    expect(paperEngine.placeOrder).toHaveBeenCalledWith(intent);
    expect(result.status).toBe("filled");
    expect(executionObserver).toHaveBeenCalledWith(
      expect.objectContaining({
        intent,
        executionMode: "paper",
        result: expect.objectContaining({ orderId: result.orderId }),
        trade: expect.objectContaining({
          symbol: intent.symbol,
          side: intent.side,
        }),
      }),
    );
  });

  // -----------------------------------------------------------------------
  // 3. should emit a learning signal for live exchange fills
  // -----------------------------------------------------------------------
  it("should emit a learning signal for live exchange fills", async () => {
    const executionObserver = vi.fn().mockResolvedValue(undefined);
    const router = new ExecutionRouterImpl({
      liveTradingEnabled: true,
      microLiveEnabled: true,
      requireApprovalForLive: true,
      maxMicroLiveOrderValue: 10000,
      audit,
      paperEngine,
      exchangeAdapters,
      onExecution: executionObserver,
    });

    const intent = createOrderIntent({ mode: "live" as TradeMode, price: 100 });
    const token = createMockApprovalToken();
    const result = await router.execute(intent, "live", token);

    expect(result.status).toBe("filled");
    expect(token.used).toBe(true);
    expect(executionObserver).toHaveBeenCalledWith(
      expect.objectContaining({
        intent,
        executionMode: "live",
        result: expect.objectContaining({ orderId: result.orderId }),
      }),
    );
  });

  // -----------------------------------------------------------------------
  // 4. should reject orders exceeding micro-live caps
  // -----------------------------------------------------------------------
  it("should reject orders exceeding micro-live caps", async () => {
    const router = new ExecutionRouterImpl({
      liveTradingEnabled: true,
      microLiveEnabled: true,
      requireApprovalForLive: true,
      maxMicroLiveOrderValue: 1000,
      audit,
      paperEngine,
      exchangeAdapters,
    });

    // Order value = 2 * 50000 = 100000 > 1000 cap
    const intent = createOrderIntent({
      mode: "live" as TradeMode,
      quantity: 2,
      price: 50000,
    });
    const result = await router.execute(intent, "micro_live");

    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toContain("micro");
  });

  // -----------------------------------------------------------------------
  // 5. should require approval token for live orders
  // -----------------------------------------------------------------------
  it("should require approval token for live orders", async () => {
    const router = new ExecutionRouterImpl({
      liveTradingEnabled: true,
      microLiveEnabled: true,
      requireApprovalForLive: false,
      maxMicroLiveOrderValue: 10000,
      audit,
      paperEngine,
      exchangeAdapters,
    });

    const intent = createOrderIntent({ mode: "live" as TradeMode, price: 100 });
    // No approval token provided - should be rejected for live
    const result = await router.execute(intent, "live");

    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toMatch(/approval|token/i);
  });

  it("consumes live approval after one order and rejects token reuse", async () => {
    const router = new ExecutionRouterImpl({
      liveTradingEnabled: true,
      microLiveEnabled: true,
      requireApprovalForLive: false,
      maxMicroLiveOrderValue: 10000,
      audit,
      paperEngine,
      exchangeAdapters,
    });
    const token = createMockApprovalToken();
    const intent = createOrderIntent({ mode: "live" as TradeMode, price: 100 });

    const first = await router.execute(intent, "live", token);
    const second = await router.execute(intent, "live", token);

    expect(first.status).toBe("filled");
    expect(token.used).toBe(true);
    expect(second.status).toBe("rejected");
    expect(second.rejectionReason).toMatch(/one-shot|unexpired/i);
  });

  // -----------------------------------------------------------------------
  // 6. should record execution results
  // -----------------------------------------------------------------------
  it("should record execution results", async () => {
    const router = new ExecutionRouterImpl({
      liveTradingEnabled: false,
      microLiveEnabled: false,
      requireApprovalForLive: true,
      maxMicroLiveOrderValue: 1000,
      audit,
      paperEngine,
      exchangeAdapters,
    });

    const intent = createOrderIntent({ mode: "paper" as TradeMode });
    const result = await router.execute(intent, "paper");

    // Should be retrievable via getStatus
    const status = await router.getStatus(result.orderId);
    expect(status).not.toBeNull();
    expect(status!.orderId).toBe(result.orderId);
  });

  // -----------------------------------------------------------------------
  // 7. should track order status
  // -----------------------------------------------------------------------
  it("should track order status", async () => {
    const router = new ExecutionRouterImpl({
      liveTradingEnabled: false,
      microLiveEnabled: false,
      requireApprovalForLive: true,
      maxMicroLiveOrderValue: 1000,
      audit,
      paperEngine,
      exchangeAdapters,
    });

    const intent = createOrderIntent({ mode: "paper" as TradeMode });
    const result = await router.execute(intent, "paper");

    expect(result.orderId).toBeDefined();
    expect(result.timestamp).toBeInstanceOf(Date);

    const status = await router.getStatus(result.orderId);
    expect(status).not.toBeNull();
    expect(status!.status).toBe(result.status);
  });

  // -----------------------------------------------------------------------
  // 8. should cancel open orders
  // -----------------------------------------------------------------------
  it("should cancel open orders", async () => {
    const router = new ExecutionRouterImpl({
      liveTradingEnabled: true,
      microLiveEnabled: true,
      requireApprovalForLive: true,
      maxMicroLiveOrderValue: 10000,
      audit,
      paperEngine,
      exchangeAdapters,
    });

    const token = createMockApprovalToken();
    const intent = createOrderIntent({ mode: "live" as TradeMode, price: 100 });
    const result = await router.execute(intent, "live", token);

    // Cancel the order
    await router.cancel(result.orderId, intent.symbol);

    expect(ccxtAdapter.cancelOrder).toHaveBeenCalledWith({
      orderId: result.orderId,
      symbol: intent.symbol,
    });
  });

  // -----------------------------------------------------------------------
  // 9. should reject unknown venues
  // -----------------------------------------------------------------------
  it("should reject unknown venues", async () => {
    const router = new ExecutionRouterImpl({
      liveTradingEnabled: true,
      microLiveEnabled: true,
      requireApprovalForLive: true,
      maxMicroLiveOrderValue: 10000,
      audit,
      paperEngine,
      exchangeAdapters,
    });

    const intent = createOrderIntent({
      mode: "live" as TradeMode,
      venue: "unknown-exchange",
    });
    const token = createMockApprovalToken();
    const result = await router.execute(intent, "live", token);

    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toMatch(/venue|exchange|unsupported/i);
  });

  it("reconciles a submitted venue order without submitting it again", async () => {
    const fetchOrder = vi.fn().mockResolvedValue({ status: "closed", filled: 0.01, average: 50100, fee: 0.5 });
    (ccxtAdapter as unknown as { fetchOrder: typeof fetchOrder }).fetchOrder = fetchOrder;
    const router = new ExecutionRouterImpl({
      liveTradingEnabled: true,
      microLiveEnabled: true,
      requireApprovalForLive: false,
      maxMicroLiveOrderValue: 10000,
      audit,
      exchangeAdapters,
    });

    const intent = createOrderIntent({ mode: "live" as TradeMode });
    const result = await router.execute(intent, "live", createMockApprovalToken());

    expect(result.status).toBe("filled");
    expect(result.trade?.price).toBe(50100);
    expect(fetchOrder).toHaveBeenCalledWith(result.orderId, intent.symbol);
    expect(ccxtAdapter.placeOrder).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // 10. should audit all execution decisions
  // -----------------------------------------------------------------------
  it("should audit all execution decisions", async () => {
    const router = new ExecutionRouterImpl({
      liveTradingEnabled: false,
      microLiveEnabled: false,
      requireApprovalForLive: true,
      maxMicroLiveOrderValue: 1000,
      audit,
      paperEngine,
      exchangeAdapters,
    });

    const intent = createOrderIntent({ mode: "paper" as TradeMode });
    await router.execute(intent, "paper");

    // Audit should be recorded for the execution decision
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "execution",
        action: expect.stringMatching(/execute|paper|order/i),
      }),
    );
  });

  // -----------------------------------------------------------------------
  // 11. should validate mode transition
  // -----------------------------------------------------------------------
  it("should validate mode transition", async () => {
    // Config has paperTradingEnabled = false — paper orders should be rejected
    const router = new ExecutionRouterImpl({
      liveTradingEnabled: false,
      microLiveEnabled: false,
      requireApprovalForLive: true,
      maxMicroLiveOrderValue: 1000,
      paperTradingEnabled: false,
      audit,
      paperEngine,
      exchangeAdapters,
    });

    const intent = createOrderIntent({ mode: "paper" as TradeMode });
    const result = await router.execute(intent, "paper");

    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toMatch(/paper|transition|mode/i);
  });

  // Additional edge case: shadow mode returns decision without executing
  it("should not execute in shadow mode", async () => {
    const router = new ExecutionRouterImpl({
      liveTradingEnabled: false,
      microLiveEnabled: false,
      requireApprovalForLive: true,
      maxMicroLiveOrderValue: 1000,
      audit,
      paperEngine,
      exchangeAdapters,
    });

    const intent = createOrderIntent({ mode: "paper" as TradeMode });
    const result = await router.execute(intent, "shadow");

    expect(result.status).toBe("filled");
    expect(paperEngine.placeOrder).not.toHaveBeenCalled();
    expect(ccxtAdapter.placeOrder).not.toHaveBeenCalled();
  });
});
