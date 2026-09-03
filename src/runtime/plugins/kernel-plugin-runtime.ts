/**
 * KernelPluginRuntime
 *
 * Plugin runtime adapter that sits on top of the PluginKernel while keeping
 * the legacy PluginRuntime public API as a drop-in surface. Discovers plugins
 * from workspace/plugins/ via plugin.json manifests, wraps each plugin in a
 * KernelPluginDefinition whose init() loads the plugin's entry module and
 * registers its hooks through the legacy PluginRuntime (preserving manifest
 * validation, permission sandboxing, and audit behavior), and registers every
 * mounted plugin as a kernel service named plugin.<id> so dependent kernel
 * plugins can resolve them at init time.
 */

import fs from "fs/promises";
import path from "path";
import { Logger } from "@dyna/audit";
import { KernelPluginKernel, PluginInitError } from "../../kernel";
import type { KernelPluginContext, PluginDefinition } from "../../kernel";
import { PluginRuntime, PluginLoadError } from "./plugin-runtime";
import type { RuntimeMode } from "@dyna/workspace";
import type {
  LoadedPlugin,
  PluginManifest,
  PluginPermissions,
  PluginRuntimeOptions,
} from "./plugin-runtime";

/** Options for constructing a KernelPluginRuntime. Mirrors PluginRuntimeOptions. */
export type KernelPluginRuntimeOptions = PluginRuntimeOptions;

interface ManifestSnapshot {
  name: string;
  version: string;
  description: string | undefined;
  dependencies: string[];
  raw: Record<string, unknown>;
}

/**
 * Kernel-backed plugin runtime.
 *
 * The KernelPluginRuntime composes a legacy PluginRuntime for all loading,
 * validation, hook registration, and permission-sandboxing behavior, and a
 * KernelPluginKernel for service discovery and lifecycle ordering. Each plugin
 * discovered in workspace/plugins/ becomes a kernel plugin definition that
 * loads its entry module when the kernel mounts it, and its public module is
 * published as the kernel service `plugin.<name>`.
 */
export class KernelPluginRuntime {
  /** The underlying plugin kernel. Other kernel plugins can mount against it and depend on `plugin.<name>` services. */
  readonly kernel: KernelPluginKernel;

  private readonly inner: PluginRuntime;
  private readonly logger: Logger;
  private readonly workspacePath: string;
  private readonly strictMode: boolean;

  constructor(options: KernelPluginRuntimeOptions) {
    this.workspacePath = options.workspacePath;
    this.strictMode = options.strictMode ?? true;
    this.logger = new Logger("KernelPluginRuntime");
    this.inner = new PluginRuntime(options);
    this.kernel = new KernelPluginKernel({ strict: options.strictMode ?? true });
  }

  /**
   * Load all plugins from the workspace/plugins/ directory through the plugin
   * kernel. Each plugin must have a plugin.json manifest.
   */
  async loadPlugins(): Promise<LoadedPlugin[]> {
    const pluginsDir = path.join(this.workspacePath, "plugins");

    let dirNames: string[];
    try {
      const entries = await fs.readdir(pluginsDir, { withFileTypes: true });
      dirNames = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      this.logger.info("No plugins directory found, skipping plugin loading");
      return [];
    }

    const snapshots = new Map<string, ManifestSnapshot>();
    const dirByPlugin = new Map<string, string>();

    for (const dirName of dirNames) {
      const dir = path.join(pluginsDir, dirName);
      try {
        const snapshot = await this.inspectManifest(dir);
        snapshots.set(snapshot.name, snapshot);
        dirByPlugin.set(snapshot.name, dir);
      } catch (err) {
        if (this.strictMode) {
          throw err;
        }
        this.logger.warn(`Skipping invalid plugin "${dirName}"`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const known = new Set(snapshots.keys());
    const ordered = this.topologicalSort([...known], snapshots);

    for (const id of ordered) {
      if (this.kernel.getPlugin(id)) {
        continue;
      }
      const dir = dirByPlugin.get(id)!;
      const snapshot = snapshots.get(id)!;
      this.kernel.register(this.buildDefinition(id, dir, snapshot, known));
    }

    try {
      await this.kernel.mountAll();
    } catch (err) {
      throw this.unwrapKernelError(err);
    }

    const loaded: LoadedPlugin[] = [];
    for (const id of ordered) {
      const plugin = this.inner.getPlugin(id);
      if (plugin) {
        loaded.push(plugin);
      }
    }

    this.logger.info(`Loaded ${loaded.length} plugin(s)`);
    return loaded;
  }

  /**
   * Load a single plugin from a directory containing plugin.json, mounting it
   * on the plugin kernel and exposing `plugin.<name>` as a kernel service.
   */
  async loadPlugin(pluginDir: string): Promise<LoadedPlugin> {
    const snapshot = await this.inspectManifest(pluginDir);
    const id = snapshot.name;
    const known = new Set<string>([id]);
    const definition = this.buildDefinition(id, pluginDir, snapshot, known);

    if (this.kernel.getPlugin(id)) {
      await this.kernel.reload(id);
    } else {
      this.kernel.register(definition);
      try {
        await this.kernel.mount(id);
      } catch (err) {
        throw this.unwrapKernelError(err);
      }
    }

    const plugin = this.inner.getPlugin(id);
    if (!plugin) {
      throw new PluginLoadError(
        id,
        `Plugin "${id}" was registered on the kernel but could not be loaded`,
      );
    }
    return plugin;
  }

  /**
   * Unload a plugin by name, unregistering its hooks and removing its kernel
   * service. Returns true if the plugin was found and unloaded.
   */
  unloadPlugin(name: string): boolean {
    const removed = this.inner.unloadPlugin(name);
    if (removed) {
      void this.kernel.unmount(name).catch((err) => {
        this.logger.warn(`Failed to unmount plugin "${name}" from the kernel`, {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    return removed;
  }

  /** Get a loaded plugin by name. */
  getPlugin(name: string): LoadedPlugin | undefined {
    return this.inner.getPlugin(name);
  }

  /** Get all currently loaded plugins. */
  getLoadedPlugins(): LoadedPlugin[] {
    return this.inner.getLoadedPlugins();
  }

  /** Check if a plugin is loaded by name. */
  isLoaded(name: string): boolean {
    return this.inner.isLoaded(name);
  }

  /**
   * Validate that a plugin's declared permissions are acceptable given the
   * current runtime mode and auth configuration. Delegates to the legacy
   * PluginRuntime so behavior is identical.
   */
  validatePermissions(
    manifest: PluginManifest,
    currentMode?: RuntimeMode,
  ): { valid: boolean; warnings: string[]; errors: string[] } {
    return this.inner.validatePermissions(manifest, currentMode);
  }

  /**
   * Execute a plugin function with sandboxed permission checks. The sandbox
   * verifies the plugin has the required permission before the operation
   * proceeds.
   */
  executeSandboxed<T>(
    pluginName: string,
    permission: keyof PluginPermissions,
    operationName: string,
    fn: () => T,
  ): T {
    return this.inner.executeSandboxed(pluginName, permission, operationName, fn);
  }

  /** Async version of executeSandboxed. */
  async executeSandboxedAsync<T>(
    pluginName: string,
    permission: keyof PluginPermissions,
    operationName: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return await this.inner.executeSandboxedAsync(pluginName, permission, operationName, fn);
  }

  /** Check if the plugin has a specific permission. */
  hasPermission(pluginName: string, permission: keyof PluginPermissions): boolean {
    return this.inner.hasPermission(pluginName, permission);
  }

  /**
   * Create a fetch-like function that is sandboxed by the plugin's network
   * permission. If the plugin doesn't have network permission, the returned
   * function will throw PermissionDeniedError.
   */
  createSandboxedFetch(
    pluginName: string,
  ): (input: string | URL, init?: Record<string, unknown>) => Promise<Response> {
    return this.inner.createSandboxedFetch(pluginName);
  }

  /** Read a kernel service by name, throwing when no mounted plugin provides it. */
  getService<T>(name: string): T {
    return this.kernel.getService<T>(name);
  }

  /** Check whether a kernel service is currently provided by a mounted plugin. */
  hasService(name: string): boolean {
    return this.kernel.hasService(name);
  }

  /** Unmount every mounted kernel plugin, unloading each plugin in turn. */
  async stop(): Promise<void> {
    await this.kernel.stop();
  }

  private async inspectManifest(pluginDir: string): Promise<ManifestSnapshot> {
    const manifestPath = path.join(pluginDir, "plugin.json");

    let rawText: string;
    try {
      rawText = await fs.readFile(manifestPath, "utf-8");
    } catch (err) {
      throw new PluginLoadError(
        path.basename(pluginDir),
        `Cannot read plugin.json: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err : undefined,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      throw new PluginLoadError(
        path.basename(pluginDir),
        "Invalid JSON in plugin.json",
        err instanceof Error ? err : undefined,
      );
    }

    const raw = (parsed ?? {}) as Record<string, unknown>;
    const name =
      typeof raw["name"] === "string" && raw["name"].length > 0
        ? raw["name"]
        : path.basename(pluginDir);
    const version =
      typeof raw["version"] === "string" && raw["version"].length > 0
        ? raw["version"]
        : "0.0.0";
    const description =
      typeof raw["description"] === "string" ? raw["description"] : undefined;
    const dependencies = Array.isArray(raw["dependencies"])
      ? (raw["dependencies"] as unknown as string[])
      : [];

    return { name, version, description, dependencies, raw };
  }

  private buildDefinition(
    id: string,
    pluginDir: string,
    snapshot: ManifestSnapshot,
    known: Set<string>,
  ): PluginDefinition {
    const serviceName = `plugin.${id}`;
    const dependencies = snapshot.dependencies
      .filter((dep) => dep !== id && known.has(dep))
      .map((dep) => ({ service: `plugin.${dep}` }));

    return {
      id,
      version: snapshot.version,
      description: snapshot.description,
      dependencies,
      meta: snapshot.raw,
      init: async (ctx: KernelPluginContext): Promise<void> => {
        const existing = this.inner.getPlugin(id);
        const loaded = existing ?? (await this.inner.loadPlugin(pluginDir));
        ctx.registerService(serviceName, loaded, {
          pluginName: id,
          version: snapshot.version,
        });
      },
      stop: (): void => {
        this.inner.unloadPlugin(id);
      },
    };
  }

  private topologicalSort(
    ids: string[],
    snapshots: ReadonlyMap<string, ManifestSnapshot>,
  ): string[] {
    const edges = new Map<string, string[]>();
    for (const id of ids) {
      edges.set(
        id,
        (snapshots.get(id)?.dependencies ?? []).filter((dep) =>
          snapshots.has(dep),
        ),
      );
    }

    const permanent = new Set<string>();
    const temporary = new Set<string>();
    const order: string[] = [];

    const visit = (id: string): void => {
      if (permanent.has(id)) {
        return;
      }
      if (temporary.has(id)) {
        this.logger.warn(`Dependency cycle detected while ordering plugins ("${id}")`);
        return;
      }
      temporary.add(id);
      for (const dep of edges.get(id) ?? []) {
        visit(dep);
      }
      temporary.delete(id);
      permanent.add(id);
      order.push(id);
    };

    for (const id of ids) {
      visit(id);
    }
    return order;
  }

  private unwrapKernelError(err: unknown): unknown {
    if (err instanceof PluginInitError && err.cause) {
      return err.cause;
    }
    return err;
  }
}