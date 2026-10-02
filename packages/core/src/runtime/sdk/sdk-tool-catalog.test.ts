import { describe, expect, it } from 'vitest';
import { ToolRegistryImpl } from '../tools/tool-registry';
import { getAvailableSdkToolDefinitions, isAvailableSdkTool } from './sdk-tool-catalog';
import type { ToolHandler } from '@dyna/contracts';

function handler(name: string, sdkCallable = false): ToolHandler {
  return {
    definition: {
      name,
      description: name,
      category: 'analysis',
      inputSchema: {},
      timeoutMs: 1_000,
      sdkCallable,
    },
    execute: async () => ({ success: true, data: {}, durationMs: 0, truncated: false }),
  };
}

describe('registered SDK capability catalog', () => {
  it('exposes first-party capabilities on base so REPL hosts always reach them', () => {
    const registry = new ToolRegistryImpl();
    registry.register(handler('market_data'));

    // Financial capabilities are SDK-only: authorized through `base`, which
    // resolveProfiles always includes, so a headless host never has to opt in
    // via a plugin profile to give the model market data.
    expect(isAvailableSdkTool(registry, 'market_data', ['base'])).toBe(true);
    expect(isAvailableSdkTool(registry, 'market_data', ['base', 'memory'])).toBe(true);
    // Note: authorization is matched against the *resolved* profile set. Real
    // hosts go through resolveProfiles, which expands 'full' to every profile
    // (including base); a raw ['full'] array is not a resolved set.

    // Authorization still requires the capability to be registered.
    registry.unregister('market_data');
    expect(isAvailableSdkTool(registry, 'market_data', ['base'])).toBe(false);
  });

  it('does not offer order execution through the SDK', () => {
    const registry = new ToolRegistryImpl();
    registry.register(handler('propose_order'));
    registry.register(handler('execute_order'));

    // The standalone research host refuses execution outright. Advertising the
    // tools would only teach the model to retry against a guaranteed refusal.
    expect(isAvailableSdkTool(registry, 'propose_order', ['base'])).toBe(false);
    expect(isAvailableSdkTool(registry, 'execute_order', ['base', 'full'])).toBe(false);
  });

  it('exposes only registered sdkCallable plugin tools authorized by active profiles', () => {
    const registry = new ToolRegistryImpl();
    registry.register(handler('plugin_allowed', true));
    registry.register(handler('plugin_not_callable'));
    registry.register(handler('plugin_unassigned', true));
    const pluginTools = { trading: ['plugin_allowed', 'plugin_not_callable'] };

    expect(getAvailableSdkToolDefinitions(registry, ['trading'], pluginTools).map((tool) => tool.name))
      .toEqual(['plugin_allowed']);
    expect(isAvailableSdkTool(registry, 'plugin_allowed', ['base'], pluginTools)).toBe(false);

    registry.unregister('plugin_allowed');
    expect(isAvailableSdkTool(registry, 'plugin_allowed', ['trading'], pluginTools)).toBe(false);
  });
});
