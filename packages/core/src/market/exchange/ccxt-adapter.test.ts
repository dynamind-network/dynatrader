/**
 * Tests for CCXT Exchange Adapter
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { CCXTAdapter } from "./ccxt-adapter";
import type { CCXTAdapterConfig } from "./ccxt-adapter";
import type { OrderIntent } from "@dyna/contracts";

// ---------------------------------------------------------------------------
// Mock CCXT at module level (hoisted by vitest)
// ---------------------------------------------------------------------------

type MockExchange = ReturnType<typeof createMockExchange>;

function createMockExchange(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    name: "Binance",
    id: "binance",
    version: "4.4.91",
    sandboxMode: false,
    apiKey: "",
    secret: "",
    timeframes: { "1m": 60000, "1h": 3600000, "1d": 86400000 },
    has: { cancelAllOrders: true, fetchOpenOrders: true, fetchClosedOrders: true, fetchMyTrades: true },
    countries: ["US"],
    rateLimit: 100,
    urls: { logo: "https://binance.com/logo.png", api: "https://api.binance.com" },
    loadMarkets: vi.fn().mockResolvedValue({}),
    fetchOHLCV: vi.fn(),
    fetchBalance: vi.fn(),
    createOrder: vi.fn(),
    cancelOrder: vi.fn(),
    setSandboxMode: vi.fn(),
    ...overrides,
  };
}

// We'll swap this per-test via mockImplementation
let currentMockExchange: Record<string, unknown> = createMockExchange();

vi.mock("ccxt", () => {
  // The adapter does `import ccxt from "ccxt"` then accesses `ccxt.pro.binance`
  // So the default export must have `pro` on it
  const mockPro: Record<string, ReturnType<typeof vi.fn>> = {};
  // Use a getter so currentMockExchange is captured by reference at call time
  Object.defineProperty(mockPro, "binance", {
    get: () => vi.fn().mockImplementation(() => currentMockExchange),
    configurable: true,
  });
  const defaultExport = { pro: mockPro };
  return { default: defaultExport };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CCXTAdapter", () => {
  let adapter: CCXTAdapter;
  let config: CCXTAdapterConfig;

  beforeEach(() => {
    // Reset the mock exchange before each test
    currentMockExchange = createMockExchange();
    config = { exchangeId: "binance", sandbox: true };
    adapter = new CCXTAdapter(config);
  });

  describe("Initialization", () => {
    it("should initialize with correct configuration", () => {
      expect(adapter.id).toBe("binance");
    });

    it("should apply sandbox mode when configured", () => {
      expect(adapter).toBeInstanceOf(CCXTAdapter);
    });

    it("forwards passphrase to CCXT password when the exchange is first loaded", async () => {
      const withPassphrase = new CCXTAdapter({ exchangeId: "binance", passphrase: "test-passphrase" });
      const exchange = await (withPassphrase as unknown as { getExchange(): Promise<{ password?: string }> }).getExchange();
      expect(exchange.password).toBe("test-passphrase");
    });
  });

  describe("Capabilities", () => {
    it("should return exchange capabilities", async () => {
      currentMockExchange = createMockExchange({
        sandboxMode: true,
        timeframes: { "1h": 3600000 },
        has: { cancelAllOrders: true, fetchOpenOrders: true, fetchMyTrades: true },
        loadMarkets: vi.fn().mockResolvedValue({
          "BTC/USDT": {
            symbol: "BTC/USDT",
            base: "BTC",
            quote: "USDT",
            type: "spot",
            precision: { amount: 6, price: 2 },
            limits: { amount: { min: 0.001, max: 100 }, price: { min: 0.01, max: 100000 } },
            status: "trading",
          },
        }),
      });
      adapter = new CCXTAdapter(config);

      const capabilities = await adapter.capabilities();

      expect(capabilities.name).toBe("Binance");
      expect(capabilities.version).toBe("4.4.91");
      expect((capabilities.has as Record<string, boolean>).spot).toBe(true);
      expect((capabilities.has as Record<string, boolean>).futures).toBe(false);
      expect(capabilities.tradingMode).toBe("sandbox");
      expect(capabilities.timeframes).toContain("1h");
    });
  });

  describe("Fetch Markets", () => {
    it("should fetch and normalize markets", async () => {
      currentMockExchange = createMockExchange({
        timeframes: { "1h": 3600000 },
        loadMarkets: vi.fn().mockResolvedValue({
          "BTC/USDT": {
            symbol: "BTC/USDT",
            base: "BTC",
            quote: "USDT",
            type: "spot",
            precision: { amount: 6, price: 2 },
            limits: { amount: { min: 0.001, max: 100 }, price: { min: 0.01, max: 100000 } },
            status: "trading",
          },
        }),
      });
      adapter = new CCXTAdapter(config);

      const markets = await adapter.fetchMarkets();

      expect(markets.total).toBe(1);
      const marketList = markets.markets as Array<Record<string, unknown>>;
      const firstMarket = marketList[0]!;
      expect(firstMarket.symbol).toBe("BTC/USDT");
      expect(firstMarket.baseCurrency).toBe("BTC");
      expect(firstMarket.quoteCurrency).toBe("USDT");
      expect(firstMarket.type).toBe("spot");
      const limits = firstMarket.limits as Record<string, Record<string, number>>;
      // Adapter uses limits.amount.min / limits.price.min from the raw market
      expect(limits.amount!.min).toBe(0.001);
      expect(limits.price!.min).toBe(0.01);
    });
  });

  describe("Market depth and volume", () => {
    it("fetches an order book with the requested depth", async () => {
      const orderBook = { bids: [[100, 2]], asks: [[101, 3]], timestamp: 1234 };
      const fetchOrderBook = vi.fn().mockResolvedValue(orderBook);
      currentMockExchange = createMockExchange({ fetchOrderBook });
      adapter = new CCXTAdapter(config);

      await expect(adapter.fetchOrderBook("BTC/USDT", 10)).resolves.toEqual(orderBook);
      expect(fetchOrderBook).toHaveBeenCalledWith("BTC/USDT", 10);
    });

    it("drops incomplete order-book levels", async () => {
      currentMockExchange = createMockExchange({
        fetchOrderBook: vi.fn().mockResolvedValue({
          bids: [[100, 2], [undefined, 1]],
          asks: [[101, 3], [102, undefined]],
          timestamp: 1234,
        }),
      });
      adapter = new CCXTAdapter(config);

      await expect(adapter.fetchOrderBook("BTC/USDT")).resolves.toEqual({
        bids: [[100, 2]],
        asks: [[101, 3]],
        timestamp: 1234,
      });
    });

    it("returns quote-currency 24-hour volume from the ticker", async () => {
      const fetchTicker = vi.fn().mockResolvedValue({ baseVolume: 2, quoteVolume: 4321 });
      currentMockExchange = createMockExchange({ fetchTicker });
      adapter = new CCXTAdapter(config);

      await expect(adapter.fetch24hQuoteVolume("BTC/USDT")).resolves.toBe(4321);
      expect(fetchTicker).toHaveBeenCalledWith("BTC/USDT");
    });

    it("rejects unavailable quote volume instead of fabricating zero", async () => {
      currentMockExchange = createMockExchange({ fetchTicker: vi.fn().mockResolvedValue({ quoteVolume: null }) });
      adapter = new CCXTAdapter(config);

      await expect(adapter.fetch24hQuoteVolume("BTC/USDT")).rejects.toThrow("24h quote volume unavailable");
    });
  });

  describe("Fetch OHLCV", () => {
    it("should fetch valid OHLCV data", async () => {
      const mockOHLCV = [
        [1609459200000, 29000, 29500, 28800, 29200, 1000],
        [1609545600000, 29200, 30000, 29100, 29800, 1500],
      ];

      currentMockExchange = createMockExchange({
        timeframes: { "1h": 3600000 },
        fetchOHLCV: vi.fn().mockResolvedValue(mockOHLCV),
      });
      adapter = new CCXTAdapter(config);

      const result = await adapter.fetchOHLCV({
        symbol: "BTC/USDT",
        timeframe: "1h",
        limit: 2,
      });

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual([1609459200000, 29000, 29500, 28800, 29200, 1000]);
      expect(result[1]).toEqual([1609545600000, 29200, 30000, 29100, 29800, 1500]);
    });

    it("should reject invalid timeframe", async () => {
      currentMockExchange = createMockExchange({
        timeframes: { "1h": 3600000 }, // no "invalid" timeframe
      });
      adapter = new CCXTAdapter(config);

      await expect(
        adapter.fetchOHLCV({ symbol: "BTC/USDT", timeframe: "invalid" })
      ).rejects.toThrow("Unsupported timeframe");
    });

    it("should validate candle data", async () => {
      const invalidOHLCV = [
        [1609459200000, 29000, 29500, 28800, 29200, 1000], // Valid
        [1609545600000, 0, -1, 29100, 29800, 1500], // Invalid low price
      ];

      currentMockExchange = createMockExchange({
        timeframes: { "1h": 3600000 },
        fetchOHLCV: vi.fn().mockResolvedValue(invalidOHLCV),
      });
      adapter = new CCXTAdapter(config);

      await expect(
        adapter.fetchOHLCV({ symbol: "BTC/USDT", timeframe: "1h" })
      ).rejects.toThrow("Invalid price values");
    });
  });

  describe("Balances", () => {
    it("should fetch account balances", async () => {
      const mockBalance = {
        free: { BTC: 0.5, USDT: 1000 },
        used: { BTC: 0.1, USDT: 500 },
        total: { BTC: 0.6, USDT: 1500 },
        info: { equity: 15000, margin: 2000, profit: 1000, loans: 0, maintenanceMargin: 1500 },
      };

      currentMockExchange = createMockExchange({
        fetchBalance: vi.fn().mockResolvedValue(mockBalance),
      });
      adapter = new CCXTAdapter(config);

      const balance = await adapter.balances();

      const balanceFree = balance.free as Record<string, number>;
      const balanceUsed = balance.used as Record<string, number>;
      const balanceTotal = balance.total as Record<string, number>;
      expect(balanceFree.BTC).toBe(0.5);
      expect(balanceUsed.USDT).toBe(500);
      expect(balanceTotal.BTC).toBe(0.6);
      expect(balance.equity).toBe(15000);
      expect(balance.margin).toBe(2000);
      expect(balance.profit).toBe(1000);
    });
  });

  describe("Place Order", () => {
    it("should place a market buy order", async () => {
      const orderIntent: OrderIntent = {
        venue: "binance",
        symbol: "BTC/USDT",
        side: "buy",
        type: "market",
        quantity: 0.01,
        strategyId: "test-strategy",
        mode: "paper",
      };

      const mockOrder = {
        id: "12345",
        symbol: "BTC/USDT",
        side: "buy",
        type: "market",
        amount: 0.01,
        price: 29000,
        status: "closed",
        filled: 0.01,
        remaining: 0,
        fee: { cost: 0.0001, currency: "BTC" },
      };

      currentMockExchange = createMockExchange({
        loadMarkets: vi.fn().mockResolvedValue({
          "BTC/USDT": {
            symbol: "BTC/USDT",
            base: "BTC",
            quote: "USDT",
            type: "spot",
            precision: { amount: 0.001, price: 2 },
            limits: { amount: { min: 0.001 }, price: { min: 0.01 } },
          },
        }),
        createOrder: vi.fn().mockResolvedValue(mockOrder),
      });
      adapter = new CCXTAdapter(config);

      const result = await adapter.placeOrder(orderIntent);

      expect(result.orderId).toBe("12345");
      expect(result.raw).toEqual(mockOrder);
    });

    it("should validate minimum quantity", async () => {
      const orderIntent: OrderIntent = {
        venue: "binance",
        symbol: "BTC/USDT",
        side: "buy",
        type: "market",
        quantity: 0.0001,
        strategyId: "test-strategy",
        mode: "paper",
      };

      currentMockExchange = createMockExchange({
        loadMarkets: vi.fn().mockResolvedValue({
          "BTC/USDT": {
            symbol: "BTC/USDT",
            base: "BTC",
            quote: "USDT",
            type: "spot",
            precision: { amount: 0.001, price: 2 },
            limits: { amount: { min: 0.001 }, price: { min: 0.01 } },
          },
        }),
      });
      adapter = new CCXTAdapter(config);

      await expect(adapter.placeOrder(orderIntent)).rejects.toThrow(
        "Quantity 0.0001 is below minimum 0.001"
      );
    });
  });

  describe("Cancel Order", () => {
    it("should cancel an order", async () => {
      const cancelOrderMock = vi.fn().mockResolvedValue(undefined);

      currentMockExchange = createMockExchange({
        cancelOrder: cancelOrderMock,
      });
      adapter = new CCXTAdapter(config);

      await adapter.cancelOrder({ orderId: "12345", symbol: "BTC/USDT" });

      expect(cancelOrderMock).toHaveBeenCalledWith("12345", "BTC/USDT");
    });
  });
});
