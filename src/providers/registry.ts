import type { ProviderEntry } from './types.js';
import { loadProvidersFromYAML, invalidateProvidersCache } from './yaml-loader.js';

export const PROVIDERS: Record<string, ProviderEntry> = {};

export async function initProvidersFromYAML(): Promise<void> {
  const providers = await loadProvidersFromYAML();
  for (const key of Object.keys(PROVIDERS)) {
    delete PROVIDERS[key];
  }
  Object.assign(PROVIDERS, providers);
}

export async function reloadProviders(): Promise<void> {
  invalidateProvidersCache();
  const providers = await loadProvidersFromYAML({ force: true });
  for (const key of Object.keys(PROVIDERS)) {
    delete PROVIDERS[key];
  }
  Object.assign(PROVIDERS, providers);
}
