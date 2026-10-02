import { beforeEach, describe, expect, test } from "vitest";
import { type BudgetAdjustment, IterationBudget } from "./iteration-budget";

describe("IterationBudget (adaptive)", () => {
  let budget: IterationBudget;

  beforeEach(() => {
    budget = IterationBudget.createTesting();
  });

  // ── adjustBudget() complexity detection ──────────────────────────

  test("adjustBudget() returns more iterations for complex tasks (long text with many tool refs)", () => {
    const task = `We need to fetch market data from the API, call the get function to retrieve prices,
      post the analysis to the server, fetch historical data, call the trade function,
      get the portfolio, post the results, fetch user settings, call the analysis tool,
      get the report, post the notification, fetch the status, and call the cleanup function.
      ${"A very long paragraph of text that pushes the character count well above five hundred characters so we get the length bonus. ".repeat(3)}`;

    const adj = budget.adjustBudget(task);
    // Length >500: +2, tool refs >10: +5
    expect(adj.iterations).toBeGreaterThanOrEqual(12); // 5 base + 2 + 5 = 12
  });

  test("adjustBudget() returns fewer iterations for simple tasks (short text)", () => {
    const adj = budget.adjustBudget("say hello");
    expect(adj.iterations).toBe(5); // base only
  });

  test("adjustBudget() caps at 50 iterations even for huge inputs", () => {
    // Massive text + huge toolCount to push well past the cap
    const hugeTask = "fetch the data from the API and call the function to get the result. "
      .repeat(5000);

    const adj = budget.adjustBudget(hugeTask, 100);
    expect(adj.iterations).toBe(50); // exactly capped at ADAPTIVE_MAX_ITERATIONS
  });

  test("adjustBudget() has minimum of 1 iteration", () => {
    // An empty or minimal task should still get at least 1
    const adj = budget.adjustBudget("");
    expect(adj.iterations).toBeGreaterThanOrEqual(1);
  });

  test("adjustBudget() with non-zero toolCount gets higher budget", () => {
    const simple = "say hello";
    const without = budget.adjustBudget(simple);
    const withCount = budget.adjustBudget(simple, 5);
    expect(withCount.iterations).toBeGreaterThan(without.iterations);
  });

  test("adjustBudget() accounts toolCount in complexity", () => {
    const adj = budget.adjustBudget("short task", 3);
    // base 5 + toolCount 3 = 8
    expect(adj.iterations).toBe(8);
  });

  // ── updateBudget() ──────────────────────────────────────────────

  test("updateBudget() changes maxIterations in config", () => {
    const testingBudget = IterationBudget.createTesting();
    expect(testingBudget.getRemaining().iterations).toBe(3); // default for testing

    const adj: BudgetAdjustment = { iterations: 20, reason: "Complex task detected" };
    testingBudget.updateBudget(adj);
    expect(testingBudget.getRemaining().iterations).toBe(20);
  });

  test("updateBudget() clamps iterations above ADAPTIVE_MAX", () => {
    const adj: BudgetAdjustment = { iterations: 100, reason: "massively complex" };
    budget.updateBudget(adj);
    expect(budget.getRemaining().iterations).toBeLessThanOrEqual(50);
  });

  // ── getBudgetAdjustmentReason() ─────────────────────────────────

  test("getBudgetAdjustmentReason() returns default string when never adjusted", () => {
    expect(budget.getBudgetAdjustmentReason()).toBe("No adjustment made");
  });

  test("getBudgetAdjustmentReason() returns reason from last adjustment", () => {
    const adj: BudgetAdjustment = { iterations: 15, reason: "Complex analysis task" };
    budget.updateBudget(adj);
    expect(budget.getBudgetAdjustmentReason()).toContain("Complex analysis task");
  });

  // ── Existing behavior still works ────────────────────────────────

  test("existing behavior: isExhausted() returns true when iterations exceed max", () => {
    const tiny = IterationBudget.createTesting(); // maxIterations = 3
    tiny.startIteration();
    tiny.startIteration();
    tiny.startIteration();
    expect(tiny.isExhausted()).toBe(true);
  });

  test("existing behavior: startIteration() throws when exhausted", () => {
    const tiny = IterationBudget.createTesting();
    tiny.startIteration();
    tiny.startIteration();
    tiny.startIteration();
    expect(() => tiny.startIteration()).toThrow("Iteration budget exhausted");
  });

  test("existing behavior: canStartIteration() returns false when exhausted", () => {
    const tiny = IterationBudget.createTesting();
    tiny.startIteration();
    tiny.startIteration();
    tiny.startIteration();
    expect(tiny.canStartIteration()).toBe(false);
  });

  test("existing behavior: getRemaining() reflects used iterations", () => {
    const tiny = IterationBudget.createTesting();
    expect(tiny.getRemaining().iterations).toBe(3);
    tiny.startIteration();
    expect(tiny.getRemaining().iterations).toBe(2);
  });

  test("existing behavior: getUsage() returns usage stats", () => {
    const tiny = IterationBudget.createTesting();
    const usage = tiny.getUsage();
    expect(usage).toHaveProperty("iterations");
    expect(usage).toHaveProperty("exhausted");
    expect(usage.exhausted).toBe(false);
  });

  test("existing behavior: reset() clears state", () => {
    const tiny = IterationBudget.createTesting();
    tiny.startIteration();
    tiny.startIteration();
    expect(tiny.isExhausted()).toBe(false);
    tiny.startIteration();
    expect(tiny.isExhausted()).toBe(true);
    tiny.reset();
    expect(tiny.isExhausted()).toBe(false);
    expect(tiny.getRemaining().iterations).toBe(3);
  });

  test("existing behavior: recordApiCall() increments and can exhaust", () => {
    const tiny = IterationBudget.createTesting(); // maxApiCalls = 10
    for (let i = 0; i < 10; i++) {
      tiny.recordApiCall();
    }
    expect(tiny.getUsage().apiCalls).toBe(10);
    expect(tiny.isExhausted()).toBe(true);
  });

  test("existing behavior: completeIteration() records API calls from the iteration", () => {
    const tiny = IterationBudget.createTesting();
    tiny.completeIteration(3);
    expect(tiny.getUsage().apiCalls).toBe(3);
  });

  test("createDefault() leaves interactive budgets unbounded", () => {
    const def = IterationBudget.createDefault();
    for (let index = 0; index < 60; index++) {
      def.startIteration();
      def.recordApiCall();
    }
    expect(def.isExhausted()).toBe(false);
    expect(def.getUsage().usagePercent).toBe(0);
  });
});
