/**
 * PluginKernel error types.
 *
 * All kernel errors carry a pluginId so failures can be traced back to the
 * plugin that caused them.
 */

/** Raised when a plugin declares a service dependency that no plugin provides. */
export class PluginDependencyError extends Error {
  public override readonly cause?: Error;

  constructor(
    public readonly pluginId: string,
    public readonly missingService: string,
    cause?: Error,
  ) {
    super(
      `Plugin "${pluginId}" has an unmet dependency: service "${missingService}" is not available`,
    );
    this.name = "PluginDependencyError";
    this.cause = cause;
  }
}

/** Raised when a plugin's init hook fails or the plugin cannot be mounted. */
export class PluginInitError extends Error {
  public override readonly cause?: Error;

  constructor(
    public readonly pluginId: string,
    public readonly reason: string,
    cause?: Error,
  ) {
    super(`Plugin "${pluginId}" failed to initialize: ${reason}`);
    this.name = "PluginInitError";
    this.cause = cause;
  }
}

/** Raised when a plugin id is registered more than once. */
export class DuplicatePluginError extends Error {
  constructor(public readonly pluginId: string) {
    super(`Plugin "${pluginId}" is already registered`);
    this.name = "DuplicatePluginError";
  }
}

/** Raised when a service is requested but no mounted plugin provides it. */
export class ServiceNotFoundError extends Error {
  constructor(
    public readonly serviceName: string,
    public readonly pluginId?: string,
  ) {
    super(`Service "${serviceName}" is not provided by any mounted plugin`);
    this.name = "ServiceNotFoundError";
  }
}