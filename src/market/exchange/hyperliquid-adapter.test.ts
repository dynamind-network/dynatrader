import { describe, it, expect } from "vitest";
import { HyperliquidAdapter, normalizeTimeframe, toHyperliquidSymbol } from "./hyperliquid-adapter";

const READ_ONLY_CONFIG = {
  walletAddress: "0x0000000000000000000000000000000000000001",
};

describe("HyperliquidAdapter", () => {
  describe("construction", () => {
    it("requires a wallet address", () => {
      expect(() => new HyperliquidAdapter({} as never)).toThrow(/walletAddress/);
    });

    it("exposes id hyperliquid", () => {
      const adapter = new HyperliquidAdapter(READ_ONLY_CONFIG);
      expect(adapter.id).toBe("hyperliquid");
    });

    it("reports read-only when no private key", async () => {
      const caps = await new HyperliquidAdapter(READ_ONLY_CONFIG).capabilities();
      expect(caps.tradingMode).toBe("read-only");
      expect(caps.orders).toBe(false);
    });

    it("reports live-capable with a private key", async () => {
      const caps = await new HyperliquidAdapter({
        ...READ_ONLY_CONFIG,
        privateKey: "aa".repeat(32),
      }).capabilities();
      expect(caps.tradingMode).toBe("live-capable");
      expect(caps.orders).toBe(true);
    });
  });

  describe("placeOrder guards", () => {
    it("rejects order placement without a signing key", async () => {
      const adapter = new HyperliquidAdapter(READ_ONLY_CONFIG);
      const intent = {
        venue: "hyperliquid",
        symbol: "BTC/USDC",
        side: "buy" as const,
        type: "limit" as const,
        quantity: 0.01,
        price: 50000,
        strategyId: "test",
        mode: "paper" as const,
      };
      await expect(adapter.placeOrder(intent)).rejects.toThrow(/privateKey/);
    });
  });
});

describe("normalizeTimeframe", () => {
  it("passes through supported minute intervals", () => {
    expect(normalizeTimeframe("5m")).toBe("5m");
    expect(normalizeTimeframe("15m")).toBe("15m");
  });

  it("snaps unsupported minutes to nearest supported (floor)", () => {
    expect(normalizeTimeframe("7m")).toBe("5m");
    expect(normalizeTimeframe("45m")).toBe("30m");
    expect(normalizeTimeframe("2m")).toBe("1m");
  });

  it("maps hours correctly", () => {
    expect(normalizeTimeframe("4h")).toBe("4h");
    expect(normalizeTimeframe("7h")).toBe("6h");
    expect(normalizeTimeframe("10h")).toBe("8h");
  });

  it("handles day and week", () => {
    expect(normalizeTimeframe("1d")).toBe("1d");
    expect(normalizeTimeframe("1w")).toBe("1w");
  });

  it("falls back to 1h for garbage", () => {
    expect(normalizeTimeframe("nonsense")).toBe("1h");
  });
});

describe("toHyperliquidSymbol", () => {
  it("strips quote currency for perps", () => {
    expect(toHyperliquidSymbol("BTC/USDC")).toBe("BTC");
    expect(toHyperliquidSymbol("eth/usdt")).toBe("ETH");
  });
});
