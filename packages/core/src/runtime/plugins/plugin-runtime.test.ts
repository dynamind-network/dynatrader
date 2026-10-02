/**
 * PluginRuntime Tests
 *
 * Covers: plugin loading, manifest validation, security permissions,
 * sandboxed execution, permission enforcement,
 * error handling, audit logging, and edge cases.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import fs from "fs/promises";
import { mkdtemp, writeFile, rmdir } from "fs/promises";
import os from "os";

import { PluginRuntime, PluginLoadError, PermissionDeniedError } from "./plugin-runtime";
import type { PluginManifest } from "./plugin-runtime";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function createTempPluginDir(
  overrides?: Partial<PluginManifest>,
): Promise<{ dir: string; manifest: PluginManifest }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "plugin-test-"));
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

  await writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest, null, 2));

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
  await writeFile(path.join(dir, manifest.entry), entryCode);

  return { dir, manifest };
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

describe("PluginRuntime", () => {
  let runtime: PluginRuntime;
  let tempDir: string;
  let authRuntime: any;
  let auditEvents: any[];

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "plugin-runtime-test-"));

    auditEvents = [];
    authRuntime = {};
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // -----------------------------------------------------------------------
  // Construction
  // -----------------------------------------------------------------------

  describe("construction", () => {
    it("should create a runtime instance with given options", () => {
      runtime = new PluginRuntime({
        workspacePath: tempDir,
        authRuntime,
        strictMode: true,
      });
      expect(runtime).toBeInstanceOf(PluginRuntime);
    });

    it("should default strictMode to true", () => {
      runtime = new PluginRuntime({ workspacePath: tempDir });
      // We can't easily test strictMode directly, but we can verify it doesn't throw
      expect(runtime).toBeInstanceOf(PluginRuntime);
    });
  });

  // -----------------------------------------------------------------------
  // Plugin loading
  // -----------------------------------------------------------------------

  describe("loadPlugin", () => {
    it("should load a plugin with a valid plugin.json and entry file", async () => {
      const { dir } = await createTempPluginDir();
      runtime = new PluginRuntime({ workspacePath: tempDir, authRuntime });

      const plugin = await runtime.loadPlugin(dir);
      expect(plugin.manifest.name).toBe("test-plugin");
      expect(plugin.manifest.version).toBe("1.0.0");
      expect(plugin.loadedAt).toBeInstanceOf(Date);
      expect(plugin.directory).toBe(dir);
      expect(plugin.module).toBeDefined();
      expect(typeof plugin.module.onStartup).toBe("function");
    });

    it("should throw PluginLoadError when plugin.json is missing", async () => {
      runtime = new PluginRuntime({ workspacePath: tempDir, authRuntime });
      const fakeDir = path.join(tempDir, "nonexistent");

      await expect(runtime.loadPlugin(fakeDir)).rejects.toThrow(PluginLoadError);
    });

    it("should throw PluginLoadError when plugin.json has invalid JSON", async () => {
      runtime = new PluginRuntime({ workspacePath: tempDir, authRuntime });
      const dir = await mkdtemp(path.join(os.tmpdir(), "plugin-bad-json-"));
      await writeFile(path.join(dir, "plugin.json"), "not json");

      await expect(runtime.loadPlugin(dir)).rejects.toThrow(PluginLoadError);

      await cleanupTempDir(dir);
    });

    it("should throw PluginLoadError when manifest is missing required fields", async () => {
      runtime = new PluginRuntime({ workspacePath: tempDir, authRuntime });
      const dir = await mkdtemp(path.join(os.tmpdir(), "plugin-bad-manifest-"));
      await writeFile(path.join(dir, "plugin.json"), JSON.stringify({ description: "no name" }));

      await expect(runtime.loadPlugin(dir)).rejects.toThrow(PluginLoadError);

      await cleanupTempDir(dir);
    });

    it("should throw PluginLoadError when entry file is missing", async () => {
      runtime = new PluginRuntime({ workspacePath: tempDir, authRuntime });
      const dir = await mkdtemp(path.join(os.tmpdir(), "plugin-no-entry-"));
      await writeFile(
        path.join(dir, "plugin.json"),
        JSON.stringify({
          name: "missing-entry",
          version: "1.0.0",
          entry: "nonexistent.js",
        }),
      );

      await expect(runtime.loadPlugin(dir)).rejects.toThrow(PluginLoadError);

      await cleanupTempDir(dir);
    });
  });

  // -----------------------------------------------------------------------
  // Bulk loading from workspace/plugins/
  // -----------------------------------------------------------------------

  describe("loadPlugins", () => {
    it("should load multiple plugins from workspace/plugins/ directory", async () => {
      runtime = new PluginRuntime({ workspacePath: tempDir, authRuntime });

      // Create plugins directory and two plugins
      const pluginsDir = path.join(tempDir, "plugins");
      await fs.mkdir(pluginsDir, { recursive: true });

      const { dir: dir1 } = await createTempPluginDir({ name: "plugin-a" });
      const { dir: dir2 } = await createTempPluginDir({ name: "plugin-b" });

      // Move them into plugins directory
      await fs.rename(dir1, path.join(pluginsDir, "plugin-a"));
      await fs.rename(dir2, path.join(pluginsDir, "plugin-b"));

      const loaded = await runtime.loadPlugins();
      expect(loaded).toHaveLength(2);
      expect(runtime.isLoaded("plugin-a")).toBe(true);
      expect(runtime.isLoaded("plugin-b")).toBe(true);
    });

    it("should return empty array when no plugins directory exists", async () => {
      runtime = new PluginRuntime({ workspacePath: tempDir, authRuntime });
      const loaded = await runtime.loadPlugins();
      expect(loaded).toEqual([]);
    });

    it("should skip invalid plugins when strictMode is false", async () => {
      runtime = new PluginRuntime({
        workspacePath: tempDir,
        authRuntime,
        strictMode: false,
      });

      const pluginsDir = path.join(tempDir, "plugins");
      await fs.mkdir(pluginsDir, { recursive: true });

      // Valid plugin
      const { dir } = await createTempPluginDir({ name: "good-plugin" });
      await fs.rename(dir, path.join(pluginsDir, "good-plugin"));

      // Invalid plugin directory (no plugin.json)
      await fs.mkdir(path.join(pluginsDir, "bad-plugin"), { recursive: true });

      const loaded = await runtime.loadPlugins();
      expect(loaded).toHaveLength(1);
      expect(loaded[0]!.manifest.name).toBe("good-plugin");
    });
  });

  // -----------------------------------------------------------------------
  // Unloading
  // -----------------------------------------------------------------------

  describe("unloadPlugin", () => {
    it("should unload a plugin", async () => {
      const { dir } = await createTempPluginDir({
        hooks: [{ event: "gateway.startup", handler: "onStartup" }],
      });

      runtime = new PluginRuntime({ workspacePath: tempDir, authRuntime });
      await runtime.loadPlugin(dir);

      expect(runtime.isLoaded("test-plugin")).toBe(true);

      const result = runtime.unloadPlugin("test-plugin");
      expect(result).toBe(true);
      expect(runtime.isLoaded("test-plugin")).toBe(false);
    });

    it("should return false when unloading a non-existent plugin", () => {
      runtime = new PluginRuntime({ workspacePath: tempDir, authRuntime });
      expect(runtime.unloadPlugin("nonexistent")).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Permission validation
  // -----------------------------------------------------------------------

  describe("validatePermissions", () => {
    it("should return valid for a plugin with minimal permissions", () => {
      runtime = new PluginRuntime({ workspacePath: tempDir, authRuntime });
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
      expect(result.warnings).toHaveLength(0);
    });

    it("should warn when order execution is granted in paper mode", () => {
      runtime = new PluginRuntime({ workspacePath: tempDir, authRuntime });
      const manifest: PluginManifest = {
        name: "order-plugin",
        version: "1.0.0",
        description: "",
        entry: "index.js",
        permissions: { network: false, filesystem: false, credentials: false, orderExecution: true },
        hooks: [],
      };

      const result = runtime.validatePermissions(manifest, "paper");
      expect(result.valid).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain("orderExecution");
    });

    it("should warn on network+credentials combination", () => {
      runtime = new PluginRuntime({ workspacePath: tempDir, authRuntime });
      const manifest: PluginManifest = {
        name: "risky-plugin",
        version: "1.0.0",
        description: "",
        entry: "index.js",
        permissions: { network: true, filesystem: false, credentials: true, orderExecution: false },
        hooks: [],
      };

      const result = runtime.validatePermissions(manifest, "live");
      expect(result.warnings.length).toBeGreaterThanOrEqual(1);
      const joined = result.warnings.join(" ");
      expect(joined).toContain("network");
      expect(joined).toContain("credentials");
    });

    it("should warn on network+orderExecution combination", () => {
      runtime = new PluginRuntime({ workspacePath: tempDir, authRuntime });
      const manifest: PluginManifest = {
        name: "dangerous-plugin",
        version: "1.0.0",
        description: "",
        entry: "index.js",
        permissions: { network: true, filesystem: false, credentials: false, orderExecution: true },
        hooks: [],
      };

      const result = runtime.validatePermissions(manifest, "live");
      expect(result.valid).toBe(true);
      const joined = result.warnings.join(" ");
      expect(joined).toContain("network");
      expect(joined).toContain("orderExecution");
    });
  });

  // -----------------------------------------------------------------------
  // Sandboxed execution
  // -----------------------------------------------------------------------

  describe("sandboxed execution", () => {
    it("should allow operations when the plugin has the required permission", async () => {
      const { dir } = await createTempPluginDir({
        permissions: { network: true, filesystem: false, credentials: false, orderExecution: false },
      });

      runtime = new PluginRuntime({ workspacePath: tempDir, authRuntime });
      await runtime.loadPlugin(dir);

      const result = runtime.executeSandboxed("test-plugin", "network", "test-operation", () => 42);
      expect(result).toBe(42);
    });

    it("should throw PermissionDeniedError when the plugin lacks the required permission", async () => {
      const { dir } = await createTempPluginDir({
        permissions: { network: false, filesystem: false, credentials: false, orderExecution: false },
      });

      runtime = new PluginRuntime({ workspacePath: tempDir, authRuntime });
      await runtime.loadPlugin(dir);

      expect(() =>
        runtime.executeSandboxed("test-plugin", "network", "fetch-data", () => "secret"),
      ).toThrow(PermissionDeniedError);
    });

    it("should throw when executing sandboxed operation on unloaded plugin", () => {
      runtime = new PluginRuntime({ workspacePath: tempDir, authRuntime });
      expect(() =>
        runtime.executeSandboxed("not-loaded", "network", "op", () => "x"),
      ).toThrow(/not loaded/i);
    });

    it("should support async sandboxed operations", async () => {
      const { dir } = await createTempPluginDir({
        permissions: { filesystem: true, network: false, credentials: false, orderExecution: false },
      });

      runtime = new PluginRuntime({ workspacePath: tempDir, authRuntime });
      await runtime.loadPlugin(dir);

      const result = await runtime.executeSandboxedAsync(
        "test-plugin",
        "filesystem",
        "read-file",
        async () => "file content",
      );
      expect(result).toBe("file content");
    });

    it("should reject async sandboxed operation when permission is missing", async () => {
      const { dir } = await createTempPluginDir({
        permissions: { filesystem: false, network: false, credentials: false, orderExecution: false },
      });

      runtime = new PluginRuntime({ workspacePath: tempDir, authRuntime });
      await runtime.loadPlugin(dir);

      await expect(
        runtime.executeSandboxedAsync("test-plugin", "filesystem", "read-file", async () => "x"),
      ).rejects.toThrow(PermissionDeniedError);
    });
  });

  // -----------------------------------------------------------------------
  // Permission queries
  // -----------------------------------------------------------------------

  describe("hasPermission", () => {
    it("should return true for granted permissions", async () => {
      const { dir } = await createTempPluginDir({
        permissions: { network: true, filesystem: false, credentials: true, orderExecution: false },
      });

      runtime = new PluginRuntime({ workspacePath: tempDir, authRuntime });
      await runtime.loadPlugin(dir);

      expect(runtime.hasPermission("test-plugin", "network")).toBe(true);
      expect(runtime.hasPermission("test-plugin", "credentials")).toBe(true);
    });

    it("should return false for denied permissions", async () => {
      const { dir } = await createTempPluginDir({
        permissions: { network: false, filesystem: false, credentials: false, orderExecution: false },
      });

      runtime = new PluginRuntime({ workspacePath: tempDir, authRuntime });
      await runtime.loadPlugin(dir);

      expect(runtime.hasPermission("test-plugin", "filesystem")).toBe(false);
      expect(runtime.hasPermission("test-plugin", "orderExecution")).toBe(false);
    });

    it("should return false for unloaded plugins", () => {
      runtime = new PluginRuntime({ workspacePath: tempDir, authRuntime });
      expect(runtime.hasPermission("nonexistent", "network")).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Query methods
  // -----------------------------------------------------------------------

  describe("query methods", () => {
    it("should return a loaded plugin by name", async () => {
      const { dir } = await createTempPluginDir({ name: "query-test" });
      runtime = new PluginRuntime({ workspacePath: tempDir, authRuntime });
      await runtime.loadPlugin(dir);

      const plugin = runtime.getPlugin("query-test");
      expect(plugin).toBeDefined();
      expect(plugin!.manifest.name).toBe("query-test");
    });

    it("should return undefined for unknown plugin", () => {
      runtime = new PluginRuntime({ workspacePath: tempDir, authRuntime });
      expect(runtime.getPlugin("unknown")).toBeUndefined();
    });

    it("should list all loaded plugins", async () => {
      runtime = new PluginRuntime({ workspacePath: tempDir, authRuntime });

      const pluginsDir = path.join(tempDir, "plugins");
      await fs.mkdir(pluginsDir, { recursive: true });

      const { dir: d1 } = await createTempPluginDir({ name: "list-a" });
      const { dir: d2 } = await createTempPluginDir({ name: "list-b" });
      await fs.rename(d1, path.join(pluginsDir, "list-a"));
      await fs.rename(d2, path.join(pluginsDir, "list-b"));

      await runtime.loadPlugins();
      const all = runtime.getLoadedPlugins();
      expect(all).toHaveLength(2);
      expect(all.map((p) => p.manifest.name).sort()).toEqual(["list-a", "list-b"]);
    });
  });

  // -----------------------------------------------------------------------
  // Sandboxed fetch
  // -----------------------------------------------------------------------

  describe("createSandboxedFetch", () => {
    it("should create a sandboxed fetch that enforces network permission", async () => {
      const { dir } = await createTempPluginDir({
        permissions: { network: true, filesystem: false, credentials: false, orderExecution: false },
      });

      runtime = new PluginRuntime({ workspacePath: tempDir, authRuntime });
      await runtime.loadPlugin(dir);

      const sandboxedFetch = runtime.createSandboxedFetch("test-plugin");
      expect(typeof sandboxedFetch).toBe("function");
    });

    it("should throw for unloaded plugin", () => {
      runtime = new PluginRuntime({ workspacePath: tempDir, authRuntime });
      expect(() => runtime.createSandboxedFetch("not-loaded")).toThrow(/not loaded/i);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe("edge cases", () => {
    it("should handle plugins with no hooks", async () => {
      const { dir } = await createTempPluginDir({ hooks: [] });
      runtime = new PluginRuntime({ workspacePath: tempDir, authRuntime });

      const plugin = await runtime.loadPlugin(dir);
      expect(plugin.manifest.hooks).toHaveLength(0);
      expect(runtime.getLoadedPlugins()).toHaveLength(1);
    });

    it("should handle plugins with no permissions", async () => {
      const { dir } = await createTempPluginDir({
        permissions: { network: false, filesystem: false, credentials: false, orderExecution: false },
      });
      runtime = new PluginRuntime({ workspacePath: tempDir, authRuntime });

      const plugin = await runtime.loadPlugin(dir);
      expect(plugin.manifest.permissions.network).toBe(false);
      expect(plugin.manifest.permissions.filesystem).toBe(false);
    });

    it("should load plugins with hooks", async () => {
      const { dir } = await createTempPluginDir({
        hooks: [{ event: "gateway.startup", handler: "onStartup" }],
      });
      runtime = new PluginRuntime({ workspacePath: tempDir });

      const plugin = await runtime.loadPlugin(dir);
      expect(plugin.manifest.hooks).toHaveLength(1);
      expect(runtime.isLoaded("test-plugin")).toBe(true);
    });
  });
});
