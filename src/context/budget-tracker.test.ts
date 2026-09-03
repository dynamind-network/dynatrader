import { describe, expect, test } from "vitest";
import { BudgetTracker } from "./budget-tracker";

describe("BudgetTracker", () => {
  test("warns and compacts at configured thresholds", () => {
    const tracker = new BudgetTracker({
      contextWindowTokens: 100,
      warnAtRatio: 0.8,
      compactAtRatio: 0.9,
    });

    tracker.update("stable", 40);
    tracker.update("context", 30);
    tracker.update("volatile", 20);

    expect(tracker.shouldWarn()).toBe(true);
    expect(tracker.shouldCompact()).toBe(true);
    expect(tracker.getSnapshot().totalTokens).toBe(90);
  });
});
