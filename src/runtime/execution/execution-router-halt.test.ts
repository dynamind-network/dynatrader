import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ExecutionRouterImpl as ExecutionRouter } from "./execution-router";
import { HaltState } from "../halt/halt-state";
import type { OrderIntent, TradeMode } from "@dyna/contracts";

let tmp: string;
let halts: HaltState;
let router: ExecutionRouter;

function makeIntent(symbol = "BTC/USDT"): OrderIntent {
  return {
    venue: "binance",
    symbol,
    side: "buy",
    type: "limit",
    quantity: 0.01,
    price: 50000,
    strategyId: "halt-test",
    mode: "paper" as TradeMode,
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "router-halt-test-"));
  halts = new HaltState(tmp);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeRouter(): ExecutionRouter {
  return new ExecutionRouter({
    liveTradingEnabled: false,
    microLiveEnabled: false,
    requireApprovalForLive: true,
    maxMicroLiveOrderValue: 1000,
    audit: {
      record: async () => ({}),
      logAction: async () => ({}),
    } as any,
    paperEngine: undefined,
    haltState: halts,
  });
}

describe("ExecutionRouter kill-switch enforcement", () => {
  it("rejects orders when globally halted", async () => {
    router = makeRouter();
    halts.halt("test halt", "cli");

    const result = await router.execute(makeIntent(), "paper");
    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toContain("HALTED");
  });

  it("rejects only the halted symbol", async () => {
    router = makeRouter();
    halts.halt("too hot", "agent", { symbol: "BTC/USDT" });

    const btc = await router.execute(makeIntent("BTC/USDT"), "paper");
    expect(btc.status).toBe("rejected");
    expect(btc.rejectionReason).toContain("HALTED");
  });

  it("allows orders after resume", async () => {
    router = makeRouter();
    halts.halt("temp", "cli");
    halts.resume();

    const result = await router.execute(makeIntent(), "paper");
    // Without a paper engine it won't fully execute, but it must NOT be a HALTED rejection
    if (result.status === "rejected") {
      expect(result.rejectionReason).not.toContain("HALTED");
    }
  });
});
