/**
 * Provider Fallback Chain — Resilient Model Routing
 *
 * Primary → fallback with health probes. Auto-switch on transport failure.
 * Per-provider health tracking with cooldown periods.
 */

import type { ModelProvider, ModelRequest, ModelResponse, ModelStreamChunk } from "@dyna/contracts";

export interface ProviderHealth {
  providerId: string;
  healthy: boolean;
  consecutiveFailures: number;
  lastFailureAt?: number;
  lastSuccessAt?: number;
  cooldownUntil: number;
}

export interface FallbackChainConfig {
  /** Max consecutive failures before marking unhealthy. Default: 3 */
  failureThreshold?: number;
  /** Cooldown period after marking unhealthy (ms). Default: 60000 (1 min) */
  cooldownMs?: number;
  /** Whether to attempt recovery probes. Default: true */
  enableRecovery?: boolean;
  /** Recovery probe interval (ms). Default: 30000 */
  recoveryIntervalMs?: number;
}

export interface FallbackChainEvents {
  onFailover?: (from: string, to: string, reason: string) => void;
  onRecovery?: (providerId: string) => void;
  onAllFailed?: (lastError: Error) => void;
}

/**
 * Wraps a chain of providers with automatic failover and health tracking.
 */
export class ProviderFallbackChain {
  private readonly providers: ModelProvider[];
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly enableRecovery: boolean;
  private readonly recoveryIntervalMs: number;
  private readonly events: FallbackChainEvents;

  private health = new Map<string, ProviderHealth>();
  private currentIndex = 0;
  private recoveryTimer?: ReturnType<typeof setInterval>;

  constructor(
    providers: ModelProvider[],
    config?: FallbackChainConfig,
    events?: FallbackChainEvents,
  ) {
    this.providers = providers;
    this.failureThreshold = config?.failureThreshold ?? 3;
    this.cooldownMs = config?.cooldownMs ?? 60000;
    this.enableRecovery = config?.enableRecovery ?? true;
    this.recoveryIntervalMs = config?.recoveryIntervalMs ?? 30000;
    this.events = events ?? {};

    // Initialize health for all providers
    for (const provider of providers) {
      this.health.set(provider.id, {
        providerId: provider.id,
        healthy: true,
        consecutiveFailures: 0,
        cooldownUntil: 0,
      });
    }
  }

  /**
   * Start health tracking and recovery probes.
   */
  start(): void {
    if (!this.enableRecovery) return;
    if (this.recoveryTimer) return;
    this.recoveryTimer = setInterval(() => this.probeRecovery(), this.recoveryIntervalMs);
  }

  /**
   * Stop health tracking.
   */
  stop(): void {
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }
  }

  /**
   * Get the current primary provider.
   */
  getPrimary(): ModelProvider | undefined {
    return this.providers[this.currentIndex];
  }

  /**
   * Call with automatic failover.
   */
  async call(request: ModelRequest): Promise<ModelResponse> {
    let lastError: Error | undefined;
    const tried = new Set<string>();

    for (let attempt = 0; attempt < this.providers.length; attempt++) {
      const provider = this.getAvailableProvider(tried);
      if (!provider) break;

      tried.add(provider.id);

      try {
        const result = await provider.call(request);
        this.recordSuccess(provider.id);
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.recordFailure(provider.id, lastError);

        // Find next healthy provider
        const nextIndex = this.findNextHealthy(tried);
        if (nextIndex >= 0) {
          this.events.onFailover?.(
            provider.id,
            this.providers[nextIndex]!.id,
            lastError.message,
          );
          this.currentIndex = nextIndex;
        }
      }
    }

    this.events.onAllFailed?.(lastError ?? new Error("No providers available"));
    throw lastError ?? new Error("No providers available");
  }

  /**
   * Stream with automatic failover.
   */
  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    const tried = new Set<string>();

    for (let attempt = 0; attempt < this.providers.length; attempt++) {
      const provider = this.getAvailableProvider(tried);
      if (!provider) break;

      if (!provider.stream) {
        tried.add(provider.id);
        continue;
      }

      tried.add(provider.id);

      try {
        const stream = provider.stream(request);
        let hasYielded = false;

        for await (const chunk of stream) {
          hasYielded = true;
          yield chunk;
        }

        if (hasYielded) {
          this.recordSuccess(provider.id);
          return;
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.recordFailure(provider.id, err);

        const nextIndex = this.findNextHealthy(tried);
        if (nextIndex >= 0) {
          this.events.onFailover?.(
            provider.id,
            this.providers[nextIndex]!.id,
            err.message,
          );
          this.currentIndex = nextIndex;
        }
      }
    }
  }

  /**
   * Get health status for all providers.
   */
  getHealthStatus(): ProviderHealth[] {
    return this.providers.map((p) => ({
      ...this.health.get(p.id)!,
    }));
  }

  /**
   * Force a specific provider as primary.
   */
  forcePrimary(providerId: string): boolean {
    const idx = this.providers.findIndex((p) => p.id === providerId);
    if (idx < 0) return false;
    this.currentIndex = idx;
    return true;
  }

  private getAvailableProvider(exclude: Set<string>): ModelProvider | undefined {
    const now = Date.now();
    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i]!;
      if (exclude.has(provider.id)) continue;
      const h = this.health.get(provider.id);
      if (!h) continue;
      if (!h.healthy && now < h.cooldownUntil) continue;
      if (!h.healthy && now >= h.cooldownUntil) {
        // Cooldown expired — allow a probe attempt
        h.healthy = true;
        h.consecutiveFailures = 0;
      }
      return provider;
    }
    return undefined;
  }

  private findNextHealthy(exclude: Set<string>): number {
    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i]!;
      if (exclude.has(provider.id)) continue;
      const h = this.health.get(provider.id);
      if (h?.healthy) return i;
    }
    return -1;
  }

  private recordSuccess(providerId: string): void {
    const h = this.health.get(providerId);
    if (!h) return;
    h.consecutiveFailures = 0;
    h.healthy = true;
    h.lastSuccessAt = Date.now();
    h.cooldownUntil = 0;
  }

  private recordFailure(providerId: string, error: Error): void {
    const h = this.health.get(providerId);
    if (!h) return;
    h.consecutiveFailures++;
    h.lastFailureAt = Date.now();
    if (h.consecutiveFailures >= this.failureThreshold) {
      h.healthy = false;
      h.cooldownUntil = Date.now() + this.cooldownMs;
    }
  }

  private probeRecovery(): void {
    for (const provider of this.providers) {
      const h = this.health.get(provider.id);
      if (!h || h.healthy) continue;
      if (Date.now() < h.cooldownUntil) continue;
      // Allow recovery by setting healthy — the next call will test it
      h.healthy = true;
      h.consecutiveFailures = 0;
      this.events.onRecovery?.(provider.id);
    }
  }
}
