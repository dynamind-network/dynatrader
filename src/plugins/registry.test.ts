import { describe, expect, it } from 'vitest';
import { ToolRegistryImpl } from '../runtime/tools/tool-registry';
import { PluginRegistry } from './registry';
import type { DynaPlugin } from './types';

function createPlugin(): DynaPlugin {
  return {
    id: 'fixture-plugin',
    version: '1.0.0',
    description: 'Plugin registry fixture',
    capabilities: ['market_data'],
    init(ctx) {
      ctx.registerService('market_data', { getPrice: async () => 42 });
      ctx.registerTool(
        {
          name: 'fixture.lookup',
          description: 'Look up a fixture value',
          category: 'market',
          inputSchema: { symbol: 'string' },
          readOnly: true,
        },
        async ({ args }) => ({ symbol: args.symbol, price: 42 }),
      );
    },
  };
}

describe('PluginRegistry', () => {
  it('wires services and tools, then unwinds them on deactivation', async () => {
    const tools = new ToolRegistryImpl();
    const registry = new PluginRegistry({ workspacePath: 'workspace', toolRegistry: tools });

    await registry.register(createPlugin(), { environment: 'test' });
    await registry.activateAll();

    expect(registry.getProvider<{ getPrice: () => Promise<number> }>('market_data')).toBeDefined();
    expect(tools.get('fixture.lookup')).toBeDefined();
    await expect(tools.execute({ tool: 'fixture.lookup', args: { symbol: 'BTC/USDT' } })).resolves.toMatchObject({
      success: true,
      data: { symbol: 'BTC/USDT', price: 42 },
    });

    await registry.deactivateAll();

    expect(registry.getProvider('market_data')).toBeUndefined();
    expect(tools.get('fixture.lookup')).toBeUndefined();
  });
});
