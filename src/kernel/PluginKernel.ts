/**
 * PluginKernel
 *
 * Self-owned plugin kernel mirroring the Cordis "everything is a plugin"
 * design, with no third-party runtime dependency. Plugins register once,
 * declare the services they provide and consume, and are mounted in
 * topological dependency order. Services are injected through a per-plugin
 * context, lifecycle events flow over an internal event bus with per-listener
 * failure policies, and every plugin can be hot-reloaded via unmount + mount.
 *
 * Lifecycle transitions publish traceability events on the bus itself:
 * `plugin.mounted`, `plugin.unmounted`, `plugin.reload` and `plugin.stopped`.
 */

import { DefaultKernelLogger } from "./default-logger";
import type {
  KernelEvent,
  KernelEventListenerOptions,
  KernelEventHandler,
  KernelFailurePolicy,
  KernelHookApi,
  KernelLogger,
  KernelOptions,
  KernelPluginContext,
  KernelService,
  MountResult,
  PluginDefinition,
  PluginDependency,
  PluginRecord,
} from "./types";
import {
  DuplicatePluginError,
  PluginDependencyError,
  PluginInitError,
  ServiceNotFoundError,
} from "./errors";

interface KernelListener {
  id: string;
  event: string;
  handler: KernelEventHandler;
  policy: KernelFailurePolicy;
}

class KernelPluginContextImpl implements KernelPluginContext {
  private readonly kernel: KernelPluginKernel;
  private readonly unsubscribers: Array<() => void> = [];

  constructor(
    kernel: KernelPluginKernel,
    readonly id: string,
    readonly logger: KernelLogger,
  ) {
    this.kernel = kernel;
  }

  get services(): Readonly<Record<string, unknown>> {
    return this.kernel.servicesSnapshot();
  }

  getService<T>(name: string): T {
    return this.kernel.getService<T>(name);
  }

  emit(event: string, payload?: unknown): Promise<void> {
    return this.kernel.emit(event, payload);
  }

  on(
    event: string,
    handler: KernelEventHandler,
    opts?: KernelEventListenerOptions,
  ): () => void {
    const unsubscribe = this.kernel.addListener(event, handler, opts, this.id);
    this.unsubscribers.push(unsubscribe);
    return unsubscribe;
  }

  get hooks(): KernelHookApi {
    return {
      on: (event, handler, opts) => this.on(event, handler, opts),
    };
  }

  registerService(name: string, handle: unknown, meta?: Record<string, unknown>): void {
    this.kernel.registerPluginService(this.id, name, handle, meta);
  }

  unregisterService(name: string): boolean {
    return this.kernel.unregisterPluginService(this.id, name);
  }

  mount(pluginId: string): Promise<void> {
    return this.kernel.mount(pluginId);
  }

  unmount(pluginId: string): Promise<void> {
    return this.kernel.unmount(pluginId);
  }

  dispose(): void {
    const unsubscribers = this.unsubscribers.splice(0);
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
  }
}

/**
 * Self-contained plugin kernel.
 */
export class KernelPluginKernel {
  private readonly records: Map<string, PluginRecord> = new Map();
  private readonly services: Map<string, KernelService> = new Map();
  private readonly providers: Map<string, string> = new Map();
  private readonly declaredServices: Map<string, string[]> = new Map();
  private readonly listeners: Map<string, KernelListener[]> = new Map();
  private readonly logger: KernelLogger;
  private readonly strict: boolean;
  private readonly defaultPolicy: KernelFailurePolicy;
  private readonly mountOrder: string[] = [];
  private listenerSeq = 0;

  constructor(options?: KernelOptions) {
    this.logger = options?.logger ?? new DefaultKernelLogger("Kernel");
    this.strict = options?.strict ?? true;
    this.defaultPolicy = options?.defaultFailurePolicy ?? "fail_closed";
  }

  /**
   * Register a plugin definition. Throws DuplicatePluginError on id clashes.
   */
  register(definition: PluginDefinition): void {
    if (!definition.id) {
      throw new Error("Plugin id is required");
    }
    if (!definition.version) {
      throw new Error("Plugin version is required");
    }
    if (this.records.has(definition.id)) {
      throw new DuplicatePluginError(definition.id);
    }
    this.records.set(definition.id, {
      definition,
      context: undefined,
      status: "registered",
    });

    const declared = Object.keys(definition.services ?? {});
    this.declaredServices.set(definition.id, declared);
    for (const name of declared) {
      const existing = this.providers.get(name);
      if (existing === undefined) {
        this.providers.set(name, definition.id);
      } else if (existing !== definition.id) {
        this.logger.warn(
          `Service "${name}" is already declared by "${existing}", ignoring "${definition.id}"`,
        );
      }
    }

    this.logger.debug("Plugin registered", {
      id: definition.id,
      version: definition.version,
    });
  }

  /**
   * Mount a plugin, resolving its service dependencies in topological order.
   */
  async mount(id: string): Promise<void> {
    await this.mountInternal(id, []);
  }

  /**
   * Mount every registered plugin, returning a result per plugin.
   */
  async mountAll(): Promise<MountResult[]> {
    const results: MountResult[] = [];

    for (const record of this.records.values()) {
      const id = record.definition.id;
      if (record.status === "mounted") {
        results.push({ id, ok: true, order: results.length });
        continue;
      }
      try {
        await this.mountInternal(id, []);
        results.push({ id, ok: true, order: results.length });
      } catch (err) {
        results.push({
          id,
          ok: false,
          order: results.length,
          error: toMessage(err),
        });
        if (this.strict) {
          throw err;
        }
      }
    }

    return results;
  }

  /**
   * Unmount a plugin, running its stop hook and releasing its services.
   */
  async unmount(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record) {
      throw new Error(`Plugin "${id}" is not registered`);
    }
    if (record.status !== "mounted") {
      return;
    }

    const context = record.context;
    if (context) {
      try {
        await record.definition.stop?.(context);
      } catch (err) {
        this.logger.warn(`Plugin stop failed for "${id}"`, { error: toMessage(err) });
      }
    }

    if (context instanceof KernelPluginContextImpl) {
      context.dispose();
    }

    this.removeServicesFor(id);

    const index = this.mountOrder.indexOf(id);
    if (index !== -1) {
      this.mountOrder.splice(index, 1);
    }

    record.context = undefined;
    record.status = "unmounted";
    this.logger.info(`Plugin unmounted: ${id}`);
    void this.emit("plugin.unmounted", { id });
  }

  /**
   * Hot-reload a plugin by unmounting and re-mounting it with a fresh context.
   *
   * Contributed services are released before re-init, so repeated reloads are
   * idempotent and never accumulate duplicate service registrations or
   * listeners. A `plugin.reload` event is published before the swap.
   */
  async reload(id: string): Promise<void> {
    void this.emit("plugin.reload", { id });
    await this.unmount(id);
    await this.mount(id);
  }

  /**
   * Unmount every mounted plugin in reverse mount order.
   *
   * Publishes a single `plugin.stopped` event listing the unmounted ids.
   */
  async stop(): Promise<void> {
    const order = [...this.mountOrder].reverse();
    for (const id of order) {
      await this.unmount(id);
    }
    void this.emit("plugin.stopped", { plugins: order });
  }

  /**
   * Read a service by name. Throws ServiceNotFoundError when absent.
   */
  getService<T>(name: string): T {
    const service = this.services.get(name);
    if (!service) {
      throw new ServiceNotFoundError(name);
    }
    return service.handle as T;
  }

  /**
   * Check whether a service is currently provided.
   */
  hasService(name: string): boolean {
    return this.services.has(name);
  }

  /**
   * Look up a registered plugin by id.
   */
  getPlugin(id: string): PluginRecord | undefined {
    return this.records.get(id);
  }

  /**
   * List plugins that are currently mounted.
   */
  getMountedPlugins(): PluginRecord[] {
    const mounted: PluginRecord[] = [];
    for (const record of this.records.values()) {
      if (record.status === "mounted") {
        mounted.push(record);
      }
    }
    return mounted;
  }

  /**
   * Dispatch an event to all registered listeners.
   *
   * Handlers run in registration order. A failing fail_closed listener aborts
   * dispatch and propagates its error; fail_open and warn_only failures are
   * logged and the bus continues so one bad handler does not break it.
   */
  async emit(event: string, payload?: unknown): Promise<void> {
    const registered = this.listeners.get(event);
    if (!registered || registered.length === 0) {
      return;
    }

    const kernelEvent: KernelEvent = { type: event, payload, timestamp: new Date() };

    for (const listener of [...registered]) {
      try {
        await listener.handler(kernelEvent);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(toMessage(err));
        if (listener.policy === "fail_closed") {
          this.logger.error(
            `Event listener failed for "${event}", aborting dispatch`,
            { error: error.message },
          );
          throw error;
        }
        if (listener.policy === "warn_only") {
          this.logger.warn(`Event listener failed for "${event}"`, {
            error: error.message,
          });
        } else {
          this.logger.debug(`Event listener failed for "${event}"`, {
            error: error.message,
          });
        }
      }
    }
  }

  /**
   * Subscribe to an event. Returns an unsubscribe function.
   */
  on(
    event: string,
    handler: KernelEventHandler,
    opts?: KernelEventListenerOptions,
  ): () => void {
    return this.addListener(event, handler, opts);
  }

  /**
   * Snapshot every service currently provided by mounted plugins.
   */
  servicesSnapshot(): Readonly<Record<string, unknown>> {
    const snapshot: Record<string, unknown> = {};
    for (const [name, service] of this.services) {
      snapshot[name] = service.handle;
    }
    return snapshot;
  }

  /**
   * Register a listener, optionally attributed to a plugin context.
   */
  addListener(
    event: string,
    handler: KernelEventHandler,
    opts?: KernelEventListenerOptions,
    pluginId?: string,
  ): () => void {
    const policy = opts?.failurePolicy ?? this.defaultPolicy;
    const listener: KernelListener = {
      id: `listener-${++this.listenerSeq}`,
      event,
      handler,
      policy,
    };

    const eventListeners = this.listeners.get(event) ?? [];
    eventListeners.push(listener);
    this.listeners.set(event, eventListeners);

    this.logger.debug("Event listener registered", { event, policy, pluginId });
    return () => this.removeListener(listener);
  }

  /**
   * Register a runtime service contributed by a plugin.
   */
  registerPluginService(
    pluginId: string,
    name: string,
    handle: unknown,
    meta?: Record<string, unknown>,
  ): void {
    const existing = this.providers.get(name);
    if (existing !== undefined && existing !== pluginId) {
      throw new Error(`Service "${name}" is already provided by plugin "${existing}"`);
    }
    this.services.set(name, { name, handle, pluginId, meta });
    this.providers.set(name, pluginId);
  }

  /**
   * Unregister a runtime service owned by a plugin. Returns true when removed.
   */
  unregisterPluginService(pluginId: string, name: string): boolean {
    const service = this.services.get(name);
    if (!service || service.pluginId !== pluginId) {
      return false;
    }
    this.services.delete(name);
    this.providers.delete(name);
    return true;
  }

  private async mountInternal(id: string, stack: string[]): Promise<void> {
    const record = this.records.get(id);
    if (!record) {
      throw new Error(`Plugin "${id}" is not registered`);
    }
    if (record.status === "mounted") {
      return;
    }
    if (stack.includes(id)) {
      throw new Error(
        `Dependency cycle detected while mounting plugin "${id}": ${[...stack, id].join(" -> ")}`,
      );
    }

    stack.push(id);
    try {
      for (const dependency of record.definition.dependencies ?? []) {
        await this.resolveDependency(dependency, id, stack);
      }
      await this.activate(record);
    } finally {
      stack.pop();
    }
  }

  private async resolveDependency(
    dependency: PluginDependency,
    pluginId: string,
    stack: string[],
  ): Promise<void> {
    const providerId = this.providers.get(dependency.service);
    if (providerId === undefined) {
      if (!dependency.optional) {
        throw new PluginDependencyError(pluginId, dependency.service);
      }
      this.logger.debug(
        `Optional dependency "${dependency.service}" for "${pluginId}" is unavailable, skipping`,
      );
      return;
    }
    await this.mountInternal(providerId, stack);
  }

  private async activate(record: PluginRecord): Promise<void> {
    const definition = record.definition;
    const id = definition.id;
    const context = new KernelPluginContextImpl(this, id, this.logger);
    record.context = context;

    try {
      for (const [name, handle] of Object.entries(definition.services ?? {})) {
        this.registerPluginService(id, name, handle);
      }

      await definition.init(context);

      record.status = "mounted";
      this.mountOrder.push(id);
      this.logger.info(`Plugin mounted: ${id} v${definition.version}`);
      void this.emit("plugin.mounted", { id, version: definition.version });
    } catch (err) {
      context.dispose();
      this.removeServicesFor(id);
      record.status = "error";
      throw new PluginInitError(id, toMessage(err), err instanceof Error ? err : undefined);
    }
  }

  private removeServicesFor(pluginId: string): void {
    for (const [name, service] of this.services) {
      if (service.pluginId === pluginId) {
        this.services.delete(name);
        this.providers.delete(name);
      }
    }
    for (const name of this.declaredServices.get(pluginId) ?? []) {
      if (this.providers.get(name) === pluginId) {
        this.providers.delete(name);
      }
    }
  }

  private removeListener(listener: KernelListener): void {
    const eventListeners = this.listeners.get(listener.event);
    if (!eventListeners) {
      return;
    }
    const index = eventListeners.indexOf(listener);
    if (index !== -1) {
      eventListeners.splice(index, 1);
      if (eventListeners.length === 0) {
        this.listeners.delete(listener.event);
      }
    }
  }
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default KernelPluginKernel;