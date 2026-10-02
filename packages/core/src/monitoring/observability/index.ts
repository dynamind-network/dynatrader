/**
 * Dyna-Trader Observability Package
 *
 * Observability layer with metrics collection, health checks,
 * distributed tracing, structured logging, and OTel export.
 */

export {
  MetricsCollector,
  HealthCheckRegistry,
  Tracer,
  Logger,
  createObservability,
} from "./observability";

export { OtelExporter } from "./otel-exporter";

export type {
  Counter,
  Gauge,
  Histogram,
  MetricSnapshot,
  MetricLabel,
  LogLevel,
  LogEntry,
  HealthCheckResult,
  HealthCheckFn,
  HealthReport,
  Span,
  TraceReport,
  ObservabilityFacade,
} from "./observability";

export type { OtelExporterConfig } from "./otel-exporter";