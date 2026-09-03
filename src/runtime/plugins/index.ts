/**
 * Dyna-Trader Plugin Runtime Package
 *
 * Plugin runtime that loads plugins from workspace/plugins/,
 * sandboxes execution, enforces security constraints
 * (network/fs/credentials/order execution), and registers hooks
 * with the HookRuntime.
 */

export {
  PluginRuntime,
  sandboxedOperation,
  sandboxedOperationAsync,
  PermissionDeniedError,
  PluginLoadError,
  type PluginPermissions,
  type PluginHookBinding,
  type PluginManifest,
  type LoadedPlugin,
  type PluginRuntimeOptions,
} from "./plugin-runtime";

export {
  KernelPluginRuntime,
  type KernelPluginRuntimeOptions,
} from "./kernel-plugin-runtime";

export { PluginRuntime as default } from "./plugin-runtime";
