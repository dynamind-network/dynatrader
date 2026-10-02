import { describe, it, expect } from "vitest";
import { GoalLoopManager } from "./goal-loop";

describe("GoalLoopManager", () => {
  it("starts active after set()", () => {
    const mgr = new GoalLoopManager();
    mgr.set("Fix SEO");
    expect(mgr.isActive()).toBe(true);
  });

  it("rejects empty goal text", () => {
    expect(() => new GoalLoopManager().set("  ")).toThrow(/empty/);
  });

  it("continues when checklist items remain", () => {
    const mgr = new GoalLoopManager();
    mgr.set("Fix SEO", ["audit page titles", "submit sitemap"]);
    const d = mgr.evaluateAfterTurn("worked on it. GOAL_STATUS: {complete: false}");
    expect(d.shouldContinue).toBe(true);
    expect(d.continuationPrompt).toContain("Fix SEO");
    expect(d.continuationPrompt).toContain("audit page titles");
  });

  it("stops when all checklist items are done", () => {
    const mgr = new GoalLoopManager();
    mgr.set("Fix SEO", ["audit page titles", "submit sitemap"]);
    mgr.evaluateAfterTurn("audit page titles: done\nGOAL_STATUS: {complete: false}");
    const d2 = mgr.evaluateAfterTurn("submit sitemap: complete\nGOAL_STATUS: {complete: true}");
    expect(d2.shouldContinue).toBe(false);
    expect(d2.status).toBe("done");
  });

  it("honors explicit GOAL_STATUS complete even without checklist", () => {
    const mgr = new GoalLoopManager();
    mgr.set("Research topic");
    const d = mgr.evaluateAfterTurn("finished the research. GOAL_STATUS: {complete: true}");
    expect(d.shouldContinue).toBe(false);
    expect(d.status).toBe("done");
  });

  it("pauses at maxTurns", () => {
    const mgr = new GoalLoopManager();
    mgr.set("Long task", [], 2);
    mgr.evaluateAfterTurn("GOAL_STATUS: {complete: false}");
    const d2 = mgr.evaluateAfterTurn("GOAL_STATUS: {complete: false}");
    expect(d2.shouldContinue).toBe(false);
    expect(d2.status).toBe("paused");
    expect(d2.message).toContain("max turns");
  });

  it("pause/resume roundtrip", () => {
    const mgr = new GoalLoopManager();
    mgr.set("Task");
    mgr.pause();
    expect(mgr.isActive()).toBe(false);
    mgr.resume();
    expect(mgr.isActive()).toBe(true);
  });

  it("clear() reports whether a goal existed", () => {
    const mgr = new GoalLoopManager();
    mgr.set("Task");
    expect(mgr.clear()).toBe(true);
    expect(mgr.isActive()).toBe(false);
    expect(mgr.clear()).toBe(false);
  });

  it("addChecklistItem appends to active goal", () => {
    const mgr = new GoalLoopManager();
    mgr.set("Task", ["one"]);
    mgr.addChecklistItem("two");
    expect(mgr.getStatus()!.checklist).toEqual(["one", "two"]);
  });

  it("evaluate on no goal is a no-op stop", () => {
    const d = new GoalLoopManager().evaluateAfterTurn("anything");
    expect(d.shouldContinue).toBe(false);
    expect(d.continuationPrompt).toBeNull();
  });
});
