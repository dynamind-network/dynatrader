/**
 * OpenTelemetry (OTLP/HTTP) Exporter for DynaTrader
 *
 * Exports metrics, traces, and logs to an OTel Collector via OTLP/HTTP.
 * Compatible with any OTLP-compatible backend (Jaeger, Grafana Tempo,
 * Datadog, Honeycomb, etc.).
 *
 * Config:
 *   { endpoint: "http://localhost:4138", serviceName: "dynatrader" }
 */

import type { EventBus } from "@dyna/event-bus";
import type { MetricsCollector, Tracer, Logger, Span, MetricSnapshot, LogEntry, MetricLabel } from "./observability";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OtelExporterConfig {
  /** OTLP HTTP endpoint (e.g., "http://localhost:4138") */
  endpoint: string;
  /** Service name for all telemetry */
  serviceName: string;
  /** Export interval in ms (default: 60000) */
  flushIntervalMs: number;
  /** Enable traces export (default: true) */
  traces: boolean;
  /** Enable metrics export (default: true) */
  metrics: boolean;
  /** Enable logs export (default: true) */
  logs: boolean;
  /** Sample rate for traces 0-1 (default: 1.0 = all) */
  sampleRate: number;
  /** Include content in spans/logs (default: false for privacy) */
  captureContent: boolean;
  /** Max batch size before forced flush */
  maxBatchSize: number;
}

interface OtelSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano?: string;
  attributes: Array<{ key: string; value: { stringValue?: string; intValue?: number; doubleValue?: number; boolValue?: boolean } }>;
  status?: { code: number; message?: string };
  events?: Array<{
    timeUnixNano: string;
    name: string;
    attributes: Array<{ key: string; value: { stringValue?: string } }>;
  }>;
}

interface OtelMetric {
  name: string;
  description: string;
  unit: string;
  type: "gauge" | "sum" | "histogram";
  gauge?: { dataPoints: Array<{ asDouble: number; timeUnixNano: string; attributes: Array<{ key: string; value: { stringValue?: string } }> }> };
  sum?: { dataPoints: Array<{ asDouble: number; timeUnixNano: string; attributes: Array<{ key: string; value: { stringValue?: string } }> }>; aggregationTemporality: number };
  histogram?: {
    dataPoints: Array<{
      count: string;
      sum: number;
      timeUnixNano: string;
      attributes: Array<{ key: string; value: { stringValue?: string } }>;
      buckets: Array<{ count: string; explicitBounds: number[] }>;
    }>;
    aggregationTemporality: number;
  };
}

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: OtelExporterConfig = {
  endpoint: "http://localhost:4138",
  serviceName: "dynatrader",
  flushIntervalMs: 60_000,
  traces: true,
  metrics: true,
  logs: true,
  sampleRate: 1.0,
  captureContent: false,
  maxBatchSize: 200,
};

// ---------------------------------------------------------------------------
// OTLP/HTTP payload types
// ---------------------------------------------------------------------------

interface ResourceSpans {
  resource: { attributes: Array<{ key: string; value: { stringValue: string } }> };
  scopeSpans: Array<{
    scope: { name: string; version: string };
    spans: OtelSpan[];
  }>;
}

interface ResourceMetrics {
  resource: { attributes: Array<{ key: string; value: { stringValue: string } }> };
  scopeMetrics: Array<{
    scope: { name: string; version: string };
    metrics: OtelMetric[];
  }>;
}

interface ResourceLogs {
  resource: { attributes: Array<{ key: string; value: { stringValue: string } }> };
  scopeLogs: Array<{
    scope: { name: string; version: string };
    logRecords: Array<{
      timeUnixNano: string;
      severityNumber: number;
      severityText: string;
      body: { stringValue: string };
      attributes: Array<{ key: string; value: { stringValue?: string; intValue?: number } }>;
    }>;
  }>;
}

// ---------------------------------------------------------------------------
// OtelExporter
// ---------------------------------------------------------------------------

export class OtelExporter {
  private readonly config: OtelExporterConfig;
  private readonly metrics: MetricsCollector;
  private readonly tracer: Tracer;
  private readonly logger: Logger;
  private readonly eventBus?: EventBus;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private spanBuffer: OtelSpan[] = [];
  private logBuffer: ResourceLogs["scopeLogs"][0]["logRecords"] = [];
  private stopped = false;

  constructor(
    metrics: MetricsCollector,
    tracer: Tracer,
    logger: Logger,
    config?: Partial<OtelExporterConfig>,
    eventBus?: EventBus,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.metrics = metrics;
    this.tracer = tracer;
    this.logger = logger;
    this.eventBus = eventBus;

    // Subscribe to EventBus events for span/log capture
    if (this.eventBus) {
      this.eventBus.on("trace" as never, ((event: unknown) => {
        const e = event as { type?: string; span?: Span };
        if (e.type === "span_finished" && e.span) {
          this.captureSpan(e.span);
        }
      }) as never);

      this.eventBus.on("log" as never, ((event: unknown) => {
        const e = event as LogEntry;
        this.captureLog(e);
      }) as never);
    }
  }

  /**
   * Start periodic flush.
   */
  start(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.config.flushIntervalMs);
  }

  /**
   * Stop exporting and flush remaining data.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  /**
   * Flush all buffered data to the OTLP endpoint.
   */
  async flush(): Promise<void> {
    if (this.stopped) return;

    const promises: Promise<void>[] = [];

    if (this.config.metrics) {
      promises.push(this.exportMetrics());
    }

    if (this.config.traces && this.spanBuffer.length > 0) {
      promises.push(this.exportTraces());
      this.spanBuffer = [];
    }

    if (this.config.logs && this.logBuffer.length > 0) {
      promises.push(this.exportLogs());
      this.logBuffer = [];
    }

    await Promise.allSettled(promises);
  }

  /**
   * Force-export a single span immediately (for critical paths).
   */
  async exportSpan(span: Span): Promise<void> {
    if (!this.config.traces) return;
    const otelSpan = this.convertSpan(span);
    await this.post("/v1/traces", {
      resourceSpans: [this.wrapSpans([otelSpan])],
    });
  }

  // -------------------------------------------------------------------------
  // Internal: Capture
  // -------------------------------------------------------------------------

  private captureSpan(span: Span): void {
    if (Math.random() > this.config.sampleRate) return;
    this.spanBuffer.push(this.convertSpan(span));

    if (this.spanBuffer.length >= this.config.maxBatchSize) {
      void this.exportTraces().then(() => { this.spanBuffer = []; });
    }
  }

  private captureLog(entry: LogEntry): void {
    const severityMap: Record<string, number> = {
      debug: 5, info: 9, warn: 13, error: 17,
    };

    this.logBuffer.push({
      timeUnixNano: (BigInt(Date.now()) * 1000000n).toString(),
      severityNumber: severityMap[entry.level] ?? 9,
      severityText: entry.level.toUpperCase(),
      body: { stringValue: entry.message },
      attributes: [
        { key: "logger.name", value: { stringValue: (entry.context as Record<string, unknown>)?.logger as string ?? "unknown" } },
        ...(entry.context ? Object.entries(entry.context)
          .filter(([k]) => k !== "logger")
          .slice(0, 10)
          .map(([k, v]) => ({
            key: k,
            value: { stringValue: typeof v === "string" ? v : JSON.stringify(v).slice(0, 200) },
          })) : []),
      ],
    });

    if (this.logBuffer.length >= this.config.maxBatchSize) {
      void this.exportLogs().then(() => { this.logBuffer = []; });
    }
  }

  // -------------------------------------------------------------------------
  // Internal: Convert
  // -------------------------------------------------------------------------

  private convertSpan(span: Span): OtelSpan {
    const attrs: OtelSpan["attributes"] = [
      { key: "span.operation", value: { stringValue: span.operationName } },
    ];

    if (this.config.captureContent) {
      for (const [k, v] of Object.entries(span.tags)) {
        if (typeof v === "string") {
          attrs.push({ key: k, value: { stringValue: v } });
        } else if (typeof v === "number") {
          attrs.push({ key: k, value: { doubleValue: v } });
        } else if (typeof v === "boolean") {
          attrs.push({ key: k, value: { boolValue: v } });
        }
      }
    }

    return {
      traceId: this.padTraceId(span.traceId),
      spanId: this.padSpanId(span.spanId),
      parentSpanId: span.parentSpanId ? this.padSpanId(span.parentSpanId) : undefined,
      name: span.operationName,
      startTimeUnixNano: (BigInt(Math.floor(span.startTime * 1_000_000)) * 1000n).toString(),
      endTimeUnixNano: span.endTime
        ? (BigInt(Math.floor(span.endTime * 1_000_000)) * 1000n).toString()
        : undefined,
      attributes: attrs,
      status: { code: 1 }, // UNSET
      events: span.logs.map((log) => ({
        timeUnixNano: (BigInt(Math.floor(log.timestamp * 1_000_000)) * 1000n).toString(),
        name: log.message,
        attributes: log.fields
          ? Object.entries(log.fields).slice(0, 10).map(([k, v]) => ({
              key: k,
              value: { stringValue: typeof v === "string" ? v : JSON.stringify(v).slice(0, 200) },
            }))
          : [],
      })),
    };
  }

  private padTraceId(id: string): string {
    // OTel requires 32-char hex trace IDs
    const hex = this.toHex(id);
    return hex.padStart(32, "0").slice(0, 32);
  }

  private padSpanId(id: string): string {
    // OTel requires 16-char hex span IDs
    const hex = this.toHex(id);
    return hex.padStart(16, "0").slice(0, 16);
  }

  private toHex(input: string): string {
    // If already hex, return as-is; otherwise hash it
    if (/^[0-9a-f]+$/i.test(input) && input.length >= 16) return input;
    // Simple deterministic hash
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(16).padStart(8, "0");
  }

  // -------------------------------------------------------------------------
  // Internal: Export
  // -------------------------------------------------------------------------

  private async exportMetrics(): Promise<void> {
    try {
      const snapshot = this.metrics.snapshot();
      const metrics = this.convertMetrics(snapshot);
      if (metrics.length === 0) return;

      await this.post("/v1/metrics", {
        resourceMetrics: [this.wrapMetrics(metrics)],
      });
    } catch {
      // OTel export should never crash the agent
    }
  }

  private async exportTraces(): Promise<void> {
    try {
      if (this.spanBuffer.length === 0) return;
      await this.post("/v1/traces", {
        resourceSpans: [this.wrapSpans(this.spanBuffer)],
      });
    } catch {
      // OTel export should never crash the agent
    }
  }

  private async exportLogs(): Promise<void> {
    try {
      if (this.logBuffer.length === 0) return;
      await this.post("/v1/logs", {
        resourceLogs: [this.wrapLogs(this.logBuffer)],
      });
    } catch {
      // OTel export should never crash the agent
    }
  }

  private convertMetrics(snapshot: MetricSnapshot): OtelMetric[] {
    const metrics: OtelMetric[] = [];
    const now = (BigInt(Date.now()) * 1000000n).toString();

    for (const c of snapshot.counters) {
      metrics.push({
        name: c.name,
        description: `Counter: ${c.name}`,
        unit: "1",
        type: "sum",
        sum: {
          aggregationTemporality: 2, // CUMULATIVE
          dataPoints: [{
            asDouble: c.value,
            timeUnixNano: now,
            attributes: this.convertLabels(c.labels),
          }],
        },
      });
    }

    for (const g of snapshot.gauges) {
      metrics.push({
        name: g.name,
        description: `Gauge: ${g.name}`,
        unit: "1",
        type: "gauge",
        gauge: {
          dataPoints: [{
            asDouble: g.value,
            timeUnixNano: now,
            attributes: this.convertLabels(g.labels),
          }],
        },
      });
    }

    for (const h of snapshot.histograms) {
      const sortedBuckets = Object.keys(h.buckets).map(Number).sort((a, b) => a - b);
      metrics.push({
        name: h.name,
        description: `Histogram: ${h.name}`,
        unit: "ms",
        type: "histogram",
        histogram: {
          aggregationTemporality: 2, // CUMULATIVE
          dataPoints: [{
            count: String(h.count),
            sum: h.sum,
            timeUnixNano: now,
            attributes: this.convertLabels(h.labels),
            buckets: [{
              count: String(h.count),
              explicitBounds: sortedBuckets,
            }],
          }],
        },
      });
    }

    return metrics;
  }

  private convertLabels(labels: MetricLabel): OtelSpan["attributes"] {
    return Object.entries(labels).map(([k, v]) => ({
      key: k,
      value: { stringValue: v },
    }));
  }

  private wrapSpans(spans: OtelSpan[]): ResourceSpans {
    return {
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: this.config.serviceName } }],
      },
      scopeSpans: [{
        scope: { name: "dynatrader", version: "1.0.0" },
        spans,
      }],
    };
  }

  private wrapMetrics(metrics: OtelMetric[]): ResourceMetrics {
    return {
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: this.config.serviceName } }],
      },
      scopeMetrics: [{
        scope: { name: "dynatrader", version: "1.0.0" },
        metrics,
      }],
    };
  }

  private wrapLogs(logRecords: ResourceLogs["scopeLogs"][0]["logRecords"]): ResourceLogs {
    return {
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: this.config.serviceName } }],
      },
      scopeLogs: [{
        scope: { name: "dynatrader", version: "1.0.0" },
        logRecords,
      }],
    };
  }

  // -------------------------------------------------------------------------
  // Internal: HTTP transport
  // -------------------------------------------------------------------------

  private async post(path: string, body: unknown): Promise<void> {
    const url = `${this.config.endpoint}${path}`;
    const payload = JSON.stringify(body);

    // Use native fetch (Node 18+ / Bun)
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: payload,
      signal: AbortSignal.timeout(10_000),
    });
  }
}
