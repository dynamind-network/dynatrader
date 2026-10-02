/**
 * Dyna-Trader Observability Layer
 *
 * Provides metrics collection (counters, gauges, histograms),
 * health check registry, distributed tracing, and structured logging.
 */

import { EventBus } from "@dyna/event-bus";
import type { PerformanceMonitor } from "@dyna/performance-core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MetricLabel = Record<string, string>;

export interface Counter {
  name: string;
  value: number;
  labels: MetricLabel;
}

export interface Gauge {
  name: string;
  value: number;
  labels: MetricLabel;
}

export interface Histogram {
  name: string;
  count: number;
  sum: number;
  buckets: Record<number, number>;
  labels: MetricLabel;
}

export interface MetricSnapshot {
  counters: Counter[];
  gauges: Gauge[];
  histograms: Histogram[];
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Log levels
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  context?: Record<string, unknown>;
  error?: Error;
}

// ---------------------------------------------------------------------------
// Health checks
// ---------------------------------------------------------------------------

export interface HealthCheckResult {
  name: string;
  healthy: boolean;
  message?: string;
  durationMs: number;
  timestamp: string;
}

export type HealthCheckFn = () => HealthCheckResult | Promise<HealthCheckResult>;

export interface HealthReport {
  overall: "healthy" | "degraded" | "unhealthy";
  checks: HealthCheckResult[];
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Tracing
// ---------------------------------------------------------------------------

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operationName: string;
  startTime: number;
  endTime?: number;
  tags: Record<string, unknown>;
  logs: Array<{ timestamp: number; message: string; fields?: Record<string, unknown> }>;
}

export interface TraceReport {
  traceId: string;
  spans: Span[];
  durationMs: number;
}

// ---------------------------------------------------------------------------
// MetricsCollector
// ---------------------------------------------------------------------------

export class MetricsCollector {
  private counters = new Map<string, Counter>();
  private gauges = new Map<string, Gauge>();
  private histograms = new Map<string, Histogram>();

  constructor(private eventBus?: EventBus) {}

  // -- counters -----------------------------------------------------------

  private counterKey(name: string, labels: MetricLabel): string {
    return `${name}:${JSON.stringify(labels)}`;
  }

  increment(name: string, delta = 1, labels: MetricLabel = {}): void {
    const key = this.counterKey(name, labels);
    const existing = this.counters.get(key);
    if (existing) {
      existing.value += delta;
    } else {
      this.counters.set(key, { name, value: delta, labels });
    }
    this.eventBus?.emit("metric" as never, { type: "counter", name, delta, labels } as never);
  }

  getCounter(name: string, labels: MetricLabel = {}): Counter | undefined {
    return this.counters.get(this.counterKey(name, labels));
  }

  // -- gauges -------------------------------------------------------------

  private gaugeKey(name: string, labels: MetricLabel): string {
    return `${name}:${JSON.stringify(labels)}`;
  }

  setGauge(name: string, value: number, labels: MetricLabel = {}): void {
    const key = this.gaugeKey(name, labels);
    this.gauges.set(key, { name, value, labels });
    this.eventBus?.emit("metric" as never, { type: "gauge", name, value, labels } as never);
  }

  getGauge(name: string, labels: MetricLabel = {}): Gauge | undefined {
    return this.gauges.get(this.gaugeKey(name, labels));
  }

  // -- histograms ---------------------------------------------------------

  private histogramKey(name: string, labels: MetricLabel): string {
    return `${name}:${JSON.stringify(labels)}`;
  }

  private readonly defaultBuckets = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

  observe(name: string, value: number, labels: MetricLabel = {}, buckets?: number[]): void {
    const key = this.histogramKey(name, labels);
    let hist = this.histograms.get(key);
    if (!hist) {
      hist = {
        name,
        count: 0,
        sum: 0,
        buckets: {},
        labels,
      };
      for (const b of buckets ?? this.defaultBuckets) {
        hist.buckets[b] = 0;
      }
      this.histograms.set(key, hist);
    }
    hist.count += 1;
    hist.sum += value;
    for (const b of Object.keys(hist.buckets)) {
      if (value <= Number(b)) {
        hist.buckets[Number(b)]! += 1;
      }
    }
    this.eventBus?.emit("metric" as never, { type: "histogram", name, value, labels } as never);
  }

  getHistogram(name: string, labels: MetricLabel = {}): Histogram | undefined {
    return this.histograms.get(this.histogramKey(name, labels));
  }

  // -- snapshot -----------------------------------------------------------

  snapshot(): MetricSnapshot {
    return {
      counters: Array.from(this.counters.values()),
      gauges: Array.from(this.gauges.values()),
      histograms: Array.from(this.histograms.values()),
      timestamp: Date.now(),
    };
  }

  // -- Prometheus export --------------------------------------------------

  exportPrometheus(): string {
    const lines: string[] = [];

    for (const c of this.counters.values()) {
      const labelStr = this.promLabels(c.labels);
      lines.push(`# HELP ${c.name} Counter metric`);
      lines.push(`# TYPE ${c.name} counter`);
      lines.push(`${c.name}${labelStr} ${c.value}`);
    }

    for (const g of this.gauges.values()) {
      const labelStr = this.promLabels(g.labels);
      lines.push(`# HELP ${g.name} Gauge metric`);
      lines.push(`# TYPE ${g.name} gauge`);
      lines.push(`${g.name}${labelStr} ${g.value}`);
    }

    for (const h of this.histograms.values()) {
      const labelStr = this.promLabels(h.labels);
      lines.push(`# HELP ${h.name} Histogram metric`);
      lines.push(`# TYPE ${h.name} histogram`);
      const sortedBuckets = Object.keys(h.buckets)
        .map(Number)
        .sort((a, b) => a - b);
      let cumulative = 0;
      for (const b of sortedBuckets) {
        cumulative += h.buckets[b]!;
        lines.push(`${h.name}_bucket${labelStr}{le="${b}"} ${cumulative}`);
      }
      lines.push(`${h.name}_bucket${labelStr}{le="+Inf"} ${cumulative}`);
      lines.push(`${h.name}_count${labelStr} ${h.count}`);
      lines.push(`${h.name}_sum${labelStr} ${h.sum}`);
    }

    return lines.join("\n");
  }

  private promLabels(labels: MetricLabel): string {
    const entries = Object.entries(labels);
    if (entries.length === 0) return "";
    const attrs = entries.map(([k, v]) => `${k}="${v}"`).join(",");
    return `{${attrs}}`;
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }
}

// ---------------------------------------------------------------------------
// HealthCheckRegistry
// ---------------------------------------------------------------------------

export class HealthCheckRegistry {
  private checks = new Map<string, HealthCheckFn>();

  register(name: string, fn: HealthCheckFn): void {
    this.checks.set(name, fn);
  }

  unregister(name: string): boolean {
    return this.checks.delete(name);
  }

  getNames(): string[] {
    return Array.from(this.checks.keys());
  }

  async runAll(): Promise<HealthReport> {
    const results: HealthCheckResult[] = [];
    for (const [name, fn] of this.checks.entries()) {
      const start = performance.now();
      try {
        const result = await fn();
        result.durationMs = performance.now() - start;
        results.push(result);
      } catch (err) {
        results.push({
          name,
          healthy: false,
          message: err instanceof Error ? err.message : String(err),
          durationMs: performance.now() - start,
          timestamp: new Date().toISOString(),
        });
      }
    }
    const failed = results.filter((r) => !r.healthy).length;
    const overall: HealthReport["overall"] =
      failed === 0 ? "healthy" : failed < results.length ? "degraded" : "unhealthy";
    return {
      overall,
      checks: results,
      timestamp: new Date().toISOString(),
    };
  }

  async run(name: string): Promise<HealthCheckResult | null> {
    const fn = this.checks.get(name);
    if (!fn) return null;
    const start = performance.now();
    try {
      const result = await fn();
      result.durationMs = performance.now() - start;
      return result;
    } catch (err) {
      return {
        name,
        healthy: false,
        message: err instanceof Error ? err.message : String(err),
        durationMs: performance.now() - start,
        timestamp: new Date().toISOString(),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Tracer
// ---------------------------------------------------------------------------

let traceCounter = 0;

function generateId(): string {
  traceCounter += 1;
  return `${Date.now().toString(36)}-${traceCounter.toString(36)}-${Math.random().toString(36).substring(2, 8)}`;
}

export class Tracer {
  private spans = new Map<string, Span>();

  constructor(private eventBus?: EventBus) {}

  startSpan(operationName: string, options?: { parentSpanId?: string; tags?: Record<string, unknown> }): Span {
    const traceId = options?.parentSpanId ? (this.spans.get(options.parentSpanId)?.traceId ?? generateId()) : generateId();
    const spanId = generateId();
    const span: Span = {
      traceId,
      spanId,
      parentSpanId: options?.parentSpanId,
      operationName,
      startTime: performance.now(),
      tags: { ...options?.tags },
      logs: [],
    };
    this.spans.set(spanId, span);
    return span;
  }

  finishSpan(span: Span): void {
    span.endTime = performance.now();
    this.eventBus?.emit("trace" as never, { type: "span_finished", span } as never);
  }

  addSpanLog(span: Span, message: string, fields?: Record<string, unknown>): void {
    span.logs.push({ timestamp: performance.now(), message, fields });
  }

  setSpanTag(span: Span, key: string, value: unknown): void {
    span.tags[key] = value;
  }

  getSpan(spanId: string): Span | undefined {
    return this.spans.get(spanId);
  }

  getTrace(traceId: string): TraceReport | null {
    const spans = Array.from(this.spans.values()).filter((s) => s.traceId === traceId);
    if (spans.length === 0) return null;
    const durations = spans.filter((s) => s.endTime !== undefined).map((s) => s.endTime! - s.startTime);
    return {
      traceId,
      spans,
      durationMs: durations.length > 0 ? Math.max(...durations) : 0,
    };
  }

  getAllSpans(): Span[] {
    return Array.from(this.spans.values());
  }

  clear(): void {
    this.spans.clear();
  }
}

// ---------------------------------------------------------------------------
// Logger (structured logging)
// ---------------------------------------------------------------------------

export class Logger {
  private context: Record<string, unknown> = {};

  constructor(
    private name: string,
    private options?: {
      minLevel?: LogLevel;
      sinks?: Array<(entry: LogEntry) => void>;
      eventBus?: EventBus;
    },
  ) {}

  child(name: string, extraContext?: Record<string, unknown>): Logger {
    const child = new Logger(`${this.name}.${name}`, this.options);
    child.context = { ...this.context, ...extraContext };
    return child;
  }

  withContext(ctx: Record<string, unknown>): Logger {
    const child = new Logger(this.name, this.options);
    child.context = { ...this.context, ...ctx };
    return child;
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ["debug", "info", "warn", "error"];
    const minIdx = levels.indexOf(this.options?.minLevel ?? "debug");
    const idx = levels.indexOf(level);
    return idx >= minIdx;
  }

  private log(level: LogLevel, message: string, ctx?: Record<string, unknown>, error?: Error): void {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      context: { ...this.context, ...ctx, logger: this.name },
      error,
    };

    // Built-in console sink
    const consoleFn = level === "error" ? console.error : level === "warn" ? console.warn : level === "info" ? console.info : console.debug;
    consoleFn(`[${level.toUpperCase()}] [${this.name}] ${message}`, ctx ?? "");

    // Custom sinks
    if (this.options?.sinks) {
      for (const sink of this.options.sinks) {
        try {
          sink(entry);
        } catch {
          // ignore sink errors
        }
      }
    }

    // Emit on event bus
    if (this.options?.eventBus) {
      this.options.eventBus.emit("log" as never, entry as never);
    }
  }

  debug(message: string, ctx?: Record<string, unknown>): void {
    this.log("debug", message, ctx);
  }

  info(message: string, ctx?: Record<string, unknown>): void {
    this.log("info", message, ctx);
  }

  warn(message: string, ctx?: Record<string, unknown>): void {
    this.log("warn", message, ctx);
  }

  error(message: string, error?: Error, ctx?: Record<string, unknown>): void {
    this.log("error", message, ctx, error);
  }
}

// ---------------------------------------------------------------------------
// Composite facade
// ---------------------------------------------------------------------------

export interface ObservabilityFacade {
  metrics: MetricsCollector;
  health: HealthCheckRegistry;
  tracer: Tracer;
  logger: Logger;
  snapshot(): {
    metrics: MetricSnapshot;
    spans: Span[];
    health?: HealthReport;
  };
}

export function createObservability(options?: {
  name?: string;
  eventBus?: EventBus;
  performanceMonitor?: PerformanceMonitor;
  minLogLevel?: LogLevel;
}): ObservabilityFacade {
  const logger = new Logger(options?.name ?? "app", {
    minLevel: options?.minLogLevel,
    eventBus: options?.eventBus,
  });

  return {
    metrics: new MetricsCollector(options?.eventBus),
    health: new HealthCheckRegistry(),
    tracer: new Tracer(options?.eventBus),
    logger,
    snapshot() {
      return {
        metrics: this.metrics.snapshot(),
        spans: this.tracer.getAllSpans(),
      };
    },
  };
}