/**
 * Plugin Registry
 *
 * Capability-aware plugin registry built on top of the PluginKernel.
 * Discovers, loads, and manages plugins that provide typed capability providers.
 * One active provider per capability; consumers call getProvider<T>() to access.
 *
 * Contract: a plugin entry module's default export is a
 * factory `(config) => DynaPlugin`. The factory receives the resolved config
 * for its composition row (manifest defaults overlaid by row-level config).
 * Every registration made through the plugin context (services, listeners,
 * tools) is an effect that unwinds when the plugin unmounts.
 */

import fs from "fs/promises";
import path from "path";
import { Logger } from "@dyna/audit";
import type { ToolHandler, ToolRegistry } from "@dyna/contracts";
import { KernelPluginKernel } from "../kernel/PluginKernel";
import type {
  DynaPlugin,
  PluginCapability,
  PluginContext,
  PluginFactory,
  PluginLogger,
  PluginToolDeclaration,
  PluginToolHandler,
} from "./types";
import type { KernelPluginContext, PluginDefinition } from "../kernel/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PluginRegistryOptions {
  workspacePath: string;
  pluginDirs?: string[];
  logger?: Logger;
  /** Shared tool registry that plugins contribute tools to via ctx.registerTool. */
  toolRegistry?: ToolRegistry;
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

/** A plugin as described by a plugin.json manifest on disk. */
export interface DiscoveredPluginManifest {
  name: string;
  version: string;
  description?: string;
  entry: string;
  capabilities: PluginCapability[];
  config?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Plugin Registry
// ---------------------------------------------------------------------------

export class PluginRegistry {
  private readonly kernel: KernelPluginKernel;
  private readonly logger: Logger;
  private readonly workspacePath: string;
  private readonly pluginDirs: string[];
  private readonly toolRegistry: ToolRegistry | undefined;
  private readonly providers = new Map<PluginCapability, DynaPlugin>();
  private readonly plugins = new Map<string, RegisteredPlugin>();
  private readonly configs = new Map<string, Record<string, unknown>>();
  /** Tool names registered per plugin id, unwound on unmount. */
  private readonly pluginToolNames = new Map<string, string[]>();

  constructor(options: PluginRegistryOptions) {
    this.workspacePath = options.workspacePath;
    this.pluginDirs = options.pluginDirs ?? [];
    this.logger = options.logger ?? new Logger("PluginRegistry");
    this.toolRegistry = options.toolRegistry;
    this.kernel = new KernelPluginKernel({
      logger: this.logger,
      strict: false,
    });
  }

  /** The underlying plugin kernel (services, events, lifecycle). */
  getKernel(): KernelPluginKernel {
    return this.kernel;
  }

  /**
   * Discover and load all plugins from configured directories.
   * Priority order: bundled -> workspace -> user ~/.dynatrader/plugins/
   * Later directories override earlier ones by plugin id.
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
  async register(plugin: DynaPlugin, config?: Record<string, unknown>): Promise<void> {
    if (this.plugins.has(plugin.id)) {
      this.logger.warn(`Plugin ${plugin.id} already registered, skipping`);
      return;
    }

    this.logger.info(`Registering plugin: ${plugin.id} v${plugin.version}`);
    if (config) {
      this.configs.set(plugin.id, config);
    }

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
          try {
            await plugin.stop(pluginCtx);
          } catch (err) {
            this.logger.warn(`Plugin stop failed for ${plugin.id}`, {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        // Unwind every tool this plugin registered.
        for (const toolName of this.pluginToolNames.get(plugin.id) ?? []) {
          this.toolRegistry?.unregister(toolName);
        }
        this.pluginToolNames.delete(plugin.id);
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
   * Deactivate all plugins, unwinding every registration they made.
   */
  async deactivateAll(): Promise<void> {
    for (const id of [...this.plugins.keys()]) {
      try {
        await this.kernel.unmount(id);
      } catch (err) {
        this.logger.error(`Failed to unmount plugin ${id}:`, err);
      }
    }
    this.providers.clear();
    this.plugins.clear();
    this.configs.clear();
    this.pluginToolNames.clear();
  }

  async unregister(id: string): Promise<boolean> {
    const removed = await this.kernel.unregister(id);
    if (!removed) return false;
    this.syncCapabilityProviders();
    this.plugins.delete(id);
    this.configs.delete(id);
    this.providers.forEach((plugin, capability) => {
      if (plugin.id === id) this.providers.delete(capability);
    });
    return true;
  }

  /**
   * Hot-reload a mounted plugin (unmount + mount), unwinding and re-applying
   * all of its registrations.
   */
  async reload(id: string): Promise<void> {
    const record = this.plugins.get(id);
    if (!record) {
      throw new Error(`Plugin "${id}" is not registered`);
    }
    // Release capability claims before re-mount so reload is idempotent.
    for (const cap of record.plugin.capabilities) {
      if (this.providers.get(cap)?.id === id) {
        this.providers.delete(cap);
      }
    }
    await this.kernel.reload(id);
    this.syncCapabilityProviders();
    if (record.status === "active") {
      for (const cap of record.plugin.capabilities) {
        this.providers.set(cap, record.plugin);
      }
    }
  }

  private syncCapabilityProviders(): void {
    for (const [capability, plugin] of this.providers) {
      const owner = this.kernel.getServiceOwner(`capability.${capability}`);
      const replacement = owner ? this.plugins.get(owner)?.plugin : undefined;
      if (replacement) this.providers.set(capability, replacement);
      else if (plugin.id !== owner) this.providers.delete(capability);
    }
  }

  /**
   * Get the active provider for a capability. Returns undefined when no
   * mounted plugin provides it (never throws).
   */
  getProvider<T>(capability: PluginCapability): T | undefined {
    const plugin = this.providers.get(capability);
    if (!plugin) return undefined;
    if (!this.kernel.hasService(`capability.${capability}`)) {
      return undefined;
    }
    return this.kernel.getService<T>(`capability.${capability}`);
  }

  /**
   * Check if a capability has an active provider.
   */
  hasProvider(capability: PluginCapability): boolean {
    return this.getProvider(capability) !== undefined;
  }

  /**
   * Get the plugin providing a capability.
   */
  getProviderPlugin(capability: PluginCapability): DynaPlugin | undefined {
    return this.providers.get(capability);
  }

  /** Return the resolved composition config for an installed plugin. */
  getPluginConfig(id: string): Readonly<Record<string, unknown>> {
    return { ...(this.configs.get(id) ?? {}) };
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
      exchange_adapters: null,
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

  private createPluginContext(id: string, kernelCtx: KernelPluginContext): PluginContext {
    const config = Object.freeze({ ...(this.configs.get(id) ?? {}) });
    const logger: PluginLogger = {
      info: (msg, ...args) => this.logger.info(`[${id}] ${msg}`, ...args),
      warn: (msg, ...args) => this.logger.warn(`[${id}] ${msg}`, ...args),
      error: (msg, ...args) => this.logger.error(`[${id}] ${msg}`, ...args),
      debug: (msg, ...args) => this.logger.debug(`[${id}] ${msg}`, ...args),
    };

    return {
      id,
      config,
      registerService: <T>(name: string, handle: T) => {
        kernelCtx.registerService(`capability.${name}`, handle, {
          allowOverride: true,
        });
      },
      getService: <T>(name: string) => {
        const services = kernelCtx.services as Record<string, unknown>;
        return services[`capability.${name}`] as T | undefined;
      },
      emit: (event, payload) => kernelCtx.emit(event, payload),
      on: (event, handler) =>
        kernelCtx.on(event, (kernelEvent) => handler(kernelEvent.payload)),
      registerTool: (decl: PluginToolDeclaration, handler: PluginToolHandler) => {
        if (!this.toolRegistry) {
          this.logger.warn(
            `Plugin "${id}" tried to register tool "${decl.name}" but no ToolRegistry is wired, skipping`,
          );
          return;
        }
        if (this.toolRegistry.get(decl.name)) {
          this.logger.warn(
            `Plugin "${id}" tool "${decl.name}" conflicts with an existing tool, skipping`,
          );
          return;
        }
        if (
          decl.sideEffects &&
          decl.sideEffects.length > 0 &&
          decl.readOnly !== true &&
          !decl.permissionsRequired?.length
        ) {
          this.logger.debug(
            `Plugin "${id}" tool "${decl.name}" declares side effects without required permissions`,
          );
        }
        const toolHandler: ToolHandler = {
          definition: {
            name: decl.name,
            description: decl.description,
            category: decl.category as ToolHandler["definition"]["category"],
            inputSchema: decl.inputSchema,
            permissionsRequired: decl.permissionsRequired ?? [],
            sideEffects: decl.sideEffects ?? [],
            riskLevel: decl.riskLevel ?? "low",
            timeoutMs: decl.timeoutMs ?? 30000,
            canRunInParallel: decl.canRunInParallel ?? false,
            readOnly: decl.readOnly ?? false,
          },
          execute: async (call) => {
            const start = Date.now();
            try {
              const result = await handler({ args: call.args as Record<string, unknown> });
              return {
                success: true,
                data: result,
                durationMs: Date.now() - start,
                truncated: false,
              };
            } catch (err) {
              return {
                success: false,
                error: (err as Error).message ?? String(err),
                durationMs: Date.now() - start,
                truncated: false,
              };
            }
          },
        };
        this.toolRegistry.register(toolHandler);
        const names = this.pluginToolNames.get(id) ?? [];
        names.push(decl.name);
        this.pluginToolNames.set(id, names);
      },
      logger,
    };
  }

  /**
   * Load every plugin from a directory of plugin.json manifests, invoking
   * each entry factory with the manifest's config block.
   */
  private async loadFromDirectory(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const pluginDir = path.join(dir, entry);
      try {
        await this.loadFromManifestDir(pluginDir);
      } catch (err) {
        this.logger.error(`Failed to load plugin from ${pluginDir}:`, err);
      }
    }
  }

  /**
   * Load a single plugin from a directory containing plugin.json.
   * Returns the registered plugin id, or undefined when already registered
   * (later layers override earlier ones by id, so duplicates are skipped).
   */
  async loadFromManifestDir(
    pluginDir: string,
    rowConfig?: Record<string, unknown>,
  ): Promise<string | undefined> {
    const manifestPath = path.join(pluginDir, "plugin.json");

    let manifestRaw: string;
    try {
      manifestRaw = await fs.readFile(manifestPath, "utf-8");
    } catch {
      return undefined;
    }

    const manifest = JSON.parse(manifestRaw) as DiscoveredPluginManifest;
    const entryPath = path.join(pluginDir, manifest.entry);
    const resolvedEntry = path.resolve(entryPath);
    const resolvedPluginDir = path.resolve(pluginDir);
    if (
      !resolvedEntry.startsWith(resolvedPluginDir + path.sep) &&
      resolvedEntry !== resolvedPluginDir
    ) {
      throw new Error(`Plugin entry "${manifest.entry}" escapes plugin directory`);
    }

    const mod = await import(resolvedEntry);
    const factory = (mod.default ?? mod) as PluginFactory | undefined;

    if (typeof factory !== "function") {
      this.logger.warn(`Plugin ${manifest.name} entry does not export a factory function`);
      return undefined;
    }

    // Resolution order: row config (highest) overrides manifest config.
    const config = { ...(manifest.config ?? {}), ...(rowConfig ?? {}) };
    const plugin = await factory(config);
    await this.register(plugin, config);

    this.logger.info(
      `Discovered plugin: ${manifest.name} v${manifest.version} ` +
      `(${manifest.capabilities.join(", ")})`,
    );
    return plugin.id;
  }
}
