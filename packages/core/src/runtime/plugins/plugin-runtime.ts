/**
 * PluginRuntime
 *
 * Plugin runtime that loads plugins from workspace/plugins/,
 * sandboxes execution, enforces security constraints
 * (network/fs/credentials/order execution), and registers tools.
 */

import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import { Logger } from "@dyna/audit";
import { AuthRuntime } from "@dyna/auth-runtime";
import type { RuntimeMode, RiskLevel } from "@dyna/workspace";
import type { PluginToolDeclaration } from "../tools/tool-profiles";
import type { ToolHandler, ToolRegistry } from "@dyna/contracts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Security permissions a plugin can request */
export interface PluginPermissions {
  network: boolean;
  filesystem: boolean;
  credentials: boolean;
  orderExecution: boolean;
}

/** Failure policy for plugin hooks (kept for manifest compatibility, hooks not currently registered) */
export type FailurePolicy = 'fail_closed' | 'fail_open' | 'warn_only';

/** A plugin.json hook binding */
export interface PluginHookBinding {
  event: string;
  handler: string;
  timeout?: number;
  failurePolicy?: FailurePolicy;
}

/** Full plugin manifest (plugin.json) */
export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  entry: string;
  author?: string;
  permissions: PluginPermissions;
  hooks: PluginHookBinding[];
  /** Tools this plugin provides — registered dynamically with the ToolRegistry */
  tools?: PluginToolDeclaration[];
  riskLevel?: RiskLevel;
  allowedModes?: RuntimeMode[];
  dependencies?: string[];
}

/** A loaded plugin with its resolved module */
export interface LoadedPlugin {
  manifest: PluginManifest;
  directory: string;
  /** Resolved module exports (functions referenced in hooks) */
  module: Record<string, (...args: unknown[]) => unknown>;
  loadedAt: Date;
}

/** Options for constructing a PluginRuntime */
export interface PluginRuntimeOptions {
  workspacePath: string;
  authRuntime?: AuthRuntime;
  /** Plugin tool registry */
  toolRegistry?: ToolRegistry;
  auditTrail?: {
    record(event: {
      type: string;
      actor: string;
      actorType: string;
      action: string;
      result: string;
      details: Record<string, unknown>;
      resource?: string;
    }): Promise<void>;
  };
  /** When true, plugin loading fails on the first invalid plugin. When false, invalid plugins are skipped. */
  strictMode?: boolean;
}

// ---------------------------------------------------------------------------
// Plugin manifest schema validation
// ---------------------------------------------------------------------------

const PluginHookBindingSchema = z.object({
  event: z.string().min(1),
  handler: z.string().min(1),
  timeout: z.number().int().positive().optional().default(5000),
  failurePolicy: z.enum(["fail_closed", "fail_open", "warn_only"]).optional().default("fail_closed"),
});

const PluginPermissionsSchema = z.object({
  network: z.boolean().default(false),
  filesystem: z.boolean().default(false),
  credentials: z.boolean().default(false),
  orderExecution: z.boolean().default(false),
});

const PluginManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().default(""),
  entry: z.string().min(1),
  author: z.string().optional(),
  permissions: PluginPermissionsSchema.default({}),
  hooks: z.array(PluginHookBindingSchema).default([]),
  tools: z.array(z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    category: z.string().min(1),
    inputSchema: z.record(z.unknown()).default({}),
    permissionsRequired: z.array(z.string()).optional(),
    sideEffects: z.array(z.string()).optional(),
    riskLevel: z.enum(["low", "medium", "high", "critical"]).optional(),
    timeoutMs: z.number().int().positive().optional(),
    canRunInParallel: z.boolean().optional(),
    readOnly: z.boolean().optional(),
    handler: z.string().min(1),
    profiles: z.array(z.string()).optional(),
  })).default([]),
  riskLevel: z.enum(["low", "medium", "high", "critical"]).optional(),
  allowedModes: z.array(z.string()).optional(),
  dependencies: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// Permission enforcement errors
// ---------------------------------------------------------------------------

export class PermissionDeniedError extends Error {
  constructor(
    public readonly pluginName: string,
    public readonly permission: keyof PluginPermissions,
    public readonly operation: string,
  ) {
    super(
      `Plugin "${pluginName}" attempted ${operation} but missing permission: ${permission}`,
    );
    this.name = "PermissionDeniedError";
  }
}

export class PluginLoadError extends Error {
  public override readonly cause?: Error;

  constructor(
    public readonly pluginName: string,
    public readonly reason: string,
    cause?: Error,
  ) {
    super(`Failed to load plugin "${pluginName}": ${reason}`);
    this.name = "PluginLoadError";
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Permission-scoped sandbox helpers
// ---------------------------------------------------------------------------

/**
 * Sandbox execution wrapper that checks a plugin's declared permissions
 * before allowing the operation.
 */
export function sandboxedOperation<T>(
  plugin: LoadedPlugin,
  permission: keyof PluginPermissions,
  operationName: string,
  fn: () => T,
): T {
  if (!plugin.manifest.permissions[permission]) {
    throw new PermissionDeniedError(
      plugin.manifest.name,
      permission,
      operationName,
    );
  }
  return fn();
}

/**
 * Async version of sandboxedOperation.
 */
export async function sandboxedOperationAsync<T>(
  plugin: LoadedPlugin,
  permission: keyof PluginPermissions,
  operationName: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!plugin.manifest.permissions[permission]) {
    throw new PermissionDeniedError(
      plugin.manifest.name,
      permission,
      operationName,
    );
  }
  return await fn();
}

// ---------------------------------------------------------------------------
// PluginRuntime
// ---------------------------------------------------------------------------

export class PluginRuntime {
  private readonly plugins: Map<string, LoadedPlugin> = new Map();
  private readonly logger: Logger;
  private readonly workspacePath: string;
  private readonly _authRuntime: AuthRuntime | undefined;
  private readonly toolRegistry: ToolRegistry | undefined;
  private readonly auditTrail: PluginRuntimeOptions["auditTrail"];
  private readonly strictMode: boolean;
  /** Tracks which tools each plugin registered for cleanup on unload */
  private readonly pluginToolNames: Map<string, string[]> = new Map();

  constructor(options: PluginRuntimeOptions) {
    this.logger = new Logger("PluginRuntime");
    this.workspacePath = options.workspacePath;
    this._authRuntime = options.authRuntime;
    this.toolRegistry = options.toolRegistry;
    this.auditTrail = options.auditTrail;
    this.strictMode = options.strictMode ?? true;
  }

  // -----------------------------------------------------------------------
  // Loading
  // -----------------------------------------------------------------------

  /**
   * Load all plugins from the workspace/plugins/ directory.
   * Each plugin must have a plugin.json manifest.
   */
  async loadPlugins(): Promise<LoadedPlugin[]> {
    const pluginsDir = path.join(this.workspacePath, "plugins");

    let entries: string[];
    try {
      entries = await fs.readdir(pluginsDir, { withFileTypes: true }).then(
        (dir) => dir.filter((e) => e.isDirectory()).map((e) => e.name),
      );
    } catch {
      this.logger.info("No plugins directory found, skipping plugin loading");
      return [];
    }

    const loaded: LoadedPlugin[] = [];

    for (const pluginDir of entries) {
      try {
        const plugin = await this.loadPlugin(path.join(pluginsDir, pluginDir));
        loaded.push(plugin);
      } catch (err) {
        this.logger.warn(`Failed to load plugin from directory "${pluginDir}"`, {
          error: err instanceof Error ? err.message : String(err),
        });
        if (this.strictMode) {
          throw err;
        }
      }
    }

    this.logger.info(`Loaded ${loaded.length} plugin(s)`);
    return loaded;
  }

  /**
   * Load a single plugin from a directory containing plugin.json.
   */
  async loadPlugin(pluginDir: string): Promise<LoadedPlugin> {
    const manifestPath = path.join(pluginDir, "plugin.json");

    let raw: string;
    try {
      raw = await fs.readFile(manifestPath, "utf-8");
    } catch (err) {
      throw new PluginLoadError(
        path.basename(pluginDir),
        `Cannot read plugin.json: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err : undefined,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new PluginLoadError(
        path.basename(pluginDir),
        `Invalid JSON in plugin.json`,
        err instanceof Error ? err : undefined,
      );
    }

    const validation = PluginManifestSchema.safeParse(parsed);
    if (!validation.success) {
      throw new PluginLoadError(
        ((parsed as Record<string, unknown>)?.["name"] as string | undefined) ?? path.basename(pluginDir),
        `Invalid plugin manifest: ${validation.error.message}`,
      );
    }

    const manifest = validation.data as PluginManifest;

    // Validate entry file exists
    const entryPath = path.join(pluginDir, manifest.entry);
    try {
      await fs.access(entryPath);
    } catch {
      throw new PluginLoadError(
        manifest.name,
        `Entry file not found: ${manifest.entry}`,
      );
    }

    // Resolve hook handler functions from entry module
    const moduleExports = await this.loadModule(entryPath, manifest);

    const loadedPlugin: LoadedPlugin = {
      manifest,
      directory: pluginDir,
      module: moduleExports,
      loadedAt: new Date(),
    };

    this.plugins.set(manifest.name, loadedPlugin);

    // Register tools if ToolRegistry is available
    if (this.toolRegistry && manifest.tools?.length) {
      await this.registerPluginTools(loadedPlugin);
    }

    await this.audit("plugin", "plugin-runtime", "system", "plugin.load", manifest.name, {
      success: true,
      pluginName: manifest.name,
      version: manifest.version,
      permissions: manifest.permissions,
    });

    this.logger.info(`Plugin loaded: ${manifest.name} v${manifest.version}`);
    return loadedPlugin;
  }

  /**
   * Load a plugin's JavaScript/TypeScript module and extract its exports.
   * In the test environment and runtime we use dynamic import.
   */
  private async loadModule(
    entryPath: string,
    manifest: PluginManifest,
  ): Promise<Record<string, (...args: unknown[]) => unknown>> {
    // Dynamic import of the entry file
    try {
      const mod = await import(entryPath);
      const exports: Record<string, (...args: unknown[]) => unknown> = {};

      // Collect all function exports from the module
      for (const key of Object.keys(mod)) {
        if (typeof mod[key] === "function") {
          exports[key] = mod[key];
        }
      }

      // Verify all hook handlers are exported functions
      for (const hook of manifest.hooks) {
        if (typeof exports[hook.handler] !== "function") {
          throw new PluginLoadError(
            manifest.name,
            `Hook handler "${hook.handler}" is not exported as a function from ${manifest.entry}`,
          );
        }
      }

      return exports;
    } catch (err) {
      if (err instanceof PluginLoadError) throw err;
      throw new PluginLoadError(
        manifest.name,
        `Failed to load entry module: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err : undefined,
      );
    }
  }

  // -----------------------------------------------------------------------
   // Tool registration (plugins contribute tools)
  // -----------------------------------------------------------------------

  /**
   * Register all tools declared in the plugin manifest with the ToolRegistry.
 * Plugins contribute services (tools)
 * to a shared context (ToolRegistry).
 */
  async registerPluginTools(plugin: LoadedPlugin): Promise<void> {
    if (!this.toolRegistry || !plugin.manifest.tools?.length) return;

    const registeredNames: string[] = [];

    for (const toolDecl of plugin.manifest.tools) {
      const handler = plugin.module[toolDecl.handler];
      if (typeof handler !== "function") {
        this.logger.warn(
          `Plugin "${plugin.manifest.name}" tool "${toolDecl.name}" handler "${toolDecl.handler}" is not a function, skipping`,
        );
        continue;
      }

      // Check if tool name conflicts with an existing registered tool
      const existing = this.toolRegistry.get(toolDecl.name);
      if (existing) {
        this.logger.warn(
          `Plugin "${plugin.manifest.name}" tool "${toolDecl.name}" conflicts with existing tool, skipping`,
        );
        continue;
      }

      // Check permissions — plugin must have orderExecution permission for tools with side effects
      if (
        !plugin.manifest.permissions.orderExecution &&
        toolDecl.sideEffects && toolDecl.sideEffects.length > 0
      ) {
        this.logger.warn(
          `Plugin "${plugin.manifest.name}" tool "${toolDecl.name}" has side effects but no orderExecution permission, skipping`,
        );
        continue;
      }

      // Create a ToolHandler from the plugin's tool declaration
      const toolHandler: ToolHandler = {
        definition: {
          name: toolDecl.name,
          description: toolDecl.description,
          category: toolDecl.category as any,
          inputSchema: toolDecl.inputSchema,
          permissionsRequired: toolDecl.permissionsRequired ?? [],
          sideEffects: toolDecl.sideEffects ?? [],
          riskLevel: toolDecl.riskLevel ?? 'low',
          timeoutMs: toolDecl.timeoutMs ?? 30000,
          canRunInParallel: toolDecl.canRunInParallel ?? false,
          readOnly: toolDecl.readOnly ?? false,
          sdkCallable: toolDecl.sdkCallable ?? false,
        },
        execute: async (call) => {
          const start = Date.now();
          try {
            const result = await handler(call);
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
      registeredNames.push(toolDecl.name);

      this.logger.debug(
        `Plugin "${plugin.manifest.name}" registered tool: ${toolDecl.name}`,
      );
    }

    this.pluginToolNames.set(plugin.manifest.name, registeredNames);
  }

  // -----------------------------------------------------------------------
  // Unloading
  // -----------------------------------------------------------------------

  /**
   * Unload a plugin by name, removing its hook and tool registrations.
   * Returns true if the plugin was found and unloaded.
   */
  unloadPlugin(name: string): boolean {
    const plugin = this.plugins.get(name);
    if (!plugin) return false;

    // Unregister tools for this plugin
    const toolNames = this.pluginToolNames.get(name) ?? [];
    for (const toolName of toolNames) {
      this.toolRegistry?.unregister(toolName);
    }
    this.pluginToolNames.delete(name);

    this.plugins.delete(name);

    this.logger.info(`Plugin unloaded: ${name}`);
    return true;
  }

  // -----------------------------------------------------------------------
  // Query
  // -----------------------------------------------------------------------

  /**
   * Get a loaded plugin by name.
   */
  getPlugin(name: string): LoadedPlugin | undefined {
    return this.plugins.get(name);
  }

  /**
   * Get all currently loaded plugins.
   */
  getLoadedPlugins(): LoadedPlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Check if a plugin is loaded by name.
   */
  isLoaded(name: string): boolean {
    return this.plugins.has(name);
  }

  // -----------------------------------------------------------------------
  // Permission validation
  // -----------------------------------------------------------------------

  /**
   * Validate that a plugin's declared permissions are acceptable
   * given the current runtime mode and auth configuration.
   *
   * In paper/backtest mode, order execution can be downgraded.
   * In strict mode, all permission denials are enforced.
   */
  validatePermissions(
    manifest: PluginManifest,
    currentMode?: RuntimeMode,
  ): { valid: boolean; warnings: string[]; errors: string[] } {
    const warnings: string[] = [];
    const errors: string[] = [];

    // Restrict order execution in non-live modes
    if (
      manifest.permissions.orderExecution &&
      currentMode &&
      currentMode !== "live" &&
      currentMode !== "shadow" &&
      currentMode !== "micro_live"
    ) {
      warnings.push(
        `Plugin "${manifest.name}" has orderExecution permission but mode is "${currentMode}". ` +
        "Order execution will be blocked outside live/shadow/micro_live modes.",
      );
    }

    // Check for dangerous permission combinations
    if (manifest.permissions.credentials && manifest.permissions.network) {
      warnings.push(
        `Plugin "${manifest.name}" has both network and credentials permissions. ` +
        "This could allow exfiltration of credentials over the network.",
      );
    }

    if (manifest.permissions.orderExecution && manifest.permissions.network) {
      warnings.push(
        `Plugin "${manifest.name}" has both network and orderExecution permissions. ` +
        "This could allow order execution triggered by remote data.",
      );
    }

    return {
      valid: errors.length === 0,
      warnings,
      errors,
    };
  }

  // -----------------------------------------------------------------------
  // Sandboxed execution
  // -----------------------------------------------------------------------

  /**
   * Execute a plugin function with sandboxed permission checks.
   * The sandbox verifies the plugin has the required permission before
   * the operation proceeds.
   */
  executeSandboxed<T>(
    pluginName: string,
    permission: keyof PluginPermissions,
    operationName: string,
    fn: () => T,
  ): T {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) {
      throw new Error(`Plugin "${pluginName}" is not loaded`);
    }
    return sandboxedOperation(plugin, permission, operationName, fn);
  }

  /**
   * Async version of executeSandboxed.
   */
  async executeSandboxedAsync<T>(
    pluginName: string,
    permission: keyof PluginPermissions,
    operationName: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) {
      throw new Error(`Plugin "${pluginName}" is not loaded`);
    }
    return await sandboxedOperationAsync(plugin, permission, operationName, fn);
  }

  /**
   * Check if the plugin has a specific permission.
   */
  hasPermission(pluginName: string, permission: keyof PluginPermissions): boolean {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) return false;
    return plugin.manifest.permissions[permission] === true;
  }

  // -----------------------------------------------------------------------
  // Hot-apply: config-only changes without restart
  // -----------------------------------------------------------------------

  /**
   * Apply a config patch to a loaded plugin without restarting.
   * Only safe config fields are hot-applied: profiles, thresholds, timeouts.
   * Structural changes (entry, permissions, tools) require full reload.
   *
   * Returns true if the patch was applied, false if it requires a restart.
   */
  hotApplyConfig(
    pluginName: string,
    patch: Record<string, unknown>,
  ): { applied: boolean; requiresRestart: boolean; appliedFields: string[]; rejectedFields: string[] } {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) {
      throw new Error(`Plugin "${pluginName}" is not loaded`);
    }

    // Fields that are safe to hot-apply (no structural change)
    const hotApplyFields = new Set([
      "description",
      "riskLevel",
      "allowedModes",
      "dependencies",
      // Tool-level hot-apply fields
      "tools.*.timeoutMs",
      "tools.*.canRunInParallel",
      "tools.*.readOnly",
      "tools.*.profiles",
      "tools.*.riskLevel",
    ]);

    const appliedFields: string[] = [];
    const rejectedFields: string[] = [];

    for (const [key, value] of Object.entries(patch)) {
      const isHotApplyable = hotApplyFields.has(key) ||
        key.startsWith("tools.") && hotApplyFields.has("tools.*." + key.split(".").pop()!);

      if (isHotApplyable) {
        // Apply to manifest
        (plugin.manifest as unknown as Record<string, unknown>)[key] = value;
        appliedFields.push(key);
      } else {
        rejectedFields.push(key);
      }
    }

    if (appliedFields.length > 0) {
      void this.audit("config", "plugin-runtime", "system", "plugin.hot_apply", pluginName, {
        appliedFields,
        rejectedFields,
      });
      this.logger.info(`Hot-applied config to ${pluginName}: ${appliedFields.join(", ")}`);
    }

    return {
      applied: appliedFields.length > 0,
      requiresRestart: rejectedFields.length > 0,
      appliedFields,
      rejectedFields,
    };
  }

  /**
   * Reload a plugin from disk (unmount + mount).
   * Use when hot-apply is not sufficient (structural changes).
   */
  async reloadPlugin(pluginName: string): Promise<LoadedPlugin> {
    const existing = this.plugins.get(pluginName);
    if (!existing) {
      throw new Error(`Plugin "${pluginName}" is not loaded`);
    }

    // Unregister existing tools
    if (this.toolRegistry && existing.manifest.tools?.length) {
      for (const tool of existing.manifest.tools) {
        try {
          this.toolRegistry.unregister(tool.name);
        } catch {
          // Tool may not be registered
        }
      }
    }

    // Remove from loaded plugins
    this.plugins.delete(pluginName);

    // Reload from disk
    return this.loadPlugin(existing.directory);
  }

  // -----------------------------------------------------------------------
  // Internal: audit helper
  // -----------------------------------------------------------------------

  private async audit(
    type: string,
    actor: string,
    actorType: string,
    action: string,
    resource: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    if (!this.auditTrail) return;
    try {
      await this.auditTrail.record({
        type,
        actor,
        actorType,
        action,
        resource,
        result: "success",
        details,
      });
    } catch (err) {
      this.logger.error("Failed to record audit event", {
        error: err instanceof Error ? err.message : String(err),
        action,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Convenience: create a sandboxed fetch
  // -----------------------------------------------------------------------

  /**
   * Create a fetch-like function that is sandboxed by the plugin's
   * network permission. If the plugin doesn't have network permission,
   * the returned function will throw PermissionDeniedError.
   */
  createSandboxedFetch(
    pluginName: string,
  ): (input: string | URL, init?: Record<string, unknown>) => Promise<Response> {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) {
      throw new Error(`Plugin "${pluginName}" is not loaded`);
    }

    return (input: string | URL, init?: Record<string, unknown>): Promise<Response> => {
      return sandboxedOperationAsync(
        plugin,
        "network",
        `fetch(${String(input)})`,
        () => fetch(input as string | URL | globalThis.Request, init),
      );
    };
  }
}

export default PluginRuntime;
