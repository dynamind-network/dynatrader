/** Lightweight provider catalog entry point for CLI/UI bootstrapping. */
export { PROVIDERS, initProvidersFromYAML, reloadProviders, refreshModels } from './registry.js';
export { loadProvidersFromYAML, invalidateProvidersCache } from './yaml-loader.js';
export type { LoadOptions } from './yaml-loader.js';
export type { ProviderEntry, ModelInfo } from './types.js';
