import { afterEach, describe, it, expect, vi } from "vitest";
import { HyperliquidAdapter, normalizeTimeframe, toHyperliquidSymbol } from "./hyperliquid-adapter";
import type { HyperliquidActionSigner } from "./hyperliquid-signer-provider";

const READ_ONLY_CONFIG = {
  walletAddress: "0x0000000000000000000000000000000000000001",
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("HyperliquidAdapter", () => {
  describe("construction", () => {
    it("requires a wallet address", () => {
      expect(() => new HyperliquidAdapter({} as never)).toThrow(/walletAddress/);
    });

    it("exposes id hyperliquid", () => {
      const adapter = new HyperliquidAdapter(READ_ONLY_CONFIG);
      expect(adapter.id).toBe("hyperliquid");
    });

    it("reports read-only when no signer", async () => {
      const caps = await new HyperliquidAdapter(READ_ONLY_CONFIG).capabilities();
      expect(caps.tradingMode).toBe("read-only");
      expect(caps.orders).toBe(false);
    });

    it("reports live-capable only when an injected signer exists", async () => {
      const signer: HyperliquidActionSigner = { signAction: vi.fn(async () => ({ r: "0x1", s: "0x2", v: 27 })) };
      const caps = await new HyperliquidAdapter({ ...READ_ONLY_CONFIG, signer, network: "mainnet" }).capabilities();
      expect(caps.tradingMode).toBe("live-capable");
      expect(caps.orders).toBe(true);
    });

    it("requires an explicit network for signing with the default mainnet endpoint", () => {
      const signer: HyperliquidActionSigner = { signAction: vi.fn() };
      expect(() => new HyperliquidAdapter({ ...READ_ONLY_CONFIG, signer })).toThrow(/explicit network/);
    });

    it("requires explicit network with custom REST URL", () => {
      const signer: HyperliquidActionSigner = { signAction: vi.fn() };
      expect(() => new HyperliquidAdapter({ ...READ_ONLY_CONFIG, signer, restUrl: "https://hl.internal" })).toThrow(/network/);
    });

    it.each([
      ["https://api.hyperliquid.xyz", "testnet"],
      ["https://api.hyperliquid-testnet.xyz", "mainnet"],
    ] as const)("rejects contradictory endpoint/network %s %s", (restUrl, network) => {
      const signer: HyperliquidActionSigner = { signAction: vi.fn() };
      expect(() => new HyperliquidAdapter({ ...READ_ONLY_CONFIG, signer, restUrl, network })).toThrow(/conflicts/);
    });
  });

  describe("placeOrder guards", () => {
    it("rejects order placement without an injected signer", async () => {
      const adapter = new HyperliquidAdapter(READ_ONLY_CONFIG);
      const intent = {
        venue: "hyperliquid", symbol: "BTC/USDC", side: "buy" as const,
        type: "limit" as const, quantity: 0.01, price: 50000,
        strategyId: "test", mode: "paper" as const,
      };
      await expect(adapter.placeOrder(intent)).rejects.toThrow(/signer/);
    });
  });
  describe("signer boundary", () => {
    it("signs and submits placeOrder and cancelOrder actions with deterministic nonces", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2025-01-02T03:04:05.000Z"));
      const nonce = Date.now();
      const signature = { r: "0xabc", s: "0xdef", v: 27 };
      const signAction = vi.fn(async () => signature);
      const signer: HyperliquidActionSigner = { signAction };
      const payloads: Array<Record<string, any>> = [];
      globalThis.fetch = vi.fn(async (input, init) => {
        if (String(input).endsWith("/info")) {
          return new Response(JSON.stringify({ universe: [{ name: "BTC" }] }), { status: 200 });
        }
        payloads.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ status: "ok", response: { data: { statuses: [{ resting: { oid: 123 } }] } } }), { status: 200 });
      }) as unknown as typeof fetch;
      const adapter = new HyperliquidAdapter({ ...READ_ONLY_CONFIG, signer, network: "testnet" });
      const intent = {
        venue: "hyperliquid", symbol: "BTC/USDC", side: "buy" as const,
        type: "limit" as const, quantity: 0.01, price: 50000,
        strategyId: "test", mode: "paper" as const,
      };
      await expect(adapter.placeOrder(intent)).resolves.toMatchObject({ orderId: "123" });
      await adapter.cancelOrder({ orderId: "123", symbol: "BTC/USDC" });
      const orderAction = { type: "order", orders: [{ a: 0, b: true, p: "50000", s: "0.01", r: false, t: { limit: { tif: "Gtc" } } }], grouping: "na" };
      const cancelAction = { type: "cancel", cancels: [{ a: 0, o: 123 }] };
      expect(signAction).toHaveBeenNthCalledWith(1, orderAction, nonce);
      expect(signAction).toHaveBeenNthCalledWith(2, cancelAction, nonce);
      expect(payloads).toEqual([
        { action: orderAction, nonce, signature },
        { action: cancelAction, nonce, signature },
      ]);
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
