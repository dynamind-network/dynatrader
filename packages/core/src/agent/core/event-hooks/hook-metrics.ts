/**
 * Hook Metrics for DynaMind Terminal
 *
 * Tracks and aggregates hook execution metrics for benchmarking.
 */
import type {
  HookMetrics,
  AggregatedHookMetrics,
  HookEvent,
} from "./hook-types.js";
import { hookEvents } from "./hook-types.js";

export class HookMetricsCollector {
  private metrics: HookMetrics[] = [];
  private maxMetrics = 1000;

  record(metric: HookMetrics): void {
    this.metrics.push(metric);

    if (this.metrics.length > this.maxMetrics) {
      this.metrics = this.metrics.slice(-this.maxMetrics);
    }
  }

  getMetrics(): HookMetrics[] {
    return [...this.metrics];
  }

  getMetricsForEvent(event: HookEvent): HookMetrics[] {
    return this.metrics.filter((m) => m.hookEvent === event);
  }

  getMetricsForSession(sessionId: string): HookMetrics[] {
    return this.metrics.filter(
      (m) => m.hookId.includes(sessionId) || this.metrics.indexOf(m) >= 0,
    );
  }

  aggregate(): AggregatedHookMetrics {
    const byEvent: Record<HookEvent, number> = {} as Record<HookEvent, number>;
    const byType: Record<string, number> = {};

    for (const event of hookEvents) {
      byEvent[event] = 0;
    }

    let totalDuration = 0;
    let successful = 0;
    let failed = 0;
    let blocked = 0;

    for (const metric of this.metrics) {
      byEvent[metric.hookEvent] = (byEvent[metric.hookEvent] || 0) + 1;

      const type = metric.hookName.split(":")[0] || "unknown";
      byType[type] = (byType[type] || 0) + 1;

      if (metric.durationMs) {
        totalDuration += metric.durationMs;
      }

      if (metric.outcome === "success") {
        successful++;
      } else if (metric.outcome === "error") {
        failed++;
      } else if (metric.outcome === "blocking") {
        blocked++;
      }
    }

    const total = this.metrics.length;
    const avgDuration = total > 0 ? totalDuration / total : 0;

    return {
      totalHooks: total,
      successfulHooks: successful,
      failedHooks: failed,
      blockedHooks: blocked,
      totalDurationMs: totalDuration,
      averageDurationMs: avgDuration,
      byEvent,
      byType,
    };
  }

  clear(): void {
    this.metrics = [];
  }

  getRecentMetrics(count = 10): HookMetrics[] {
    return this.metrics.slice(-count);
  }

  getAverageDuration(event?: HookEvent): number {
    const filtered = event
      ? this.metrics.filter((m) => m.hookEvent === event)
      : this.metrics;

    if (filtered.length === 0) {
      return 0;
    }

    const total = filtered.reduce((sum, m) => sum + (m.durationMs || 0), 0);
    return total / filtered.length;
  }

  getSuccessRate(event?: HookEvent): number {
    const filtered = event
      ? this.metrics.filter((m) => m.hookEvent === event)
      : this.metrics;

    if (filtered.length === 0) {
      return 0;
    }

    const successful = filtered.filter((m) => m.outcome === "success").length;
    return (successful / filtered.length) * 100;
  }

  getHookOverhead(): number {
    return this.getAverageDuration();
  }
}

let defaultCollector: HookMetricsCollector | null = null;

export function getHookMetricsCollector(): HookMetricsCollector {
  if (!defaultCollector) {
    defaultCollector = new HookMetricsCollector();
  }
  return defaultCollector;
}

export function createHookMetricsCollector(): HookMetricsCollector {
  return new HookMetricsCollector();
}

