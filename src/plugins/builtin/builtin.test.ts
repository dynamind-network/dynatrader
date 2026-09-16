import { describe, expect, it } from 'vitest';
import { ToolRegistryImpl } from '../../runtime/tools/tool-registry';
import { PluginRegistry } from '../registry';
import { createExchangePlugin } from './exchange-plugin';
import { createWalletPlugin } from './wallet-plugin';

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
