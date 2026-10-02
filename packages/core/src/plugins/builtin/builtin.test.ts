import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistryImpl } from '../../runtime/tools/tool-registry';
import { PluginRegistry } from '../registry';
import { createExchangePlugin } from './exchange-plugin';
import { createWalletPlugin } from './wallet-plugin';

const credentialEnvKeys = ['EXCHANGE_API_KEY', 'EXCHANGE_SECRET', 'EXCHANGE_PASSPHRASE'] as const;
const originalCredentialEnv = Object.fromEntries(credentialEnvKeys.map((key) => [key, process.env[key]]));
afterEach(() => {
  for (const key of credentialEnvKeys) {
    const value = originalCredentialEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('builtin plugins', () => {
  it('mounts the exchange offline and exposes exchange plus market data seams', async () => {
    const registry = new PluginRegistry({ workspacePath: process.cwd() });
    await registry.register(createExchangePlugin({ mode: 'paper' }));
    await registry.activateAll();

    expect(registry.getProviderPlugin('exchange')?.id).toBe('exchange');
    expect(registry.getProviderPlugin('market_data')?.id).toBe('exchange');
    expect(registry.hasProvider('exchange')).toBe(true);
    const adapters = registry.getProvider<ReadonlyMap<string, { id: string }>>('exchange_adapters');
    expect(adapters?.get('binance')?.id).toBe('binance');
    await registry.deactivateAll();
    expect(registry.hasProvider('exchange')).toBe(false);
  });

  it('returns listed market symbols from the adapter market envelope', async () => {
    const plugin = createExchangePlugin({ mode: 'paper' });
    const services = new Map<string, unknown>();
    plugin.init({ registerService: (name: string, value: unknown) => services.set(name, value) } as never);

    const exchange = services.get('exchange') as { fetchMarkets: () => Promise<Record<string, unknown>> };
    const marketData = services.get('market_data') as { fetchUniverse: () => Promise<string[]> };
    const fetchMarkets = vi.spyOn(exchange, 'fetchMarkets').mockResolvedValue({
      total: 2,
      markets: [{ symbol: 'BTC/USDT' }, { symbol: 'ETH/USDT' }],
    });

    try {
      await expect(marketData.fetchUniverse()).resolves.toEqual(['BTC/USDT', 'ETH/USDT']);
    } finally {
      fetchMarkets.mockRestore();
    }
  });

  it('forwards order-book requests to the exchange adapter', async () => {
    const plugin = createExchangePlugin({ mode: 'paper' });
    const services = new Map<string, unknown>();
    plugin.init({ registerService: (name: string, value: unknown) => services.set(name, value) } as never);

    const orderBook = { bids: [[100, 2] as [number, number]], asks: [[101, 3] as [number, number]], timestamp: 1234 };
    const fetchOrderBook = vi.fn().mockResolvedValue(orderBook);
    const exchange = services.get('exchange') as { fetchOrderBook?: typeof fetchOrderBook };
    exchange.fetchOrderBook = fetchOrderBook;
    const marketData = services.get('market_data') as { getOrderBook: (symbol: string) => Promise<typeof orderBook> };

    await expect(marketData.getOrderBook('BTC/USDT')).resolves.toEqual(orderBook);
    expect(fetchOrderBook).toHaveBeenCalledWith('BTC/USDT');
  });

  it('forwards 24-hour quote-volume requests to the exchange adapter', async () => {
    const plugin = createExchangePlugin({ mode: 'paper' });
    const services = new Map<string, unknown>();
    plugin.init({ registerService: (name: string, value: unknown) => services.set(name, value) } as never);

    const fetch24hQuoteVolume = vi.fn().mockResolvedValue(4321);
    const exchange = services.get('exchange') as { fetch24hQuoteVolume?: typeof fetch24hQuoteVolume };
    exchange.fetch24hQuoteVolume = fetch24hQuoteVolume;
    const marketData = services.get('market_data') as { get24hVolume: (symbol: string) => Promise<number> };

    await expect(marketData.get24hVolume('BTC/USDT')).resolves.toBe(4321);
    expect(fetch24hQuoteVolume).toHaveBeenCalledWith('BTC/USDT');
  });

  it('does not apply generic credentials to each adapter in a multi-venue setup', () => {
    process.env.EXCHANGE_API_KEY = 'generic-test-key';
    process.env.EXCHANGE_SECRET = 'generic-test-secret';
    const plugin = createExchangePlugin({ exchangeIds: ['binance', 'kraken'] });
    const services = new Map<string, unknown>();
    plugin.init({ registerService: (name: string, value: unknown) => services.set(name, value) } as never);
    const adapters = services.get('exchange_adapters') as Map<string, { id: string; exchange?: { apiKey?: string }; config?: { apiKey?: string; secret?: string } }>;
    expect([...adapters.keys()]).toEqual(['binance', 'kraken']);
    expect(adapters.get('binance')?.config).toMatchObject({ apiKey: undefined, secret: undefined });
    expect(adapters.get('kraken')?.config).toMatchObject({ apiKey: undefined, secret: undefined });
  });

  it('allows a later capability provider to override and unwind without deleting unrelated services', async () => {
    const registry = new PluginRegistry({ workspacePath: process.cwd() });
    await registry.register(createExchangePlugin({ mode: 'paper' }));
    await registry.register({
      id: 'premium', version: '1.0.0', description: 'test override', capabilities: ['market_data'],
      init(ctx) { ctx.registerService('market_data', { source: 'premium' }); },
    });
    await registry.activateAll();
    expect(registry.getProvider('market_data')).toEqual({ source: 'premium' });
    await registry.reload('premium');
    expect(registry.getProvider('market_data')).toEqual({ source: 'premium' });
    await registry.unregister('premium');
    expect(registry.getProviderPlugin('market_data')?.id).toBe('exchange');
    await registry.deactivateAll();
  });

  it('registers and unwinds the five wallet tools', async () => {
    const tools = new ToolRegistryImpl();
    const registry = new PluginRegistry({ workspacePath: process.cwd(), toolRegistry: tools });
    await registry.register(createWalletPlugin({}));
    await registry.activateAll();
    expect(tools.list().map((tool) => tool.definition.name)).toEqual(expect.arrayContaining([
      'wallet_balance', 'wallet_swap', 'wallet_approve', 'wallet_history', 'wallet_quote',
    ]));
    await registry.deactivateAll();
    expect(tools.list().some((tool) => tool.definition.name.startsWith('wallet_'))).toBe(false);
  });
});
