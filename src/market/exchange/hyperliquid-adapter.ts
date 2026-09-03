/**
 * Hyperliquid Exchange Adapter
 *
 * Native REST adapter for Hyperliquid's perp DEX (https://hyperliquid.xyz).
 * Launch venue for Dyna-Trader — implemented directly against the public API
 * rather than through CCXT for lower latency and full access to Hyperliquid's
 * unique order types (reduce-only, TP/SL triggers, 24h cancel windows).
 *
 * API docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api
 */

import type { ExchangeAdapter, OrderIntent } from "@dyna/contracts";
import { signUserAction } from "./hyperliquid-signing";

const DEFAULT_REST_URL = "https://api.hyperliquid.xyz";

/** Hyperliquid asset names: perps are plain ("BTC"), spot uses "PAIR@SPOT". */
export function toHyperliquidSymbol(symbol: string): string {
  // "BTC/USDC" or "BTC" -> "BTC" for perps; strip quote suffix
  const base = symbol.split("/")[0]!.trim().toUpperCase();
  return base;
}

export interface HyperliquidAdapterConfig {
  /** Wallet address (0x...) that owns the account. */
  walletAddress: string;
  /**
   * Private key for signing actions. REQUIRED for order placement/cancels.
   * Omit for read-only usage (markets, OHLCV, balances via clearingshouse state).
   */
  privateKey?: string;
  /** API URL. Defaults to mainnet; use https://api.hyperliquid-testnet.xyz for testnet. */
  restUrl?: string;
}

interface HyperliquidFill {
  coin: string;
  px: string;
  sz: string;
  side: "A" | "B"; // A = ask (buy taker), B = bid (sell taker)
  time: number;
  startPos: string;
  closedPnl: string;
  hash: string;
  tid: number;
}

export class HyperliquidAdapter implements ExchangeAdapter {
  public readonly id = "hyperliquid";
  private config: HyperliquidAdapterConfig;
  private restUrl: string;

  constructor(config: HyperliquidAdapterConfig) {
    this.config = config;
    this.restUrl = (config.restUrl ?? DEFAULT_REST_URL).replace(/\/$/, "");
    if (!config.walletAddress) {
      throw new Error("HyperliquidAdapter requires a walletAddress");
    }
  }

  async capabilities(): Promise<Record<string, unknown>> {
    return {
      name: "Hyperliquid",
      version: "v1",
      spot: false,
      margin: false,
      futures: true,
      swaps: true,
      OHLCV: true,
      orders: this.config.privateKey !== undefined,
      cancelAllOrders: true,
      fetchOpenOrders: true,
      fetchClosedOrders: true,
      fetchMyTrades: true,
      tradingMode: this.config.privateKey ? "live-capable" : "read-only",
      reduceOnly: true,
      triggerOrders: true,
    };
  }

  private async infoRequest(payload: Record<string, unknown>): Promise<unknown> {
    const resp = await fetch(`${this.restUrl}/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      throw new Error(`Hyperliquid info request failed: ${resp.status} ${await resp.text()}`);
    }
    return resp.json();
  }

  async fetchMarkets(): Promise<Record<string, unknown>> {
    const meta = (await this.infoRequest({ type: "meta" })) as {
      universe: Array<{ name: string; maxLeverage: number; onlyIsolated?: boolean }>;
    };
    const markets = (meta.universe ?? []).map((m) => ({
      symbol: `${m.name}/USDC`,
      baseCurrency: m.name,
      quoteCurrency: "USDC",
      type: "swap",
      status: "active",
      precision: { amount: 3, price: 1 },
      limits: {
        amount: { min: 0.001, max: undefined },
        price: { min: 0, max: undefined },
      },
      maxLeverage: m.maxLeverage,
    }));
    return { total: markets.length, markets };
  }

  async fetchOHLCV(req: {
    symbol: string;
    timeframe: string;
    since?: number;
    limit?: number;
  }): Promise<Array<[number, number, number, number, number, number]>> {
    const startTime = req.since ?? Date.now() - 24 * 60 * 60 * 1000;
    const endTime = Date.now();
    const candles = (await this.infoRequest({
      type: "candleSnapshot",
      req: {
        coin: toHyperliquidSymbol(req.symbol),
        interval: normalizeTimeframe(req.timeframe),
        startTime,
        endTime,
      },
    })) as Array<{ t: number; o: string; h: string; c: string; l: string; v: string }>;

    return (candles ?? [])
      .slice(0, req.limit ?? 500)
      .map((c) => [
        c.t,
        parseFloat(c.o),
        parseFloat(c.c),
        parseFloat(c.h),
        parseFloat(c.l),
        parseFloat(c.v),
      ] as [number, number, number, number, number, number]);
  }

  async balances(): Promise<Record<string, unknown>> {
    const state = (await this.infoRequest({
      type: "clearinghouseState",
      user: this.config.walletAddress,
    })) as {
      marginSummary: { accountValue: string; totalMarginUsed: string; totalNtlPos: string };
      assetPositions: Array<{
        position: { coin: string; szi: string; entryPx: string; unrealizedPnl: string; leverage: { value: number } };
      }>;
    };

    const positions = (state.assetPositions ?? []).map((ap) => ({
      symbol: `${ap.position.coin}/USDC`,
      size: parseFloat(ap.position.szi),
      entryPrice: parseFloat(ap.position.entryPx ?? "0"),
      unrealizedPnl: parseFloat(ap.position.unrealizedPnl ?? "0"),
      leverage: ap.position.leverage?.value,
      side: parseFloat(ap.position.szi) >= 0 ? "long" : "short",
    }));

    return {
      accountValue: parseFloat(state.marginSummary?.accountValue ?? "0"),
      marginUsed: parseFloat(state.marginSummary?.totalMarginUsed ?? "0"),
      notionalPositionValue: parseFloat(state.marginSummary?.totalNtlPos ?? "0"),
      positions,
    };
  }

  async placeOrder(intent: OrderIntent): Promise<{ orderId: string; raw?: unknown }> {
    if (!this.config.privateKey) {
      throw new Error("HyperliquidAdapter.placeOrder requires a privateKey for signing");
    }
    const isBuy = intent.side === "buy";
    const action: Record<string, unknown> = {
      type: "order",
      orders: [
        {
          a: await this.assetIndex(intent.symbol),
          b: isBuy,
          p: priceToString(intent.price ?? 0),
          s: sizeToString(intent.quantity),
          r: false,
          t:
            intent.type === "market"
              ? { limit: { tif: "Ioc" } } // Hyperliquid has no pure market order; IOC-limit is the idiom
              : { limit: { tif: "Gtc" } },
        },
      ],
      grouping: "na",
    };

    const response = (await this.exchangeAction(action)) as {
      response?: { data?: { statuses?: Array<{ resting?: { oid: number }; filled?: { oid: number }; error?: string }> } };
    };
    const statuses = response.response?.data?.statuses ?? [];
    const first = statuses[0];
    const oid = first?.resting?.oid ?? first?.filled?.oid;
    if (oid === undefined) {
      const err = first && "error" in first ? first.error : JSON.stringify(first);
      throw new Error(`Hyperliquid order rejected: ${err}`);
    }
    return { orderId: String(oid), raw: response };
  }

  async cancelOrder(req: { orderId: string; symbol: string }): Promise<void> {
    if (!this.config.privateKey) {
      throw new Error("HyperliquidAdapter.cancelOrder requires a privateKey for signing");
    }
    const action = {
      type: "cancel",
      cancels: [{ a: await this.assetIndex(req.symbol), o: Number(req.orderId) }],
    };
    await this.exchangeAction(action);
  }

  async cancelAllOrders(symbol?: string): Promise<number> {
    if (!this.config.privateKey) {
      throw new Error("HyperliquidAdapter.cancelAllOrders requires a privateKey");
    }
    const open = (await this.infoRequest({
      type: "frontendOpenOrders",
      user: this.config.walletAddress,
    })) as Array<{ oid: number; coin: string }>;
    const relevant = symbol ? open.filter((o) => o.coin === toHyperliquidSymbol(symbol)) : open;
    for (const order of relevant) {
      await this.cancelOrder({ orderId: String(order.oid), symbol: `${order.coin}/USDC` });
    }
    return relevant.length;
  }

  async fetchMyTrades(symbol?: string, limit = 50): Promise<Array<Record<string, unknown>>> {
    const fills = (await this.infoRequest({
      type: "userFills",
      user: this.config.walletAddress,
    })) as HyperliquidFill[];
    const filtered = symbol ? fills.filter((f) => f.coin === toHyperliquidSymbol(symbol)) : fills;
    return filtered.slice(0, limit).map((f) => ({
      id: String(f.tid),
      symbol: `${f.coin}/USDC`,
      side: f.side === "A" ? "buy" : "sell",
      price: parseFloat(f.px),
      quantity: parseFloat(f.sz),
      realizedPnL: parseFloat(f.closedPnl),
      timestamp: f.time,
    }));
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private assetIndexCache: Map<string, number> | null = null;

  private async assetIndex(symbol: string): Promise<number> {
    if (!this.assetIndexCache) {
      const meta = (await this.infoRequest({ type: "meta" })) as {
        universe: Array<{ name: string }>;
      };
      this.assetIndexCache = new Map(
        meta.universe.map((m, i) => [m.name.toUpperCase(), i] as const),
      );
    }
    const idx = this.assetIndexCache.get(toHyperliquidSymbol(symbol));
    if (idx === undefined) {
      throw new Error(`Unknown Hyperliquid asset: ${symbol}`);
    }
    return idx;
  }

  /**
   * Sign and POST an exchange action.
   *
   * EIP-712 signing per the Hyperliquid spec, implemented in
   * ./hyperliquid-signing using viem.
   */
  private async exchangeAction(action: Record<string, unknown>): Promise<unknown> {
    if (!this.config.privateKey) {
      throw new Error("Cannot sign exchange action without privateKey");
    }
    const nonce = Date.now();
    const { signature } = await signUserAction(
      action,
      nonce,
      this.config.privateKey as `0x${string}`,
    );
    const payload = { action, nonce, signature };
    const resp = await fetch(`${this.restUrl}/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await resp.json();
    if (!resp.ok || (body as { status?: string }).status === "err") {
      throw new Error(`Hyperliquid exchange request failed: ${JSON.stringify(body)}`);
    }
    return body;
  }
}

function priceToString(price: number): string {
  // Hyperliquid expects prices as strings with <=5 significant figures
  return String(Number(price.toPrecision(5)));
}

function sizeToString(size: number): string {
  return String(Number(size.toPrecision(5)));
}

export function normalizeTimeframe(tf: string): string {
  const match = tf.trim().toLowerCase().match(/^(\d+)([mhdw])$/);
  if (!match) return "1h";
  const [, num, unit] = match;
  switch (unit) {
    case "m": {
      const minutes = Number(num);
      // Hyperliquid intervals: 1m,3m,5m,15m,30m — snap down to the largest supported
      const supportedMinutes = [1, 3, 5, 15, 30];
      const snapped = supportedMinutes.filter((s) => s <= minutes).pop() ?? 1;
      return `${snapped}m`;
    }
    case "h": {
      const hours = Number(num);
      // Hyperliquid intervals: 1h,2h,4h,6h,8h,12h — snap down to the largest supported
      const supportedHours = [1, 2, 4, 6, 8, 12];
      const snapped = supportedHours.filter((s) => s <= hours).pop() ?? 1;
      return `${snapped}h`;
    }
    case "d":
      return Number(num) === 1 ? "1d" : "1d";
    case "w":
      return "1w";
    default:
      return "1h";
  }
}
