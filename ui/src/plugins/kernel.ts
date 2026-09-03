/**
 * Self-contained plugin kernel for the terminal core.
 *
 * This is a local shim that mirrors the semantics of the shared plugin kernel
 * exposed by `dyna-trader` (PluginKernel / PluginDefinition / PluginContext).
 * It deliberately carries no hard dependency on `@dyna/kernel`: if that package
 * publishes a kernel in the future, swap the implementation below for an import
 * of the upstream types while keeping the same API so the rest of the package
 * does not need to change.
 */

export interface KernelServiceProvider {
  service: string;
  value?: unknown;
}

export interface KernelDependency {
  service: string;
}

export type KernelFailPolicy = 'fail' | 'warn' | 'skip';

export interface KernelPluginDefinition {
  name: string;
  dependencies?: KernelDependency[];
  provides?: KernelServiceProvider[];
  setup?: (ctx: KernelPluginContext) => void | Promise<void>;
  teardown?: (ctx: KernelPluginContext) => void | Promise<void>;
  failPolicy?: KernelFailPolicy;
}

export interface KernelPluginContext {
  kernel: PluginKernel;
  pluginName: string;
  provide(service: string, value: unknown): void;
  getService<T = unknown>(service: string): T | undefined;
  emit(event: string, payload?: unknown): void;
  on(event: string, handler: KernelEventListener): () => void;
}

export type KernelEventListener = (payload: unknown, event: string) => void;

export class PluginDependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginDependencyError';
  }
}

function resolveFailPolicy(definition: KernelPluginDefinition): KernelFailPolicy {
  return definition.failPolicy ?? 'fail';
}

export class PluginKernel {
  private plugins = new Map<string, KernelPluginDefinition>();
  private mounted = new Set<string>();
  private services = new Map<string, unknown>();
  private listeners = new Map<string, Set<KernelEventListener>>();

  register(definition: KernelPluginDefinition): void {
    const existing = this.plugins.get(definition.name);
    this.plugins.set(definition.name, definition);
    if (existing?.provides) {
      this.removeServices(existing.provides);
    }
    for (const provider of definition.provides ?? []) {
      if (provider.service && provider.value !== undefined) {
        this.services.set(provider.service, provider.value);
      }
    }
    this.mounted.delete(definition.name);
  }

  has(name: string): boolean {
    return this.plugins.has(name);
  }

  getPlugin(name: string): KernelPluginDefinition | undefined {
    return this.plugins.get(name);
  }

  async mount(name: string): Promise<void> {
    if (!this.plugins.has(name)) {
      throw new PluginDependencyError(
        `Kernel: plugin "${name}" is not registered`,
      );
    }
    const chain = this.mountChainFor(name);
    for (const pluginName of chain) {
      await this.mountSingle(pluginName);
    }
  }

  private async mountSingle(name: string): Promise<void> {
    const definition = this.plugins.get(name)!;
    if (this.mounted.has(name)) {
      return;
    }
    for (const dependency of definition.dependencies ?? []) {
      if (!this.services.has(dependency.service)) {
        const policy = resolveFailPolicy(definition);
        const message = `Kernel: plugin "${name}" requires missing service "${dependency.service}"`;
        if (policy === 'fail') {
          throw new PluginDependencyError(message);
        }
        if (policy === 'warn') {
          console.warn(
            `[PluginKernel] ${message} (mounted anyway per failPolicy "${policy}")`,
          );
        }
        if (policy === 'skip') {
          return;
        }
      }
    }
    this.mounted.add(name);
    const context = this.createContext(definition);
    try {
      await definition.setup?.(context);
    } catch (error) {
      const policy = resolveFailPolicy(definition);
      if (policy === 'fail') {
        this.mounted.delete(name);
        throw error;
      }
      if (policy === 'warn') {
        console.warn(
          `[PluginKernel] setup failed for "${name}":`,
          error,
        );
      }
    }
  }

  private mountChainFor(name: string): string[] {
    const order: string[] = [];
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (current: string): void => {
      if (done.has(current) || this.mounted.has(current)) {
        return;
      }
      if (visiting.has(current)) {
        throw new PluginDependencyError(
          `Kernel: circular dependency detected involving "${current}"`,
        );
      }
      visiting.add(current);
      const definition = this.plugins.get(current);
      if (definition) {
        for (const dependency of definition.dependencies ?? []) {
          const provider = this.findProvider(dependency.service);
          if (provider && provider !== current) {
            visit(provider);
          }
        }
      }
      visiting.delete(current);
      done.add(current);
      if (!this.mounted.has(current)) {
        order.push(current);
      }
    };
    visit(name);
    return order;
  }

  async mountAll(): Promise<void> {
    const ordered = this.topologicalOrder();
    for (const name of ordered) {
      await this.mountSingle(name);
    }
  }

  async unmount(name: string): Promise<void> {
    const definition = this.plugins.get(name);
    if (!definition || !this.mounted.has(name)) {
      return;
    }
    this.mounted.delete(name);
    if (definition.teardown) {
      await definition.teardown(this.createContext(definition));
    }
    if (definition.provides) {
      this.removeServices(definition.provides);
    }
  }

  async stop(): Promise<void> {
    const ordered = this.topologicalOrder().reverse();
    for (const name of ordered) {
      await this.unmount(name);
    }
  }

  getService<T = unknown>(service: string): T | undefined {
    return this.services.get(service) as T | undefined;
  }

  hasService(service: string): boolean {
    return this.services.has(service);
  }

  emit(event: string, payload?: unknown): void {
    const handlers = this.listeners.get(event);
    if (!handlers) {
      return;
    }
    for (const handler of handlers) {
      handler(payload, event);
    }
  }

  on(event: string, handler: KernelEventListener): () => void {
    let handlers = this.listeners.get(event);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(event, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  }

  private createContext(definition: KernelPluginDefinition): KernelPluginContext {
    return {
      kernel: this,
      pluginName: definition.name,
      provide: (service: string, value: unknown) => {
        this.services.set(service, value);
      },
      getService: <T = unknown>(service: string): T | undefined =>
        this.getService<T>(service),
      emit: (event: string, payload?: unknown) => this.emit(event, payload),
      on: (event: string, handler: KernelEventListener) => this.on(event, handler),
    };
  }

  private removeServices(providers: KernelServiceProvider[]): void {
    for (const provider of providers) {
      this.services.delete(provider.service);
    }
  }

  private topologicalOrder(): string[] {
    const visited = new Set<string>();
    const order: string[] = [];
    const visit = (name: string, trail: Set<string>): void => {
      if (visited.has(name)) {
        return;
      }
      if (trail.has(name)) {
        throw new PluginDependencyError(
          `Kernel: circular dependency detected involving "${name}"`,
        );
      }
      const definition = this.plugins.get(name);
      if (!definition) {
        return;
      }
      trail.add(name);
      for (const dependency of definition.dependencies ?? []) {
        const providerName = this.findProvider(dependency.service);
        if (providerName) {
          visit(providerName, trail);
        }
      }
      trail.delete(name);
      visited.add(name);
      order.push(name);
    };
    for (const name of this.plugins.keys()) {
      visit(name, new Set());
    }
    return order;
  }

  private findProvider(service: string): string | undefined {
    for (const [name, definition] of this.plugins) {
      if (definition.provides?.some((provider) => provider.service === service)) {
        return name;
      }
    }
    return undefined;
  }
}
