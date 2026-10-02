import { describe, expect, it } from "vitest";
import { TelemetryEmitter } from "./telemetry";

describe("TelemetryEmitter", () => {
  describe("counters", () => {
    it("incrementCounter increments and getCounter returns the value", () => {
      const telemetry = new TelemetryEmitter();
      telemetry.incrementCounter("tasks.completed");
      telemetry.incrementCounter("tasks.completed");
      telemetry.incrementCounter("tasks.completed");
      expect(telemetry.getCounter("tasks.completed")).toBe(3);
    });

    it("incrementCounter with different keys are independent", () => {
      const telemetry = new TelemetryEmitter();
      telemetry.incrementCounter("alpha");
      telemetry.incrementCounter("alpha");
      telemetry.incrementCounter("beta");
      telemetry.incrementCounter("gamma");
      expect(telemetry.getCounter("alpha")).toBe(2);
      expect(telemetry.getCounter("beta")).toBe(1);
      expect(telemetry.getCounter("gamma")).toBe(1);
    });

    it("incrementCounter accepts optional amount", () => {
      const telemetry = new TelemetryEmitter();
      telemetry.incrementCounter("points", 5);
      telemetry.incrementCounter("points", 3);
      expect(telemetry.getCounter("points")).toBe(8);
    });

    it("getCounter returns 0 for unset counter", () => {
      const telemetry = new TelemetryEmitter();
      expect(telemetry.getCounter("nonexistent")).toBe(0);
    });
  });

  describe("histograms", () => {
    it("recordHistogram + getHistogram returns stats (min, max, mean, count)", () => {
      const telemetry = new TelemetryEmitter();
      telemetry.recordHistogram("latency", 10);
      telemetry.recordHistogram("latency", 20);
      telemetry.recordHistogram("latency", 30);
      telemetry.recordHistogram("latency", 40);

      const stats = telemetry.getHistogram("latency");
      expect(stats.min).toBe(10);
      expect(stats.max).toBe(40);
      expect(stats.mean).toBe(25);
      expect(stats.count).toBe(4);
    });

    it("getHistogram returns 0 mean for empty histogram (no records)", () => {
      const telemetry = new TelemetryEmitter();
      const stats = telemetry.getHistogram("empty");
      expect(stats.min).toBe(0);
      expect(stats.max).toBe(0);
      expect(stats.mean).toBe(0);
      expect(stats.count).toBe(0);
    });

    it("handles single value histograms correctly", () => {
      const telemetry = new TelemetryEmitter();
      telemetry.recordHistogram("single", 42);
      const stats = telemetry.getHistogram("single");
      expect(stats.min).toBe(42);
      expect(stats.max).toBe(42);
      expect(stats.mean).toBe(42);
      expect(stats.count).toBe(1);
    });
  });

  describe("snapshots", () => {
    it("getSnapshot() returns { counters, histograms } with all current data", () => {
      const telemetry = new TelemetryEmitter();
      telemetry.incrementCounter("req", 3);
      telemetry.incrementCounter("err", 1);
      telemetry.recordHistogram("duration", 100);
      telemetry.recordHistogram("duration", 200);

      const snap = telemetry.getSnapshot();
      expect(snap).toEqual({
        counters: { req: 3, err: 1 },
        histograms: {
          duration: { min: 100, max: 200, mean: 150, count: 2 },
        },
      });
    });

    it("snapshot creates an immutable copy (mutating caller data doesn't affect snapshot)", () => {
      const telemetry = new TelemetryEmitter();
      telemetry.incrementCounter("hits", 5);
      telemetry.recordHistogram("latency", 10);

      const snap = telemetry.getSnapshot();
      // Mutating the returned snapshot should NOT affect telemetry
      (snap.counters as Record<string, number>)["hits"] = 999;
      (snap.histograms as Record<string, { min: number; max: number; mean: number; count: number }>)["latency"] = {
        min: 0,
        max: 0,
        mean: 0,
        count: 0,
      };

      // Telemetry should still have original values
      expect(telemetry.getCounter("hits")).toBe(5);
      expect(telemetry.getHistogram("latency")).toEqual({ min: 10, max: 10, mean: 10, count: 1 });
    });

    it("getSnapshot resets nothing (another call returns same data)", () => {
      const telemetry = new TelemetryEmitter();
      telemetry.incrementCounter("ops", 7);
      telemetry.recordHistogram("size", 50);

      const snap1 = telemetry.getSnapshot();
      const snap2 = telemetry.getSnapshot();

      expect(snap1).toEqual(snap2);
      // Telemetry still has the data after both snapshots
      expect(telemetry.getCounter("ops")).toBe(7);
      expect(telemetry.getHistogram("size").count).toBe(1);
    });
  });

  describe("reset", () => {
    it("reset() clears all counters and histograms", () => {
      const telemetry = new TelemetryEmitter();
      telemetry.incrementCounter("a", 10);
      telemetry.incrementCounter("b", 20);
      telemetry.recordHistogram("x", 1);
      telemetry.recordHistogram("x", 2);
      telemetry.recordHistogram("y", 100);

      telemetry.reset();

      expect(telemetry.getCounter("a")).toBe(0);
      expect(telemetry.getCounter("b")).toBe(0);
      const xStats = telemetry.getHistogram("x");
      expect(xStats.count).toBe(0);
      expect(xStats.mean).toBe(0);
      const yStats = telemetry.getHistogram("y");
      expect(yStats.count).toBe(0);
      expect(yStats.mean).toBe(0);
    });

    it("reset allows fresh data after reset", () => {
      const telemetry = new TelemetryEmitter();
      telemetry.incrementCounter("ops", 5);
      telemetry.recordHistogram("latency", 100);
      telemetry.reset();

      // Add new data after reset
      telemetry.incrementCounter("ops", 3);
      telemetry.recordHistogram("latency", 200);

      expect(telemetry.getCounter("ops")).toBe(3);
      expect(telemetry.getHistogram("latency")).toEqual({ min: 200, max: 200, mean: 200, count: 1 });
    });
  });

  describe("edge cases", () => {
    it("handles large counter values (Number.MAX_SAFE_INTEGER / large increments)", () => {
      const telemetry = new TelemetryEmitter();
      telemetry.incrementCounter("big", Number.MAX_SAFE_INTEGER);
      telemetry.incrementCounter("big", 1);
      telemetry.incrementCounter("big", Number.MAX_SAFE_INTEGER);
      expect(telemetry.getCounter("big")).toBe(Number.MAX_SAFE_INTEGER * 2 + 1);
    });

    it("handles decimal histogram values", () => {
      const telemetry = new TelemetryEmitter();
      telemetry.recordHistogram("price", 1.5);
      telemetry.recordHistogram("price", 2.5);
      telemetry.recordHistogram("price", 3.0);

      const stats = telemetry.getHistogram("price");
      expect(stats.min).toBe(1.5);
      expect(stats.max).toBe(3.0);
      expect(stats.mean).toBeCloseTo(2.333, 3);
      expect(stats.count).toBe(3);
    });

    it("handles empty snapshot (no data recorded)", () => {
      const telemetry = new TelemetryEmitter();
      const snap = telemetry.getSnapshot();
      expect(snap.counters).toEqual({});
      expect(snap.histograms).toEqual({});
    });
  });
});
