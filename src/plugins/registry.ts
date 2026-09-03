/**
 * Plugin Registry
 *
 * Capability-aware plugin registry built on top of the existing PluginKernel.
 * Discovers, loads, and manages plugins that provide typed capability providers.
 * One active provider per capability; consumers call getProvider<T>() to access.
 */

import fs from "fs/promises";
import path from "path";
import { Logger } from "@dyna/audit";
import { KernelPluginKernel } from "../kernel/PluginKernel";
import type {
  DynaPlugin,
  PluginCapability,
  PluginContext,
  PluginLogger,
} from "./types";
import type { PluginDefinition } from "../kernel/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PluginRegistryOptions {
  workspacePath: string;
  pluginDirs?: string[];
  logger?: Logger;
}

export interface RegisteredPlugin {
  plugin: DynaPlugin;
  status: "loaded" | "active" | "error";
  error?: string;
}

export interface PluginRegistryStats {
  totalPlugins: number;
  activePlugins: number;
  capabilities: Record<PluginCapability, string | null>;
}

// ---------------------------------------------------------------------------
// Plugin Registry
// ---------------------------------------------------------------------------

export class PluginRegistry {
  private readonly kernel: KernelPluginKernel;
  private readonly logger: Logger;
  private readonly workspacePath: string;
  private readonly pluginDirs: string[];
  private readonly providers = new Map<PluginCapability, DynaPlugin>();
  private readonly plugins = new Map<string, RegisteredPlugin>();
  private readonly disposers = new Map<string, () => void>();

  constructor(options: PluginRegistryOptions) {
    this.workspacePath = options.workspacePath;
    this.pluginDirs = options.pluginDirs ?? [];
    this.logger = options.logger ?? new Logger("PluginRegistry");
    this.kernel = new KernelPluginKernel({
      logger: this.logger,
      strict: false,
    });
  }

  /**
   * Discover and load all plugins from configured directories.
   * Priority order: bundled -> workspace -> user ~/.dynatrader/plugins/
   */
  async discover(): Promise<void> {
    const dirs = [
      ...this.pluginDirs,
      path.join(this.workspacePath, "plugins"),
    ];

    for (const dir of dirs) {
      try {
        await this.loadFromDirectory(dir);
      } catch {
        // Directory may not exist — skip silently
      }
    }
  }

  /**
   * Register a plugin programmatically (for bundled plugins).
   */
  async register(plugin: DynaPlugin): Promise<void> {
    if (this.plugins.has(plugin.id)) {
      this.logger.warn(`Plugin ${plugin.id} already registered, skipping`);
      return;
    }

    this.logger.info(`Registering plugin: ${plugin.id} v${plugin.version}`);

    // Register with kernel for lifecycle management
    const definition: PluginDefinition = {
      id: plugin.id,
      version: plugin.version,
      description: plugin.description,
      dependencies: [],
      init: async (ctx) => {
        const pluginCtx = this.createPluginContext(plugin.id, ctx);
        await plugin.init(pluginCtx);

        // Track capability providers
        for (const cap of plugin.capabilities) {
          const existing = this.providers.get(cap);
          if (existing) {
            this.logger.warn(
              `Capability "${cap}" already provided by ${existing.id}, ` +
              `${plugin.id} will override`,
            );
          }
          this.providers.set(cap, plugin);
        }
      },
      stop: async (ctx) => {
        if (plugin.stop) {
          const pluginCtx = this.createPluginContext(plugin.id, ctx);
          await plugin.stop(pluginCtx);
        }
        for (const cap of plugin.capabilities) {
          if (this.providers.get(cap)?.id === plugin.id) {
            this.providers.delete(cap);
          }
        }
      },
    };

    this.kernel.register(definition);
    this.plugins.set(plugin.id, { plugin, status: "loaded" });
  }

  /**
   * Activate all loaded plugins (mount in dependency order).
   */
  async activateAll(): Promise<void> {
    const ids = [...this.plugins.keys()];
    for (const id of ids) {
      try {
        await this.kernel.mount(id);
        this.plugins.get(id)!.status = "active";
      } catch (err) {
        this.logger.error(`Failed to mount plugin ${id}:`, err);
        this.plugins.get(id)!.status = "error";
        this.plugins.get(id)!.error = err instanceof Error ? err.message : String(err);
      }
    }
  }

  /**
   * Deactivate all plugins.
   */
  async deactivateAll(): Promise<void> {
    for (const [id, disposer] of this.disposers) {
      try {
        disposer();
      } catch (err) {
        this.logger.error(`Failed to dispose plugin ${id}:`, err);
      }
    }
    this.disposers.clear();
    this.providers.clear();
    this.plugins.clear();
  }

  /**
   * Get the active provider for a capability.
   */
  getProvider<T>(capability: PluginCapability): T | undefined {
    const plugin = this.providers.get(capability);
    if (!plugin) return undefined;
    // The provider is registered as a service on the kernel
    return this.kernel.getService<T>(`capability.${capability}`);
  }

  /**
   * Check if a capability has an active provider.
   */
  hasProvider(capability: PluginCapability): boolean {
    return this.providers.has(capability);
  }

  /**
   * Get the plugin providing a capability.
   */
  getProviderPlugin(capability: PluginCapability): DynaPlugin | undefined {
    return this.providers.get(capability);
  }

  /**
   * List all registered plugins.
   */
  listPlugins(): RegisteredPlugin[] {
    return [...this.plugins.values()];
  }

  /**
   * Get registry statistics.
   */
  getStats(): PluginRegistryStats {
    const capabilities: Record<PluginCapability, string | null> = {
      market_data: null,
      signal: null,
      risk: null,
      news: null,
      exchange: null,
      backtest: null,
      defi: null,
      macro: null,
      wallet: null,
      dex_routing: null,
      gas_estimation: null,
    };

    for (const [cap, plugin] of this.providers) {
      capabilities[cap] = plugin.id;
    }

    return {
      totalPlugins: this.plugins.size,
      activePlugins: [...this.plugins.values()].filter((p) => p.status === "active").length,
      capabilities,
    };
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private createPluginContext(id: string, kernelCtx: unknown): PluginContext {
    const ctx = kernelCtx as { registerService: (name: string, handle: unknown) => void; getService: (name: string) => unknown; emit: (event: string, payload?: unknown) => Promise<void>; on: (event: string, handler: (payload: unknown) => void | Promise<void>) => () => void };
    const logger: PluginLogger = {
      info: (msg, ...args) => this.logger.info(`[${id}] ${msg}`, ...args),
      warn: (msg, ...args) => this.logger.warn(`[${id}] ${msg}`, ...args),
      error: (msg, ...args) => this.logger.error(`[${id}] ${msg}`, ...args),
      debug: (msg, ...args) => this.logger.debug(`[${id}] ${msg}`, ...args),
    };

    return {
      id,
      registerService: <T>(name: string, handle: T) => {
        ctx.registerService(`capability.${name}`, handle);
      },
      getService: <T>(name: string) => {
        return ctx.getService(`capability.${name}`) as T | undefined;
      },
      emit: (event, payload) => ctx.emit(event, payload),
      on: (event, handler) => ctx.on(event, handler),
      logger,
    };
  }

  private async loadFromDirectory(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const pluginDir = path.join(dir, entry);
      const manifestPath = path.join(pluginDir, "plugin.json");

      try {
        await fs.access(manifestPath);
      } catch {
        continue;
      }

      try {
        const manifestRaw = await fs.readFile(manifestPath, "utf-8");
        const manifest = JSON.parse(manifestRaw) as {
          name: string;
          version: string;
          description: string;
          entry: string;
          capabilities: PluginCapability[];
        };

        const entryPath = path.join(pluginDir, manifest.entry);
        const resolvedEntry = path.resolve(entryPath);
        const resolvedPluginDir = path.resolve(pluginDir);
        if (!resolvedEntry.startsWith(resolvedPluginDir + path.sep) && resolvedEntry !== resolvedPluginDir) {
          throw new Error(`Plugin entry "${manifest.entry}" escapes plugin directory`);
        }
        const mod = await import(entryPath);
        const factory = mod.default ?? mod;

        if (typeof factory !== "function") {
          this.logger.warn(`Plugin ${entry} entry does not export a function`);
          continue;
        }

        const plugin = factory();
        await this.register(plugin);

        this.logger.info(
          `Discovered plugin: ${manifest.name} v${manifest.version} ` +
          `(${manifest.capabilities.join(", ")})`,
        );
      } catch (err) {
        this.logger.error(`Failed to load plugin from ${pluginDir}:`, err);
      }
    }
  }
}
