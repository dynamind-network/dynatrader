import type { ProviderEntry } from './types.js';
import {
  loadProvidersFromYAML,
  invalidateProvidersCache,
  getBundledModelIds,
  getConfiguredModelIds,
  getConfiguredDefaultModels,
} from './yaml-loader.js';
import { modelsDevCatalogIsStale, refreshProviderModelLists } from './models-dev.js';

export const PROVIDERS: Record<string, ProviderEntry> = {};

export async function initProvidersFromYAML(): Promise<void> {
  const providers = await loadProvidersFromYAML();
  await refreshProviderModelLists(providers, getBundledModelIds(), {
    configuredModelIds: getConfiguredModelIds(),
    configuredDefaultModels: getConfiguredDefaultModels(),
  });
  for (const key of Object.keys(PROVIDERS)) {
    delete PROVIDERS[key];
  }
  Object.assign(PROVIDERS, providers);
  scheduleModelRefresh();
}

export async function reloadProviders(): Promise<void> {
  invalidateProvidersCache();
  const providers = await loadProvidersFromYAML({ force: true });
  await refreshProviderModelLists(providers, getBundledModelIds(), {
    configuredModelIds: getConfiguredModelIds(),
    configuredDefaultModels: getConfiguredDefaultModels(),
  });
  for (const key of Object.keys(PROVIDERS)) {
    delete PROVIDERS[key];
  }
  Object.assign(PROVIDERS, providers);
}

let modelRefreshTimer: ReturnType<typeof setInterval> | undefined;
let modelRefreshInFlight: Promise<boolean> | undefined;

/** Refresh built-in provider models from the shared models.dev catalog. */
export async function refreshModels(force = false): Promise<boolean> {
  if (modelRefreshInFlight) return modelRefreshInFlight;
  if (!force && !(await modelsDevCatalogIsStale())) return true;
  modelRefreshInFlight = refreshProviderModelLists(PROVIDERS, getBundledModelIds(), {
    forceRefresh: true,
    configuredModelIds: getConfiguredModelIds(),
    configuredDefaultModels: getConfiguredDefaultModels(),
  })
    .then(async (updated) => updated && !(await modelsDevCatalogIsStale()))
    .finally(() => { modelRefreshInFlight = undefined; });
  return modelRefreshInFlight;
}

function scheduleModelRefresh(): void {
  if (!modelRefreshTimer) {
    modelRefreshTimer = setInterval(() => { void refreshModels(); }, 60 * 60 * 1000);
    modelRefreshTimer.unref?.();
  }
  // The bundled catalog remains usable while the network request runs.
  void refreshModels(true);
}
