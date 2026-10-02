import type { SubagentDefinition } from "../core/types.js";
import {
  PluginKernel,
  PluginDependencyError,
  type KernelPluginContext,
  type KernelPluginDefinition,
} from "../plugins/kernel.js";

export interface AgentPlugin {
  name: string;
  version: string;
  description?: string;
  init(registry: SubagentRegistry): Promise<void>;
  getAgents?(): SubagentDefinition[];
}

function agentServiceName(name: string): string {
  return `agent.${name}`;
}

const DEFAULT_PRIORITY = 50;
const LOADED_PLUGIN_PRIORITY = 75;

export class SubagentRegistry {
  private kernel: PluginKernel = new PluginKernel();
  private plugins: Map<string, AgentPlugin> = new Map();
  private priority: Map<string, number> = new Map();
  private agents: Map<string, SubagentDefinition> = new Map();
  private agentOrder: string[] = [];
  private running = false;

  register(plugin: AgentPlugin, priority: number = DEFAULT_PRIORITY): void {
    this.plugins.set(plugin.name, plugin);
    this.priority.set(plugin.name, priority);
    this.kernel.register(this.toKernelPlugin(plugin));
    console.log(
      `[PluginRegistry] Registered plugin: ${plugin.name} v${plugin.version}`,
    );
  }

  async initialize(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    await this.kernel.mountAll();
  }

  registerAgent(agent: SubagentDefinition, pluginName?: string): void {
    const existing = this.agents.get(agent.name);
    const existingPriority = existing
      ? (this.priority.get(`plugin-${existing.name}`) ?? DEFAULT_PRIORITY)
      : 100;

    if (pluginName) {
      const pluginPriority = this.priority.get(pluginName) ?? DEFAULT_PRIORITY;
      if (pluginPriority > existingPriority) {
        return;
      }
    }

    const wasPresent = this.agents.has(agent.name);
    this.agents.set(agent.name, agent);
    if (!wasPresent) {
      this.agentOrder.push(agent.name);
    }
    this.kernel.register({
      name: agentServiceName(agent.name),
      provides: [{ service: agentServiceName(agent.name), value: agent }],
    });
    void this.kernel.mount(agentServiceName(agent.name));
  }

  getAgent(name: string): SubagentDefinition | undefined {
    return (
      this.kernel.getService<SubagentDefinition>(agentServiceName(name)) ??
      this.agents.get(name)
    );
  }

  getAllAgents(): SubagentDefinition[] {
    return this.agentOrder
      .map((name) => this.getAgent(name))
      .filter((agent): agent is SubagentDefinition => agent !== undefined);
  }

  hasAgent(name: string): boolean {
    return this.agents.has(name);
  }

  unregisterAgent(name: string): boolean {
    const removed = this.agents.delete(name);
    const index = this.agentOrder.indexOf(name);
    if (index >= 0) {
      this.agentOrder.splice(index, 1);
    }
    void this.kernel.unmount(agentServiceName(name));
    return removed;
  }

  getPlugins(): AgentPlugin[] {
    return Array.from(this.plugins.values());
  }

  getService<T = unknown>(service: string): T | undefined {
    return this.kernel.getService<T>(service);
  }

  clear(): void {
    this.agents.clear();
    this.agentOrder = [];
    this.plugins.clear();
    this.priority.clear();
    this.kernel = new PluginKernel();
    this.running = false;
  }

  private toKernelPlugin(plugin: AgentPlugin): KernelPluginDefinition {
    return {
      name: plugin.name,
      setup: async (context: KernelPluginContext) => {
        await plugin.init(this);
        for (const agent of plugin.getAgents?.() ?? []) {
          this.registerAgent(agent, plugin.name);
          context.provide(agentServiceName(agent.name), agent);
        }
      },
      teardown: async () => {
        for (const agent of plugin.getAgents?.() ?? []) {
          this.unregisterAgent(agent.name);
        }
      },
    };
  }
}

let globalRegistry: SubagentRegistry | null = null;

export function getSubagentRegistry(): SubagentRegistry {
  if (!globalRegistry) {
    globalRegistry = new SubagentRegistry();
  }
  return globalRegistry;
}

export function resetSubagentRegistry(): void {
  globalRegistry = null;
}

export async function discoverAndLoadPlugins(
  pluginPaths: string[],
): Promise<void> {
  const registry = getSubagentRegistry();

  for (const pluginPath of pluginPaths) {
    try {
      const plugin = await import(pluginPath);
      if (plugin.default && typeof plugin.default.init === "function") {
        registry.register(plugin.default, LOADED_PLUGIN_PRIORITY);
      } else if (typeof plugin.init === "function") {
        registry.register(plugin as AgentPlugin, LOADED_PLUGIN_PRIORITY);
      }
    } catch (error) {
      console.error(
        `[PluginRegistry] Failed to load plugin from ${pluginPath}:`,
        error,
      );
    }
  }

  await registry.initialize();
}

export { PluginKernel, PluginDependencyError };
export type { KernelPluginDefinition, KernelPluginContext };

