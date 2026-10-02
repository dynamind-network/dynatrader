import { describe, expect, it, vi } from "vitest";
import type { AuditTrail } from "@dyna/audit";
import type { ExchangeAdapter, OrderIntent } from "@dyna/contracts";
import { ExecutionRouterImpl } from "./execution-router";

function exchange(id: string): ExchangeAdapter {
  return {
    id,
    capabilities: vi.fn().mockResolvedValue({}),
    fetchMarkets: vi.fn().mockResolvedValue({}),
    fetchOHLCV: vi.fn().mockResolvedValue([]),
    balances: vi.fn().mockResolvedValue({}),
    placeOrder: vi.fn().mockResolvedValue({ orderId: `${id}-order` }),
    cancelOrder: vi.fn().mockResolvedValue(undefined),
  };
}

describe("ExecutionRouterImpl venue cancellation", () => {
  it("cancels through the venue that accepted the order", async () => {
    const firstVenue = exchange("binance");
    const targetVenue = exchange("kraken");
    const audit = { record: vi.fn().mockResolvedValue(undefined) } as unknown as AuditTrail;
    const router = new ExecutionRouterImpl({
      liveTradingEnabled: true,
      microLiveEnabled: true,
      requireApprovalForLive: false,
      maxMicroLiveOrderValue: 10_000,
      audit,
      exchangeAdapters: new Map([
        [firstVenue.id, firstVenue],
        [targetVenue.id, targetVenue],
      ]),
    });
    const intent: OrderIntent = {
      venue: targetVenue.id,
      symbol: "ETH/USDT",
      side: "buy",
      type: "market",
      quantity: 1,
      strategyId: "test",
      mode: "live",
    };

    const result = await router.execute(intent, "live", {
      id: "approval-1",
      approvalRequestId: "request-1",
      approvedBy: "test-user",
      channel: "test",
      action: "execute_live_order",
      artifactType: "OrderIntent",
      artifactHash: "test-intent-hash",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      singleUse: true,
      used: false,
      signature: "test-signature",
    });
    await router.cancel(result.orderId, intent.symbol);

    expect(targetVenue.cancelOrder).toHaveBeenCalledWith({ orderId: result.orderId, symbol: intent.symbol });
    expect(firstVenue.cancelOrder).not.toHaveBeenCalled();
  });
});
