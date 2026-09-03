/**
 * Tests for Dyna-Trader observability package
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  MetricsCollector,
  HealthCheckRegistry,
  Tracer,
  Logger,
  createObservability,
} from "./observability";
import type { HealthCheckFn } from "./observability";

// ---------------------------------------------------------------------------
// MetricsCollector
// ---------------------------------------------------------------------------

describe("MetricsCollector", () => {
  let collector: MetricsCollector;

  beforeEach(() => {
    collector = new MetricsCollector();
  });

  it("should increment a counter", () => {
    collector.increment("orders_total");
    const c = collector.getCounter("orders_total");
    expect(c).toBeDefined();
    expect(c!.value).toBe(1);
  });

  it("should increment a counter by delta", () => {
    collector.increment("orders_total", 5);
    expect(collector.getCounter("orders_total")!.value).toBe(5);
  });

  it("should accumulate counter values", () => {
    collector.increment("errors", 1, { module: "exchange" });
    collector.increment("errors", 1, { module: "exchange" });
    collector.increment("errors", 3, { module: "exchange" });
    expect(collector.getCounter("errors", { module: "exchange" })!.value).toBe(5);
  });

  it("should treat counters with different labels separately", () => {
    collector.increment("requests", 1, { status: "200" });
    collector.increment("requests", 1, { status: "500" });
    expect(collector.getCounter("requests", { status: "200" })!.value).toBe(1);
    expect(collector.getCounter("requests", { status: "500" })!.value).toBe(1);
  });

  it("should set a gauge", () => {
    collector.setGauge("memory_bytes", 42_000_000);
    const g = collector.getGauge("memory_bytes");
    expect(g).toBeDefined();
    expect(g!.value).toBe(42_000_000);
  });

  it("should overwrite gauge value", () => {
    collector.setGauge("connections_active", 10);
    collector.setGauge("connections_active", 5);
    expect(collector.getGauge("connections_active")!.value).toBe(5);
  });

  it("should observe histogram values", () => {
    collector.observe("request_duration_ms", 30);
    collector.observe("request_duration_ms", 60);
    collector.observe("request_duration_ms", 120);

    const h = collector.getHistogram("request_duration_ms");
    expect(h).toBeDefined();
    expect(h!.count).toBe(3);
    expect(h!.sum).toBe(210);
  });

  it("should bucket histogram observations correctly", () => {
    collector.observe("latency", 5, {}, [1, 10, 100]);
    collector.observe("latency", 50, {}, [1, 10, 100]);
    collector.observe("latency", 200, {}, [1, 10, 100]);

    const h = collector.getHistogram("latency");
    expect(h!.buckets[1]).toBe(0);
    expect(h!.buckets[10]).toBe(1);  // 5 <= 10
    expect(h!.buckets[100]).toBe(2); // 5, 50 <= 100
  });

  it("should produce a metric snapshot", () => {
    collector.increment("a");
    collector.setGauge("b", 1);
    collector.observe("c", 1);

    const snap = collector.snapshot();
    expect(snap.counters).toHaveLength(1);
    expect(snap.gauges).toHaveLength(1);
    expect(snap.histograms).toHaveLength(1);
    expect(typeof snap.timestamp).toBe("number");
  });

  it("should export Prometheus format", () => {
    collector.increment("http_requests_total", 3, { method: "GET" });
    collector.setGauge("cpu_usage", 0.75);
    collector.observe("latency_ms", 42);

    const prom = collector.exportPrometheus();
    expect(prom).toContain("http_requests_total");
    expect(prom).toContain("method=\"GET\"");
    expect(prom).toContain("cpu_usage");
    expect(prom).toContain("_bucket");
    expect(prom).toContain("_count");
    expect(prom).toContain("_sum");
  });

  it("should reset all metrics", () => {
    collector.increment("a", 10);
    collector.setGauge("b", 99);
    collector.observe("c", 55);
    collector.reset();

    expect(collector.getCounter("a")).toBeUndefined();
    expect(collector.getGauge("b")).toBeUndefined();
    expect(collector.getHistogram("c")).toBeUndefined();
    expect(collector.snapshot().counters).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// HealthCheckRegistry
// ---------------------------------------------------------------------------

describe("HealthCheckRegistry", () => {
  let registry: HealthCheckRegistry;

  beforeEach(() => {
    registry = new HealthCheckRegistry();
  });

  it("should register and list health checks", () => {
    const fn: HealthCheckFn = () => ({
      name: "db",
      healthy: true,
      durationMs: 0,
      timestamp: new Date().toISOString(),
    });
    registry.register("database", fn);
    expect(registry.getNames()).toEqual(["database"]);
  });

  it("should run all registered checks and report overall healthy", async () => {
    registry.register("db", () => ({
      name: "db",
      healthy: true,
      durationMs: 0,
      timestamp: new Date().toISOString(),
    }));
    registry.register("cache", () => ({
      name: "cache",
      healthy: true,
      durationMs: 0,
      timestamp: new Date().toISOString(),
    }));

    const report = await registry.runAll();
    expect(report.overall).toBe("healthy");
    expect(report.checks).toHaveLength(2);
  });

  it("should report degraded if some checks fail", async () => {
    registry.register("db", () => ({
      name: "db",
      healthy: true,
      durationMs: 0,
      timestamp: new Date().toISOString(),
    }));
    registry.register("exchange", () => ({
      name: "exchange",
      healthy: false,
      message: "Connection refused",
      durationMs: 0,
      timestamp: new Date().toISOString(),
    }));

    const report = await registry.runAll();
    expect(report.overall).toBe("degraded");
  });

  it("should report unhealthy if all checks fail", async () => {
    registry.register("db", () => ({
      name: "db",
      healthy: false,
      message: "Down",
      durationMs: 0,
      timestamp: new Date().toISOString(),
    }));
    registry.register("exchange", () => ({
      name: "exchange",
      healthy: false,
      message: "Down",
      durationMs: 0,
      timestamp: new Date().toISOString(),
    }));

    const report = await registry.runAll();
    expect(report.overall).toBe("unhealthy");
  });

  it("should catch exceptions in health checks", async () => {
    registry.register("flaky", () => {
      throw new Error("Something broke");
    });

    const report = await registry.runAll();
    expect(report.checks[0]!.healthy).toBe(false);
    expect(report.checks[0]!.message).toBe("Something broke");
  });

  it("should handle async health checks", async () => {
    registry.register("async-check", async () => {
      await new Promise((r) => setTimeout(r, 5));
      return {
        name: "async-check",
        healthy: true,
        durationMs: 0,
        timestamp: new Date().toISOString(),
      };
    });

    const result = await registry.run("async-check");
    expect(result).not.toBeNull();
    expect(result!.healthy).toBe(true);
    expect(result!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should unregister a check", () => {
    const fn: HealthCheckFn = () => ({
      name: "temp",
      healthy: true,
      durationMs: 0,
      timestamp: new Date().toISOString(),
    });
    registry.register("temp", fn);
    expect(registry.getNames()).toHaveLength(1);
    expect(registry.unregister("temp")).toBe(true);
    expect(registry.getNames()).toHaveLength(0);
  });

  it("should return null for unknown check name", async () => {
    const result = await registry.run("nonexistent");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tracer
// ---------------------------------------------------------------------------

describe("Tracer", () => {
  let tracer: Tracer;

  beforeEach(() => {
    tracer = new Tracer();
    tracer.clear();
  });

  it("should start a span", () => {
    const span = tracer.startSpan("compute");
    expect(span.operationName).toBe("compute");
    expect(span.spanId).toBeDefined();
    expect(span.traceId).toBeDefined();
    expect(span.startTime).toBeGreaterThan(0);
    expect(span.endTime).toBeUndefined();
  });

  it("should finish a span", () => {
    const span = tracer.startSpan("db.query");
    tracer.finishSpan(span);
    expect(span.endTime).toBeDefined();
    expect(span.endTime!).toBeGreaterThanOrEqual(span.startTime);
  });

  it("should support parent-child span relationships", () => {
    const parent = tracer.startSpan("http.request");
    const child = tracer.startSpan("db.query", { parentSpanId: parent.spanId });

    expect(child.parentSpanId).toBe(parent.spanId);
    expect(child.traceId).toBe(parent.traceId);
  });

  it("should add log events to a span", () => {
    const span = tracer.startSpan("process");
    tracer.addSpanLog(span, "started processing", { recordCount: 100 });
    expect(span.logs).toHaveLength(1);
    expect(span.logs[0]!.message).toBe("started processing");
    expect(span.logs[0]!.fields).toEqual({ recordCount: 100 });
  });

  it("should set tags on a span", () => {
    const span = tracer.startSpan("fetch", { tags: { url: "/api/prices" } });
    tracer.setSpanTag(span, "status", 200);
    expect(span.tags).toHaveProperty("url");
    expect(span.tags).toHaveProperty("status");
  });

  it("should retrieve a trace report", () => {
    const p = tracer.startSpan("parent");
    tracer.startSpan("child", { parentSpanId: p.spanId });
    tracer.finishSpan(p);

    const report = tracer.getTrace(p.traceId);
    expect(report).not.toBeNull();
    expect(report!.traceId).toBe(p.traceId);
    expect(report!.spans).toHaveLength(2);
  });

  it("should return null for unknown trace", () => {
    expect(tracer.getTrace("nonexistent")).toBeNull();
  });

  it("should retrieve a span by ID", () => {
    const span = tracer.startSpan("op");
    expect(tracer.getSpan(span.spanId)).toBe(span);
  });

  it("should clear all spans", () => {
    tracer.startSpan("a");
    tracer.startSpan("b");
    expect(tracer.getAllSpans()).toHaveLength(2);
    tracer.clear();
    expect(tracer.getAllSpans()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

describe("Logger", () => {
  it("should log at various levels", () => {
    const sink = vi.fn();
    const log = new Logger("test", { sinks: [sink] });

    log.info("hello");
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ level: "info", message: "hello" }),
    );
  });

  it("should respect min log level", () => {
    const sink = vi.fn();
    const log = new Logger("test", { minLevel: "warn", sinks: [sink] });

    log.debug("debug msg");
    log.info("info msg");
    log.warn("warn msg");
    log.error("error msg");

    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink).toHaveBeenNthCalledWith(1, expect.objectContaining({ level: "warn" }));
    expect(sink).toHaveBeenNthCalledWith(2, expect.objectContaining({ level: "error" }));
  });

  it("should create child loggers with context", () => {
    const sink = vi.fn();
    const parent = new Logger("root", { sinks: [sink] });
    const child = parent.child("child", { module: "exchange" });

    child.info("child msg");
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "child msg",
        context: expect.objectContaining({ logger: "root.child", module: "exchange" }),
      }),
    );
  });

  it("should create logger with extra context", () => {
    const sink = vi.fn();
    const log = new Logger("ctx-test", { sinks: [sink] });
    const enriched = log.withContext({ appVersion: "1.0" });

    enriched.info("versioned");
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ appVersion: "1.0" }),
      }),
    );
  });

  it("should include error objects at error level", () => {
    const sink = vi.fn();
    const log = new Logger("err-test", { sinks: [sink] });
    const err = new Error("DB connection failed");

    log.error("query failed", err, { query: "SELECT *" });
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        message: "query failed",
        context: expect.objectContaining({ query: "SELECT *" }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// createObservability facade
// ---------------------------------------------------------------------------

describe("createObservability", () => {
  it("should return a complete observability facade", () => {
    const obs = createObservability({ name: "test-app" });

    expect(obs.metrics).toBeInstanceOf(MetricsCollector);
    expect(obs.health).toBeInstanceOf(HealthCheckRegistry);
    expect(obs.tracer).toBeInstanceOf(Tracer);
    expect(obs.logger).toBeInstanceOf(Logger);
  });

  it("should produce a snapshot", () => {
    const obs = createObservability({ name: "snapshot-test" });
    obs.metrics.increment("trades", 7);
    obs.tracer.startSpan("op");

    const s = obs.snapshot();
    expect(s.metrics.counters).toHaveLength(1);
    expect(s.metrics.counters[0]!.value).toBe(7);
    expect(s.spans).toHaveLength(1);
  });
});
