/**
 * TelemetryEmitter — agent loop observability counters and histograms.
 *
 * Provides lightweight in-process instrumentation for tracking
 * iteration counts, error rates, latency distributions, etc.
 */

export interface HistogramStats {
  min: number;
  max: number;
  mean: number;
  count: number;
}

export interface TelemetrySnapshot {
  counters: Record<string, number>;
  histograms: Record<string, HistogramStats>;
}

export class TelemetryEmitter {
  private counters: Map<string, number> = new Map();
  private histograms: Map<string, number[]> = new Map();

  /** Increment a named counter by 1 (or optional `by` amount). */
  incrementCounter(name: string, by = 1): void {
    const current = this.counters.get(name) ?? 0;
    this.counters.set(name, current + by);
  }

  /** Record a value in a named histogram. */
  recordHistogram(name: string, value: number): void {
    const values = this.histograms.get(name);
    if (values) {
      values.push(value);
      if (values.length > 1000) {
        values.splice(0, 500);
      }
    } else {
      if (this.histograms.size > 100) {
        const firstKey = this.histograms.keys().next().value;
        if (firstKey) this.histograms.delete(firstKey);
      }
      this.histograms.set(name, [value]);
    }
  }

  /** Get the current value of a counter (0 if not set). */
  getCounter(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  /**
   * Get histogram statistics.
   * Returns min=0, max=0, mean=0, count=0 when no values have been recorded.
   */
  getHistogram(name: string): HistogramStats {
    const values = this.histograms.get(name);
    if (!values || values.length === 0) {
      return { min: 0, max: 0, mean: 0, count: 0 };
    }

    let min = values[0]!;
    let max = values[0]!;
    let sum = 0;

    for (const v of values) {
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }

    return {
      min,
      max,
      mean: sum / values.length,
      count: values.length,
    };
  }

  /** Get an immutable snapshot of all telemetry data. */
  getSnapshot(): TelemetrySnapshot {
    const counters: Record<string, number> = {};
    for (const [key, value] of this.counters) {
      counters[key] = value;
    }

    const histograms: Record<string, HistogramStats> = {};
    for (const [key] of this.histograms) {
      histograms[key] = this.getHistogram(key);
    }

    return { counters, histograms };
  }

  /** Reset all telemetry data. */
  reset(): void {
    this.counters.clear();
    this.histograms.clear();
  }
}
