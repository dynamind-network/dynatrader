import type { PluginSettings } from '../config/settings.js';
import type { BaseTool } from './base-tool.js';
import { MarketDataTool, PortfolioTool } from './trading.js';
import type { ToolRegistry } from './tool-registry.js';

export type BuiltinToolPluginId = keyof PluginSettings;

export interface ToolPluginDef {
  id: BuiltinToolPluginId;
  name: string;
  description: string;
  defaultEnabled: boolean;
  toolNames: string[];
  createTools(): BaseTool[];
}

const BUILTIN_TOOL_PLUGINS: readonly ToolPluginDef[] = [
  {
    id: 'market',
    name: 'market',
    description: 'Live market-data tool bundle.',
    defaultEnabled: true,
    toolNames: ['market_data'],
    createTools: () => [new MarketDataTool()],
  },
  {
    id: 'portfolio',
    name: 'portfolio',
    description: 'Portfolio inspection and analysis tool bundle.',
    defaultEnabled: true,
    toolNames: ['portfolio'],
    createTools: () => [new PortfolioTool()],
  },
] as const;

export function getBuiltinToolPlugins(): ToolPluginDef[] {
  return [...BUILTIN_TOOL_PLUGINS];
}

export function getBuiltinToolPlugin(id: string): ToolPluginDef | undefined {
  return BUILTIN_TOOL_PLUGINS.find((plugin) => plugin.id === id);
}

export function registerPluginTools(registry: ToolRegistry, settings: PluginSettings): void {
  for (const plugin of BUILTIN_TOOL_PLUGINS) {
    const enabled = settings[plugin.id] ?? plugin.defaultEnabled;
    if (!enabled) continue;

    for (const tool of plugin.createTools()) {
      registry.register(tool);
    }
  }
}
