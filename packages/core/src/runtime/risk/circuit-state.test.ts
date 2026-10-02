import { describe, it, expect } from "vitest";
import { CircuitState } from "./circuit-state";

describe("CircuitState", () => {
  it("starts untripped", () => {
    const cs = new CircuitState({}, 10_000);
    expect(cs.isTripped().tripped).toBe(false);
  });

  it("trips when daily loss exceeds threshold", () => {
    const cs = new CircuitState({ dailyLossLimitPct: 0.05 }, 10_000);
    cs.recordOutcome(-600); // -6%
    expect(cs.isTripped().tripped).toBe(true);
    expect(cs.isTripped().reason).toContain("limit");
  });

  it("does not trip below the threshold", () => {
    const cs = new CircuitState({ dailyLossLimitPct: 0.05 }, 10_000);
    cs.recordOutcome(-300); // -3%
    expect(cs.isTripped().tripped).toBe(false);
  });

  it("LATCHES: PnL recovery does not un-trip before autoResetMinutes", () => {
    const cs = new CircuitState(
      { dailyLossLimitPct: 0.05, autoResetMinutes: 60 },
      10_000,
    );
    cs.recordOutcome(-600);
    expect(cs.isTripped().tripped).toBe(true);
    cs.recordOutcome(+500); // equity recovers
    expect(cs.isTripped().tripped).toBe(true); // still latched
  });

  it("manual reset clears latch and re-baselines", () => {
    const cs = new CircuitState({ dailyLossLimitPct: 0.05, autoResetMinutes: 0 }, 10_000);
    cs.recordOutcome(-600);
    expect(cs.isTripped().tripped).toBe(true);
    cs.reset();
    expect(cs.isTripped().tripped).toBe(false);
    // New baseline is current (9400), so -470 more (-5% of 9400) trips again
    cs.recordOutcome(-471);
    expect(cs.isTripped().tripped).toBe(true);
  });

  it("reports loss percentage in status", () => {
    const cs = new CircuitState({ dailyLossLimitPct: 0.05 }, 10_000);
    cs.recordOutcome(-200);
    const status = cs.isTripped();
    expect(status.dailyLossPct).toBeCloseTo(0.02, 5);
    expect(status.limitPct).toBe(0.05);
  });
});
