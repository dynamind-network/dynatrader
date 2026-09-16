/**
 * Plugin Composition (dsh profile/patch analogue)
 *
 * The running plugin tree is composed at boot from ordered layers:
 *
 *   1. builtin   - kernel-owned capabilities that ship inside dynatrader
 *                  (exchange adapter, wallet stack)
 *   2. bundled   - first-party plugin packages (dynamind-api), enabled when
 *                  their configuration is present (e.g. DYNAMIND_API_* env)
 *   3. dir-scan  - workspace plugin directories containing plugin.json manifests
 *   4. config    - explicit `plugins:` rows in config.yaml (workspace or home)
 *
 * Layers apply in order onto an empty row list. A row replaces any earlier
 * row with the same id (whole config replaced, dsh patch semantics), and a
 * later row with `enabled: false` drops the id entirely. Every mounted row's
 * registrations unwind when it unmounts, so any row can be hot-swapped.
 */

import fs from "fs/promises";
import { statSync } from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import type { Logger } from "@dyna/audit";
import type { PluginRegistry } from "./registry";
import type { DynaPlugin, PluginFactory } from "./types";

export type PluginLayer = "builtin" | "bundled" | "dir-scan" | "config";

/** A declarative plugin row in the composed tree. */
export interface PluginRow {
  id: string;
  /** "builtin:<name>", "bundled:<name>", a directory containing plugin.json, or a JS/TS entry file. */
  entry: string;
  config: Record<string, unknown>;
  enabled: boolean;
  layer: PluginLayer;
}

/** Input row shape used by callers (config.yaml rows, bundled defaults). */
export interface PluginRowInput {
  id: string;
  entry: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Builtin plugin registry (populated in src/plugins/builtin/index.ts)
// ---------------------------------------------------------------------------

export type BuiltinPluginFactory = (
  config: Record<string, unknown>,
) => DynaPlugin | Promise<DynaPlugin>;

const builtinPlugins = new Map<string, BuiltinPluginFactory>();

/** Register an in-process builtin plugin factory under `<name>`. */
export function registerBuiltinPlugin(name: string, factory: BuiltinPluginFactory): void {
  builtinPlugins.set(name, factory);
}

export function getBuiltinPluginNames(): string[] {
  return [...builtinPlugins.keys()];
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * Apply ordered layers onto an empty row list. Later layers replace earlier
 * rows by id; `enabled: false` replaces the row with a disabled tombstone.
 */
export function composePluginRows(layers: PluginRowInput[][], meta: PluginLayer[]): PluginRow[] {
  const byId = new Map<string, PluginRow>();

  layers.forEach((layer, index) => {
    const layerName = meta[index]!;
    for (const input of layer) {
      byId.set(input.id, {
        id: input.id,
        entry: input.entry,
        config: { ...(input.config ?? {}) },
        enabled: input.enabled ?? true,
        layer: byId.get(input.id)?.layer ?? layerName,
      });
    }
  });

  return [...byId.values()].filter((row) => row.enabled);
}

/** Layer-0 defaults: builtin capabilities that always mount. */
export function builtinRows(): PluginRowInput[] {
  return [
    { id: "exchange", entry: "builtin:exchange" },
    { id: "wallet", entry: "builtin:wallet" },
  ];
}

/**
 * Layer-1 defaults: first-party bundled plugins. dynamind-api is enabled only
 * when its endpoint is configured, so offline paper trading keeps working
 * with the builtin exchange provider until the premium API is set up.
 */
export function bundledRows(env: NodeJS.ProcessEnv = process.env): PluginRowInput[] {
  const baseUrl = env["DYNAMIND_API_URL"];
  const apiKey = env["DYNAMIND_API_KEY"];
  if (!baseUrl && !apiKey) return [];
  return [
    {
      id: "dynamind-api",
      entry: "bundled:dynamind-api",
      config: {
        ...(baseUrl ? { baseUrl } : {}),
        ...(apiKey ? { apiKey } : {}),
      },
    },
  ];
}

/** Layer-2: rows discovered from plugin directories (manifest `config` becomes the row config). */
export async function dirScanRows(
  dirs: string[],
  logger?: Logger,
): Promise<PluginRowInput[]> {
  const rows: PluginRowInput[] = [];

  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const pluginDir = path.join(dir, entry);
      try {
        const manifestRaw = await fs.readFile(path.join(pluginDir, "plugin.json"), "utf-8");
        const manifest = JSON.parse(manifestRaw) as {
          name?: string;
          config?: Record<string, unknown>;
        };
        const id = typeof manifest.name === "string" && manifest.name ? manifest.name : entry;
        rows.push({
          id,
          entry: pluginDir,
          config: manifest.config ?? {},
          enabled: true,
        });
      } catch {
        // No plugin.json here - not a plugin directory
      }
    }
  }

  void logger;
  return rows;
}

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

export interface MountReport {
  row: PluginRow;
  ok: boolean;
  error?: string;
}

/**
 * Resolve a `bundled:<name>` entry to an importable module specifier,
 * trying the monorepo layout first and installed packages second.
 */
function resolveBundledEntry(name: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));

  // Monorepo layout: <root>/dist/... -> <root>/packages/<name>-plugin/dist/index.js
  const monorepoCandidate = path.resolve(here, "..", "packages", `${name}-plugin`, "dist", "index.js");
  const workspaceCandidate = path.resolve(here, "..", "..", "packages", `${name}-plugin`, "dist", "index.js");
  for (const candidate of [monorepoCandidate, workspaceCandidate]) {
    if (fsExistsSync(candidate)) {
      return candidate;
    }
  }

  // Published layout: plugin package installed as a dependency.
  try {
    const require = createRequire(import.meta.url);
    return require.resolve(`@dyna/plugin-${name}`);
  } catch {
    throw new Error(
      `Cannot resolve bundled plugin "${name}". Build it (bun run build:plugins) ` +
      `or install @dyna/plugin-${name}.`,
    );
  }
}

function fsExistsSync(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Mount every composed row onto the registry: builtin factories are called
 * in-process, bundled/dir/file entries are imported and their default export
 * factory is invoked with the row config. Rows that fail are reported, not
 * thrown, unless strict mode is requested.
 */
export async function mountPluginRows(
  registry: PluginRegistry,
  rows: PluginRow[],
  options: { logger?: Logger; strict?: boolean } = {},
): Promise<MountReport[]> {
  const logger = options.logger;
  const reports: MountReport[] = [];

  for (const row of rows) {
    try {
      await mountRow(registry, row);
      reports.push({ row, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger?.error(`Failed to mount plugin row "${row.id}" (${row.entry}): ${message}`);
      reports.push({ row, ok: false, error: message });
      if (options.strict) {
        throw err;
      }
    }
  }

  return reports;
}

async function mountRow(registry: PluginRegistry, row: PluginRow): Promise<void> {
  if (row.entry.startsWith("builtin:")) {
    const name = row.entry.slice("builtin:".length);
    const factory = builtinPlugins.get(name);
    if (!factory) {
      throw new Error(
        `Unknown builtin plugin "${name}". Available: ${getBuiltinPluginNames().join(", ") || "(none)"}`,
      );
    }
    const plugin = await factory(row.config);
    await registry.register(plugin, row.config);
    return;
  }

  let entryPath = row.entry;
  if (row.entry.startsWith("bundled:")) {
    entryPath = resolveBundledEntry(row.entry.slice("bundled:".length));
  }

  const stat = await fs.stat(entryPath).catch(() => null);
  if (stat?.isDirectory()) {
    const loaded = await registry.loadFromManifestDir(entryPath, row.config);
    if (loaded === undefined) {
      throw new Error(`Plugin directory "${entryPath}" has no loadable plugin.json/factory`);
    }
    return;
  }

  const resolved = path.resolve(entryPath);
  const mod = await import(resolved);
  const factory = (mod.default ?? mod) as PluginFactory | undefined;
  if (typeof factory !== "function") {
    throw new Error(`Plugin entry "${resolved}" does not export a factory function`);
  }
  const plugin = await factory(row.config);
  await registry.register(plugin, row.config);
}

/**
 * Compose and mount the full plugin tree from all layers.
 * This is the single boot entry point for plugins (dsh web analogue).
 */
export async function bootPluginTree(options: {
  registry: PluginRegistry;
  workspaceConfigRows?: PluginRowInput[];
  homeConfigRows?: PluginRowInput[];
  pluginDirs?: string[];
  logger?: Logger;
  env?: NodeJS.ProcessEnv;
  strict?: boolean;
}): Promise<{ rows: PluginRow[]; reports: MountReport[] }> {
  const dirRows = await dirScanRows(options.pluginDirs ?? [], options.logger);

  const rows = composePluginRows(
    [
      builtinRows(),
      bundledRows(options.env),
      dirRows,
      options.workspaceConfigRows ?? [],
      options.homeConfigRows ?? [],
    ],
    ["builtin", "bundled", "dir-scan", "config", "config"],
  );

  const reports = await mountPluginRows(options.registry, rows, {
    logger: options.logger,
    strict: options.strict,
  });

  await options.registry.activateAll();

  return { rows, reports };
}
