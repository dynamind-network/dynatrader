import { afterEach, describe, expect, it } from "vitest";
import { createExchangeAdapter } from "./exchange-factory";

const ENV_KEYS = ["HYPERLIQUID_REST_URL", "HYPERLIQUID_NETWORK", "HYPERLIQUID_PRIVATE_KEY", "HYPERLIQUID_WALLET_ADDRESS", "EXCHANGE_API_KEY", "EXCHANGE_SECRET", "EXCHANGE_PASSPHRASE", "EXCHANGE_ID"] as const;
const original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

describe("Hyperliquid exchange factory network wiring", () => {
  it("does not retain or serialize the private key when factory-injected signer is used", () => {
    const privateKey = `0x${"12".repeat(32)}`;
    process.env.HYPERLIQUID_NETWORK = "testnet";
    const adapter = createExchangeAdapter({
      exchangeId: "hyperliquid",
      auth: { walletAddress: "0x0000000000000000000000000000000000000001", privateKey, network: "testnet" },
    }) as any;
    expect(adapter).not.toBeNull();
    expect(adapter.signer).toBeDefined();
    expect(Object.keys(adapter)).not.toContain("privateKey");
    expect(adapter.config).not.toHaveProperty("privateKey");
    expect(JSON.stringify(adapter)).not.toContain(privateKey);
    expect(JSON.stringify(adapter)).not.toContain(privateKey.slice(2));
  });
  it("accepts typed network from auth for factory/plugin callers", () => {
    expect(createExchangeAdapter({ exchangeId: "hyperliquid", auth: { walletAddress: "0x1", privateKey: "11".repeat(32), network: "testnet" } })).not.toBeNull();
  });
  it("requires explicit network for custom environment REST URL when signing", () => {
    process.env.HYPERLIQUID_REST_URL = "https://hl.internal";
    process.env.HYPERLIQUID_PRIVATE_KEY = "11".repeat(32);
    process.env.HYPERLIQUID_WALLET_ADDRESS = "0x1";
    expect(() => createExchangeAdapter({ exchangeId: "hyperliquid" })).toThrow(/network/);
  });
  it("accepts HYPERLIQUID_NETWORK for custom environment REST URL", () => {
    process.env.HYPERLIQUID_REST_URL = "https://hl.internal";
    process.env.HYPERLIQUID_NETWORK = "testnet";
    process.env.HYPERLIQUID_PRIVATE_KEY = "11".repeat(32);
    process.env.HYPERLIQUID_WALLET_ADDRESS = "0x1";
    expect(createExchangeAdapter({ exchangeId: "hyperliquid" })).not.toBeNull();
  });
});

describe('canonical native credential resolution', () => {
  it('uses Longbridge alternate token when the preferred variable is blank', async () => {
    const { LongbridgeAdapter } = await import('./longbridge-adapter');
    process.env.LONGBRIDGE_ACCESS_TOKEN = '  ';
    process.env.LONGBRIDGE_TOKEN = 'alternate-token';
    expect(createExchangeAdapter({ exchangeId: 'longbridge' })).toBeInstanceOf(LongbridgeAdapter);
  });

  it('falls back from blank Alpaca env values to explicit auth', async () => {
    const { AlpacaAdapter } = await import('./alpaca-adapter');
    process.env.ALPACA_API_KEY = '  ';
    process.env.ALPACA_SECRET_KEY = '';
    expect(createExchangeAdapter({ exchangeId: 'alpaca', auth: { apiKey: 'explicit-key', secret: 'explicit-secret' } })).toBeInstanceOf(AlpacaAdapter);
  });
});

  it("uses generic aliases only for a sole configured CCXT venue", async () => {
    process.env.EXCHANGE_API_KEY = "generic-test-key";
    process.env.EXCHANGE_SECRET = "generic-test-secret";
    delete process.env.EXCHANGE_PASSPHRASE;
    const single = createExchangeAdapter({ exchangeId: "binance", exchangeIds: ["binance"] });
    expect(single).toMatchObject({ id: "binance" });
    expect((single as any).config).toMatchObject({ apiKey: "generic-test-key", secret: "generic-test-secret" });
    const multiple = createExchangeAdapter({ exchangeId: "binance", exchangeIds: ["binance", "kraken"] });
    expect((multiple as any).config).toMatchObject({ apiKey: undefined, secret: undefined });
  });

  it("uses EXCHANGE_ID only when no explicit ID is supplied", async () => {
    process.env.EXCHANGE_ID = "binance";
    expect(createExchangeAdapter({})).toMatchObject({ id: "binance" });
    expect(createExchangeAdapter({ mode: "paper" })).toMatchObject({ id: "binance" });
    expect(createExchangeAdapter({ exchangeId: "kraken" })).toMatchObject({ id: "kraken" });
    expect(createExchangeAdapter({ adapterName: "kraken" })).toMatchObject({ id: "kraken" });
  });

  it.each(["paper", "backtest"])('uses EXCHANGE_ID for %s mode before the fallback venue', (mode) => {
    process.env.EXCHANGE_ID = "kraken";
    expect(createExchangeAdapter({ mode })).toMatchObject({ id: "kraken" });
  });


describe('Longbridge explicit auth wiring', () => {
  it('passes explicit auth accessToken to the adapter', async () => {
    const { LongbridgeAdapter } = await import('./longbridge-adapter');
    expect(createExchangeAdapter({ exchangeId: 'longbridge', auth: { accessToken: 'explicit-token' } })).toBeInstanceOf(LongbridgeAdapter);
  });
});
