/**
 * PluginKernel core type definitions.
 *
 * Self-contained plugin kernel with an "everything is a plugin" design: plugins declare the services they provide and consume, and the
 * kernel resolves them in topological order around a shared event bus.
 */

/** Minimal logger interface used by the kernel. Compatible with @dyna/audit Logger. */
export interface KernelLogger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

/** How a failing event listener is treated during dispatch. */
export type KernelFailurePolicy = "fail_closed" | "fail_open" | "warn_only";

/** An event dispatched through the kernel bus. */
export interface KernelEvent {
  /** Event name. */
  type: string;
  /** Optional event payload. */
  payload?: unknown;
  /** When the event was emitted. */
  timestamp: Date;
}

/** Handler signature for kernel events. */
export type KernelEventHandler = (event: KernelEvent) => void | Promise<void>;

/** Options for subscribing to kernel events. */
export interface KernelEventListenerOptions {
  /** Failure policy for this listener. Defaults to the kernel default ("fail_closed"). */
  failurePolicy?: KernelFailurePolicy;
}

/** Lightweight hook surface exposed on plugin contexts. */
export interface KernelHookApi {
  /** Subscribe a hook handler. Returns an unsubscribe function. */
  on(
    event: string,
    handler: KernelEventHandler,
    opts?: KernelEventListenerOptions,
  ): () => void;
}

/** Opaque service handle plus metadata tracked by the kernel. */
export interface KernelService {
  /** Service name (the lookup key). */
  name: string;
  /** Opaque service handle. */
  handle: unknown;
  /** Id of the plugin that contributed this service. */
  pluginId?: string;
  /** Optional metadata. */
  meta?: Record<string, unknown>;
}

/** Lifecycle state of a registered plugin. */
export type PluginStatus = "registered" | "mounted" | "unmounted" | "error";

/** A dependency on a service provided by another plugin. */
export interface PluginDependency {
  /** Service name the plugin consumes at init time. */
  service: string;
  /** When true, a missing provider does not block mounting. */
  optional?: boolean;
}

/** The API handed to a plugin's init and stop hooks. */
export interface KernelPluginContext {
  /** The plugin id this context belongs to. */
  readonly id: string;
  /** Live snapshot of every service currently provided by mounted plugins. */
  readonly services: Readonly<Record<string, unknown>>;
  /** Read a single service by name, throwing ServiceNotFoundError when absent. */
  getService<T>(name: string): T;
  /** Emit an event onto the kernel event bus. */
  emit(event: string, payload?: unknown): Promise<void>;
  /** Subscribe to kernel events. Returns an unsubscribe function. */
  on(
    event: string,
    handler: KernelEventHandler,
    opts?: KernelEventListenerOptions,
  ): () => void;
  /** Lightweight hook surface backed by the same event bus. */
  readonly hooks: KernelHookApi;
  /** Logger available to the plugin. */
  readonly logger: KernelLogger;
  /** Register a runtime service contributed by this plugin. */
  registerService(name: string, handle: unknown, meta?: Record<string, unknown>): void;
  /** Unregister a runtime service previously contributed by this plugin. */
  unregisterService(name: string): boolean;
  /** Mount another registered plugin. */
  mount(pluginId: string): Promise<void>;
  /** Unmount another registered plugin. */
  unmount(pluginId: string): Promise<void>;
}

/** A plugin definition registered with the kernel. */
export interface PluginDefinition<TMeta = any> {
  /** Unique plugin id. */
  id: string;
  /** Semantic version of the plugin. */
  version: string;
  /** Human readable description. */
  description?: string;
  /** Services this plugin consumes at init time. */
  dependencies?: PluginDependency[];
  /** Services this plugin exposes once mounted. */
  services?: Record<string, unknown>;
  /** Initialization hook. Runs when the plugin is mounted. */
  init(ctx: KernelPluginContext): Promise<void> | void;
  /** Teardown hook. Runs when the plugin is unmounted. */
  stop?(ctx: KernelPluginContext): Promise<void> | void;
  /** Arbitrary plugin metadata. */
  meta?: TMeta;
}

/** A registered plugin and its current lifecycle state. */
export interface PluginRecord<TMeta = any> {
  definition: PluginDefinition<TMeta>;
  /** The context handed to init/stop while the plugin is mounted. */
  context: KernelPluginContext | undefined;
  status: PluginStatus;
}

/** Result of mounting a single plugin. */
export interface MountResult {
  id: string;
  ok: boolean;
  /** Mount order within the operation (0-based). */
  order: number;
  error?: string;
}

/** Options for constructing a plugin kernel. */
export interface KernelOptions {
  /** Custom logger. Defaults to a console-based DefaultKernelLogger. */
  logger?: KernelLogger;
  /** When true (default), mountAll stops at the first failing plugin. */
  strict?: boolean;
  /** Default failure policy for listeners registered without one. Defaults to "fail_closed". */
  defaultFailurePolicy?: KernelFailurePolicy;
}