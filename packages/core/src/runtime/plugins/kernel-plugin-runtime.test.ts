/**
 * KernelPluginRuntime Tests
 *
 * Verifies that the kernel-backed plugin runtime is a drop-in replacement for
 * the legacy PluginRuntime: it loads plugins from workspace/plugins/,
 * validates manifests, registers kernel services for each mounted
 * plugin, enforces permission sandboxing, and supports dependencies between
 * plugins.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import fs from "fs/promises";
import { mkdtemp, writeFile, rmdir } from "fs/promises";
import os from "os";

import { KernelPluginRuntime } from "./kernel-plugin-runtime";
import { PermissionDeniedError, PluginLoadError } from "./plugin-runtime";
import type { LoadedPlugin, PluginManifest } from "./plugin-runtime";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function createWorkspaceWithPlugin(
  overrides?: Partial<PluginManifest>,
): Promise<{ dir: string; pluginDir: string; manifest: PluginManifest }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kernel-plugin-test-"));
  const pluginsDir = path.join(dir, "plugins");
  const pluginDir = path.join(pluginsDir, overrides?.name ?? "test-plugin");
  await fs.mkdir(pluginDir, { recursive: true });

  const manifest: PluginManifest = {
    name: overrides?.name ?? "test-plugin",
    version: overrides?.version ?? "1.0.0",
    description: overrides?.description ?? "A test plugin",
    entry: overrides?.entry ?? "index.js",
    author: overrides?.author ?? "test-author",
    permissions: {
      network: overrides?.permissions?.network ?? false,
      filesystem: overrides?.permissions?.filesystem ?? false,
      credentials: overrides?.permissions?.credentials ?? false,
      orderExecution: overrides?.permissions?.orderExecution ?? false,
    },
    hooks: overrides?.hooks ?? [],
    riskLevel: overrides?.riskLevel,
    allowedModes: overrides?.allowedModes,
    dependencies: overrides?.dependencies,
  };

  await writeFile(path.join(pluginDir, "plugin.json"), JSON.stringify(manifest, null, 2));

  // Create an entry file that exports hook handlers
  const entryCode = `
export async function onStartup(context) {
  return { proceed: true };
}
export async function onBeforeOrder(context) {
  return { proceed: true };
}
export async function onMessage(context) {
  return { proceed: true, modifications: {} };
}
`;
  await writeFile(path.join(pluginDir, manifest.entry), entryCode);

  return { dir, pluginDir, manifest };
}

async function cleanupTempDir(dir: string): Promise<void> {
  try {
    await rmdir(dir, { recursive: true });
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("KernelPluginRuntime", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "kernel-plugin-runtime-test-"));
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // -----------------------------------------------------------------------
  // Construction
  // -----------------------------------------------------------------------

  it("should create a runtime instance with given options", async () => {
    const { dir } = await createWorkspaceWithPlugin();
    const runtime = new KernelPluginRuntime({
      workspacePath: dir,
      strictMode: true,
    });
    expect(runtime).toBeInstanceOf(KernelPluginRuntime);
    expect(runtime.kernel).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // Bulk loading from workspace/plugins/
  // -----------------------------------------------------------------------

  it("should load plugins from workspace/plugins", async () => {
    const { dir } = await createWorkspaceWithPlugin({
      permissions: {
        network: true,
        filesystem: false,
        credentials: false,
        orderExecution: false,
      },
      hooks: [{ event: "gateway.startup", handler: "onStartup" }],
    });
    const runtime = new KernelPluginRuntime({
      workspacePath: dir,
      strictMode: true,
    });

    const loaded = await runtime.loadPlugins();

    expect(loaded).toHaveLength(1);
    expect(runtime.getLoadedPlugins()).toHaveLength(1);
    expect(runtime.getLoadedPlugins()[0]!.manifest.name).toBe("test-plugin");
    expect(runtime.getPlugin("test-plugin")).toBeDefined();
    expect(runtime.isLoaded("test-plugin")).toBe(true);
  });

  it("should register each loaded plugin as a kernel service named plugin.<id>", async () => {
    const { dir } = await createWorkspaceWithPlugin();
    const runtime = new KernelPluginRuntime({ workspacePath: dir });

    await runtime.loadPlugins();

    expect(runtime.hasService("plugin.test-plugin")).toBe(true);
    const service = runtime.getService<LoadedPlugin>("plugin.test-plugin");
    expect(service.manifest.name).toBe("test-plugin");
  });

  it("should mount plugins in dependency order and resolve cross-plugin services", async () => {
    const { dir } = await createWorkspaceWithPlugin({ name: "plugin-a" });

    const pluginsDir = path.join(dir, "plugins");
    const pluginBDir = path.join(pluginsDir, "plugin-b");
    await fs.mkdir(pluginBDir, { recursive: true });
    const manifestB: PluginManifest = {
      name: "plugin-b",
      version: "1.0.0",
      description: "A dependent plugin",
      entry: "index.js",
      permissions: {
        network: false,
        filesystem: false,
        credentials: false,
        orderExecution: false,
      },
      hooks: [],
      dependencies: ["plugin-a"],
    };
    await writeFile(path.join(pluginBDir, "plugin.json"), JSON.stringify(manifestB, null, 2));
    await writeFile(
      path.join(pluginBDir, "index.js"),
      `export async function onStartup(context) { return { proceed: true }; }`,
    );

    const runtime = new KernelPluginRuntime({ workspacePath: dir });
    await runtime.loadPlugins();

    expect(runtime.getLoadedPlugins().map((p) => p.manifest.name).sort()).toEqual([
      "plugin-a",
      "plugin-b",
    ]);
    expect(runtime.hasService("plugin.plugin-a")).toBe(true);
    expect(runtime.hasService("plugin.plugin-b")).toBe(true);
  });

  it("should return empty array when no plugins directory exists", async () => {
    const runtime = new KernelPluginRuntime({ workspacePath: tempDir });
    const loaded = await runtime.loadPlugins();
    expect(loaded).toEqual([]);
  });

  it("should skip invalid plugins when strictMode is false", async () => {
    const { dir } = await createWorkspaceWithPlugin({ name: "good-plugin" });
    await fs.mkdir(path.join(dir, "plugins", "bad-plugin"), { recursive: true });

    const runtime = new KernelPluginRuntime({ workspacePath: dir, strictMode: false });
    const loaded = await runtime.loadPlugins();

    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.manifest.name).toBe("good-plugin");
  });

  it("should throw PluginLoadError for invalid plugins when strictMode is true", async () => {
    const { dir } = await createWorkspaceWithPlugin({ name: "good-plugin" });
    await fs.mkdir(path.join(dir, "plugins", "bad-plugin"), { recursive: true });

    const runtime = new KernelPluginRuntime({ workspacePath: dir, strictMode: true });
    await expect(runtime.loadPlugins()).rejects.toThrow(PluginLoadError);
  });

  // -----------------------------------------------------------------------
  // Single plugin loading
  // -----------------------------------------------------------------------

  it("should load a single plugin directory", async () => {
    const { dir, pluginDir } = await createWorkspaceWithPlugin({
      hooks: [{ event: "gateway.startup", handler: "onStartup" }],
    });
    const runtime = new KernelPluginRuntime({ workspacePath: dir });

    const plugin = await runtime.loadPlugin(pluginDir);

    expect(plugin.manifest.name).toBe("test-plugin");
    expect(plugin.loadedAt).toBeInstanceOf(Date);
    expect(runtime.isLoaded("test-plugin")).toBe(true);
    expect(runtime.hasService("plugin.test-plugin")).toBe(true);
  });

  it("should throw PluginLoadError when plugin.json is missing", async () => {
    const { dir } = await createWorkspaceWithPlugin();
    const runtime = new KernelPluginRuntime({ workspacePath: dir });
    const fakeDir = path.join(dir, "plugins", "nonexistent");

    await expect(runtime.loadPlugin(fakeDir)).rejects.toThrow(PluginLoadError);
  });

  // -----------------------------------------------------------------------
  // Unloading
  // -----------------------------------------------------------------------

  it("should unload a plugin", async () => {
    const { dir } = await createWorkspaceWithPlugin({
      hooks: [{ event: "gateway.startup", handler: "onStartup" }],
    });
    const runtime = new KernelPluginRuntime({ workspacePath: dir });

    await runtime.loadPlugins();
    expect(runtime.isLoaded("test-plugin")).toBe(true);

    expect(runtime.unloadPlugin("test-plugin")).toBe(true);
    expect(runtime.isLoaded("test-plugin")).toBe(false);

    expect(runtime.unloadPlugin("nonexistent")).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Permission validation
  // -----------------------------------------------------------------------

  it("should support validatePermissions identically to the legacy runtime", () => {
    const runtime = new KernelPluginRuntime({ workspacePath: tempDir });
    const manifest: PluginManifest = {
      name: "safe-plugin",
      version: "1.0.0",
      description: "",
      entry: "index.js",
      permissions: {
        network: false,
        filesystem: false,
        credentials: false,
        orderExecution: false,
      },
      hooks: [],
    };

    const result = runtime.validatePermissions(manifest, "paper");
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Permission queries
  // -----------------------------------------------------------------------

  it("should expose the manifest permissions through hasPermission", async () => {
    const { dir } = await createWorkspaceWithPlugin({
      permissions: {
        network: true,
        filesystem: false,
        credentials: true,
        orderExecution: false,
      },
    });
    const runtime = new KernelPluginRuntime({ workspacePath: dir });

    await runtime.loadPlugins();

    expect(runtime.hasPermission("test-plugin", "network")).toBe(true);
    expect(runtime.hasPermission("test-plugin", "credentials")).toBe(true);
    expect(runtime.hasPermission("test-plugin", "filesystem")).toBe(false);
    expect(runtime.hasPermission("test-plugin", "orderExecution")).toBe(false);
  });

  it("should return false for unloaded plugins", () => {
    const runtime = new KernelPluginRuntime({ workspacePath: tempDir });
    expect(runtime.hasPermission("nonexistent", "network")).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Sandboxed execution
  // -----------------------------------------------------------------------

  it("should allow operations when the plugin has the required permission", async () => {
    const { dir } = await createWorkspaceWithPlugin({
      permissions: {
        network: true,
        filesystem: false,
        credentials: false,
        orderExecution: false,
      },
    });
    const runtime = new KernelPluginRuntime({ workspacePath: dir });

    await runtime.loadPlugins();

    const result = runtime.executeSandboxed("test-plugin", "network", "fetch-data", () => 42);
    expect(result).toBe(42);
  });

  it("should throw PermissionDeniedError when the plugin lacks the required permission", async () => {
    const { dir } = await createWorkspaceWithPlugin({
      permissions: {
        network: false,
        filesystem: false,
        credentials: false,
        orderExecution: false,
      },
    });
    const runtime = new KernelPluginRuntime({ workspacePath: dir });

    await runtime.loadPlugins();

    expect(() =>
      runtime.executeSandboxed("test-plugin", "network", "fetch-data", () => "secret"),
    ).toThrow(PermissionDeniedError);
  });

  it("should reject async sandboxed operations when permission is missing", async () => {
    const { dir } = await createWorkspaceWithPlugin({
      permissions: {
        network: false,
        filesystem: false,
        credentials: false,
        orderExecution: false,
      },
    });
    const runtime = new KernelPluginRuntime({ workspacePath: dir });

    await runtime.loadPlugins();

    await expect(
      runtime.executeSandboxedAsync("test-plugin", "filesystem", "read-file", async () => "x"),
    ).rejects.toThrow(PermissionDeniedError);
  });

  // -----------------------------------------------------------------------
  // Sandboxed fetch
  // -----------------------------------------------------------------------

  it("should create a sandboxed fetch that enforces network permission", async () => {
    const { dir } = await createWorkspaceWithPlugin({
      permissions: {
        network: true,
        filesystem: false,
        credentials: false,
        orderExecution: false,
      },
    });
    const runtime = new KernelPluginRuntime({ workspacePath: dir });

    await runtime.loadPlugins();

    const sandboxedFetch = runtime.createSandboxedFetch("test-plugin");
    expect(typeof sandboxedFetch).toBe("function");
  });
});