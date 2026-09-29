import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { homedir } from 'node:os';
import type { ModelInfo, ProviderEntry } from './types.js';

interface ModelsDevModel {
  id?: unknown;
  name?: unknown;
  tool_call?: unknown;
  modalities?: { output?: unknown };
  limit?: { context?: unknown; output?: unknown };
  status?: unknown;
  release_date?: unknown;
}

interface ModelsDevProvider {
  name?: unknown;
  models?: Record<string, ModelsDevModel>;
}

type ModelsDevCatalog = Record<string, ModelsDevProvider>;

interface CachedCatalog {
  fetchedAt: number;
  catalog: ModelsDevCatalog;
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_CATALOG_BYTES = 20 * 1024 * 1024;
const CATALOG_URL = (process.env['DYNATRADER_MODELS_URL'] ?? 'https://models.dev').replace(/\/$/, '');
const CACHE_PATH = path.join(homedir(), '.dynatrader', 'models-cache.json');
const SUPPORTED_CATALOG_PROVIDERS: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  deepseek: 'deepseek',
  google: 'google',
  openrouter: 'openrouter',
  nvidia: 'nvidia',
  glm: 'zai',
};

let cached: CachedCatalog | null = null;
let refreshPromise: Promise<CachedCatalog | null> | null = null;

async function readDiskCache(): Promise<CachedCatalog | null> {
  if (cached) return cached;
  try {
    const value = JSON.parse(await fs.readFile(CACHE_PATH, 'utf8')) as CachedCatalog;
    if (typeof value.fetchedAt !== 'number' || !value.catalog || typeof value.catalog !== 'object') return null;
    cached = value;
    return value;
  } catch {
    return null;
  }
}

async function downloadCatalog(fetchImpl: typeof fetch): Promise<CachedCatalog | null> {
  try {
    const response = await fetchImpl(`${CATALOG_URL}/api.json`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    const body = await response.text();
    if (body.length > MAX_CATALOG_BYTES) return null;
    const catalog = JSON.parse(body) as ModelsDevCatalog;
    if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return null;
    const next: CachedCatalog = { fetchedAt: Date.now(), catalog };
    await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
    await fs.writeFile(CACHE_PATH, JSON.stringify(next), 'utf8');
    cached = next;
    return next;
  } catch {
    return null;
  }
}

export async function getModelsDevCatalog(options: {
  fetchImpl?: typeof fetch;
  forceRefresh?: boolean;
} = {}): Promise<ModelsDevCatalog | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const disk = await readDiskCache();
  const isFresh = disk && Date.now() - disk.fetchedAt < CACHE_TTL_MS;
  if (isFresh && !options.forceRefresh) return disk.catalog;
  if (!options.forceRefresh) return disk?.catalog ?? null;
  if (!refreshPromise) {
    refreshPromise = downloadCatalog(fetchImpl).finally(() => { refreshPromise = null; });
  }
  const refreshed = await refreshPromise;
  return refreshed?.catalog ?? disk?.catalog ?? null;
}

function isSupportedChatModel(model: ModelsDevModel): boolean {
  const output = model.modalities?.output;
  return model.status !== 'deprecated'
    && model.tool_call === true
    && Array.isArray(output)
    && output.includes('text')
    && typeof model.limit?.context === 'number'
    && model.limit.context > 0;
}

export async function refreshProviderModelLists(
  providers: Record<string, ProviderEntry>,
  bundledModelIds: Record<string, Set<string>>,
  options: { fetchImpl?: typeof fetch; forceRefresh?: boolean } = {},
): Promise<boolean> {
  const catalog = await getModelsDevCatalog(options);
  if (!catalog) return false;

  return applyModelsDevCatalog(providers, bundledModelIds, catalog);
}

export function applyModelsDevCatalog(
  providers: Record<string, ProviderEntry>,
  bundledModelIds: Record<string, Set<string>>,
  catalog: ModelsDevCatalog,
): boolean {

  for (const [providerName, catalogName] of Object.entries(SUPPORTED_CATALOG_PROVIDERS)) {
    const entry = providers[providerName];
    const catalogProvider = catalog[catalogName];
    if (!entry || !catalogProvider?.models) continue;

    const available = Object.entries(catalogProvider.models)
      .filter(([, model]) => isSupportedChatModel(model))
      .sort(([, left], [, right]) => String(right.release_date ?? '').localeCompare(String(left.release_date ?? '')));
    const models: ModelInfo[] = available
      .map(([id, model]) => ({
        id,
        name: typeof model.name === 'string' ? model.name : id,
        contextWindow: model.limit!.context as number,
        maxOutput: typeof model.limit?.output === 'number' ? model.limit.output : 4096,
      }));
    if (models.length === 0) continue;

    // Preserve explicitly configured models; replace the bundled snapshot entries.
    const bundled = bundledModelIds[providerName] ?? new Set<string>();
    const customModels = entry.models.filter((model) => !bundled.has(model.id));
    const dynamicIds = new Set(models.map((model) => model.id));
    entry.models = [...models, ...customModels.filter((model) => !dynamicIds.has(model.id))];
    if (bundled.has(entry.defaultModel) && !dynamicIds.has(entry.defaultModel)) {
      entry.defaultModel = models[0]!.id;
    }
  }

  return true;
}

export async function modelsDevCatalogIsStale(): Promise<boolean> {
  const value = await readDiskCache();
  return !value || Date.now() - value.fetchedAt >= CACHE_TTL_MS;
}
