/**
 * Dyna-Trader Plugin Kernel Package
 *
 * Self-contained plugin kernel mirroring the Cordis "everything is a plugin"
 * design. Plugins register once, declare services and dependencies, mount in
 * topological order, and communicate over an internal event bus with
 * per-listener failure policies.
 */

export { KernelPluginKernel, KernelPluginKernel as default } from "./PluginKernel";
export { DefaultKernelLogger } from "./default-logger";

export {
  PluginDependencyError,
  PluginInitError,
  DuplicatePluginError,
  ServiceNotFoundError,
} from "./errors";

export type {
  KernelLogger,
  KernelService,
  KernelEvent,
  KernelEventHandler,
  KernelEventListenerOptions,
  KernelFailurePolicy,
  KernelHookApi,
  KernelPluginContext,
  PluginDependency,
  PluginDefinition,
  PluginRecord,
  PluginStatus,
  MountResult,
  KernelOptions,
} from "./types";