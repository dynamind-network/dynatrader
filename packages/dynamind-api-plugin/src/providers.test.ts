import { afterEach, describe, expect, it, vi } from "vitest";
import { createBacktestProvider } from "./backtest.js";
import { createDeFiProvider } from "./defi.js";
import { createMacroProvider } from "./macro.js";
import { createMarketDataProvider } from "./market-data.js";
import { createNewsProvider } from "./news.js";
import { createRiskProvider } from "./risk.js";
import { createSignalProvider } from "./signals.js";

afterEach(() => vi.unstubAllGlobals());

const config = { baseUrl: "https://api.example.test", apiKey: "test-key" };

describe("DynaMind provider response envelopes", () => {
  it("maps a wrapped market-data response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true, data: { price: 42 } })));
    await expect(createMarketDataProvider(config).getPrice("BTC/USD")).resolves.toBe(42);
  });

  it("maps a wrapped news response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: { news: [{
      title: "Headline", url: "https://news.test", source: "wire", published_at: "2026-01-01",
    }] } })));
    await expect(createNewsProvider(config).getNews()).resolves.toMatchObject([{ title: "Headline", source: "wire" }]);
  });

  it("maps a wrapped signal response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: { signal: {
      symbol: "BTC/USD", direction: "long", tier: "STRONG", confidence: 0.9,
      rationale: "test", timeframe: "1h", timestamp: "now",
    } } })));
    await expect(createSignalProvider(config).getSignal("BTC/USD"))
      .resolves.toMatchObject({ symbol: "BTC/USD", direction: "long", confidence: 0.9 });
  });

  it("maps wrapped macro, DeFi, risk, and backtest responses", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: { events: [{ date: "today", title: "CPI", impact: "high", currency: "USD" }] } }))
      .mockResolvedValueOnce(Response.json({ data: { chains: [{ id: 1, name: "Ethereum", tvl: 10, change_24h: 2 }] } }))
      .mockResolvedValueOnce(Response.json({ data: { approved: true, reason: "ok", reductions: [], mandatory_reasoning: "checked" } }))
      .mockResolvedValueOnce(Response.json({ data: { strategies: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createMacroProvider(config).getCalendar()).resolves.toMatchObject([{ title: "CPI", impact: "high" }]);
    await expect(createDeFiProvider(config).getChains()).resolves.toMatchObject([{ name: "Ethereum", change24h: 2 }]);
    await expect(createRiskProvider(config).evaluateTrade({} as never)).resolves.toMatchObject({ approved: true, mandatoryReasoning: "checked" });
    await expect(createBacktestProvider(config).listStrategies()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("preserves risk provider's local fallback on transport errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    const result = await createRiskProvider(config).evaluateTrade({
      proposedTradePct: 20, kellyPct: 1, regime: "normal", dailyLoss: 0,
      portfolioValue: 100, currentPositions: {},
    } as never);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("exceeds 10% max");
  });
});
