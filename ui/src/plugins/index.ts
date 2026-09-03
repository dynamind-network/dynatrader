/**
 * Shared plugin kernel used by the terminal core.
 *
 * Today this re-exports the local self-contained shim defined in `kernel.ts`.
 * When `dyna-trader` publishes its plugin kernel (PluginKernel, PluginDefinition,
 * PluginContext), update this barrel to re-export the upstream implementation
 * instead. The public API is intentionally identical so no callers change.
 */
export * from './kernel.js';
