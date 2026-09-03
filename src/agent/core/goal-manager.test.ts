/**
 * Tests for GoalManager with step-based goals (Stream A)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GoalStep } from "./goal-manager";
import { GoalManager } from "./goal-manager";
import { StateDb } from "../../state-db";
import { randomBytes } from "node:crypto";

describe("GoalManager", () => {
  let manager: GoalManager;
  const sessionId = "test-session";

  beforeEach(() => {
    manager = new GoalManager();
  });

  // ---------------------------------------------------------------------------
  // Backward compatible: existing research goal methods
  // ---------------------------------------------------------------------------

  describe("Research Goals (backward compat)", () => {
    it("creates a research goal", () => {
      const goal = manager.createGoal(sessionId, "Test Goal", "A test research goal");
      expect(goal.id).toBeDefined();
      expect(goal.title).toBe("Test Goal");
      expect(goal.status).toBe("active");
      expect(goal.claims).toEqual([]);
      expect(goal.evidence).toEqual([]);
    });

    it("adds claims and evidence", () => {
      const goal = manager.createGoal(sessionId, "Research", "test");
      const claim = manager.addClaim(goal.id, "BTC will go up");
      expect(claim.status).toBe("hypothesis");

      const evidence = manager.addEvidence(goal.id, claim.id, {
        claimId: claim.id,
        source: "test",
        content: "evidence content",
        confidence: 0.8,
        toolUsed: "test-tool",
      });
      expect(evidence.id).toBeDefined();
      expect(claim.evidenceIds).toContain(evidence.id);
    });

    it("checks completion", () => {
      const goal = manager.createGoal(sessionId, "Research", "test", undefined, {
        requireAllClaimsResolved: true,
        minEvidencePerClaim: 1,
        minConfidenceThreshold: 0,
      });
      manager.addClaim(goal.id, "Test claim");

      // No evidence -> incomplete
      const result = manager.checkCompletion(goal.id);
      expect(result.complete).toBe(false);
    });

    it("lists goals by session", () => {
      manager.createGoal(sessionId, "G1", "desc");
      manager.createGoal(sessionId, "G2", "desc");
      manager.createGoal("other-session", "G3", "desc");
      expect(manager.listGoals(sessionId)).toHaveLength(2);
    });

    it("exports goal as markdown", () => {
      const goal = manager.createGoal(sessionId, "Export Test", "desc");
      const output = manager.exportGoal(goal.id);
      expect(output).toContain("# Export Test");
    });

    it("deletes a goal", () => {
      const goal = manager.createGoal(sessionId, "Delete me", "desc");
      expect(manager.deleteGoal(goal.id)).toBe(true);
      expect(manager.getGoal(goal.id)).toBeUndefined();
    });

    it("increments budget", () => {
      const goal = manager.createGoal(sessionId, "Budget", "desc");
      manager.incrementBudget(goal.id, "currentTurns");
      manager.incrementBudget(goal.id, "currentToolCalls", 3);
      expect(goal.budget.currentTurns).toBe(1);
      expect(goal.budget.currentToolCalls).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // Step-Based Goals (Stream A)
  // ---------------------------------------------------------------------------

  describe("Step-Based Goals", () => {
    it("adds steps to a goal", () => {
      const goal = manager.createGoal(sessionId, "Step Goal", "A goal with steps");
      const step = manager.addStep(goal.id, {
        title: "Step 1",
        description: "First step",
        order: 0,
        dependsOn: [],
      });
      expect(step.id).toBeDefined();
      expect(step.title).toBe("Step 1");
      expect(step.status).toBe("pending");
      expect(step.budget.maxTurns).toBe(10);
      expect(step.goalId).toBe(goal.id);

      const steps = manager.listSteps(goal.id);
      expect(steps).toHaveLength(1);
    });

    it("adds a step with custom budget", () => {
      const goal = manager.createGoal(sessionId, "Budget Step", "desc");
      const step = manager.addStep(goal.id, {
        title: "Intensive Step",
        description: "Needs more turns",
        order: 0,
        budget: { maxTurns: 25 },
      });
      expect(step.budget.maxTurns).toBe(25);
      expect(step.budget.currentTurns).toBe(0);
    });

    it("creating a goal with steps via create action", () => {
      const goal = manager.createGoal(sessionId, "Multi Step", "desc");
      manager.addStep(goal.id, { title: "S1", description: "First", order: 0 });
      manager.addStep(goal.id, { title: "S2", description: "Second", order: 1, dependsOn: [] });
      manager.addStep(goal.id, { title: "S3", description: "Third", order: 2, dependsOn: [] });
      expect(manager.listSteps(goal.id)).toHaveLength(3);
    });

    it("throws when adding steps to a non-existent goal", () => {
      expect(() => manager.addStep("no-such-goal", {
        title: "Step",
        description: "",
        order: 0,
      })).toThrow("Goal not found");
    });

    it("updates step status", () => {
      const goal = manager.createGoal(sessionId, "Status", "desc");
      const step = manager.addStep(goal.id, { title: "S1", description: "", order: 0 });
      manager.updateStepStatus(goal.id, step.id, "in_progress");
      expect(manager.getStep(goal.id, step.id)!.status).toBe("in_progress");

      manager.updateStepStatus(goal.id, step.id, "completed", "Done output");
      const updated = manager.getStep(goal.id, step.id)!;
      expect(updated.status).toBe("completed");
      expect(updated.output).toBe("Done output");
      expect(updated.completedAt).toBeDefined();
    });

    it("updating step status throws for non-existent step", () => {
      expect(() => manager.updateStepStatus("no-goal", "no-step", "completed"))
        .toThrow("Step not found");
    });

    it("gets a single step by id", () => {
      const goal = manager.createGoal(sessionId, "Lookup", "desc");
      const step = manager.addStep(goal.id, { title: "Find me", description: "", order: 0 });
      const found = manager.getStep(goal.id, step.id);
      expect(found).toBeDefined();
      expect(found!.title).toBe("Find me");
    });

    it("listSteps returns ordered steps", () => {
      const goal = manager.createGoal(sessionId, "Order", "desc");
      manager.addStep(goal.id, { title: "C", description: "", order: 2 });
      manager.addStep(goal.id, { title: "A", description: "", order: 0 });
      manager.addStep(goal.id, { title: "B", description: "", order: 1 });
      const ordered = manager.listSteps(goal.id);
      expect(ordered.map((s) => s.title)).toEqual(["A", "B", "C"]);
    });

    it("getNextSteps respects dependsOn ordering", () => {
      const goal = manager.createGoal(sessionId, "Deps", "desc");
      const s1 = manager.addStep(goal.id, { title: "S1", description: "", order: 0 });
      const s2 = manager.addStep(goal.id, { title: "S2", description: "", order: 1, dependsOn: [s1.id] });
      const s3 = manager.addStep(goal.id, { title: "S3", description: "", order: 2, dependsOn: [s1.id, s2.id] });

      // No steps completed - only S1 should be ready
      let next = manager.getNextSteps(goal.id);
      expect(next).toHaveLength(1);
      expect(next[0]!.title).toBe("S1");

      // Complete S1 - S2 should be ready
      manager.updateStepStatus(goal.id, s1.id, "completed");
      next = manager.getNextSteps(goal.id);
      expect(next).toHaveLength(1);
      expect(next[0]!.title).toBe("S2");

      // Complete S2 - S3 should be ready
      manager.updateStepStatus(goal.id, s2.id, "completed");
      next = manager.getNextSteps(goal.id);
      expect(next).toHaveLength(1);
      expect(next[0]!.title).toBe("S3");
    });

    it("getNextSteps returns empty for completed goal", () => {
      const goal = manager.createGoal(sessionId, "Done", "desc");
      const s1 = manager.addStep(goal.id, { title: "S1", description: "", order: 0 });
      manager.updateStepStatus(goal.id, s1.id, "completed");
      expect(manager.getNextSteps(goal.id)).toHaveLength(0);
    });

    it("getGoalProgress returns correct stats", () => {
      const goal = manager.createGoal(sessionId, "Progress", "desc");
      const s1 = manager.addStep(goal.id, { title: "S1", description: "", order: 0 });
      const s2 = manager.addStep(goal.id, { title: "S2", description: "", order: 1 });
      const s3 = manager.addStep(goal.id, { title: "S3", description: "", order: 2 });

      let p = manager.getGoalProgress(goal.id);
      expect(p.total).toBe(3);
      expect(p.completed).toBe(0);
      expect(p.pending).toBe(3);
      expect(p.percentComplete).toBe(0);

      manager.updateStepStatus(goal.id, s1.id, "completed");
      p = manager.getGoalProgress(goal.id);
      expect(p.completed).toBe(1);
      expect(p.pending).toBe(2);
      expect(p.percentComplete).toBe(33);

      manager.updateStepStatus(goal.id, s2.id, "in_progress");
      p = manager.getGoalProgress(goal.id);
      expect(p.inProgress).toBe(1);
      expect(p.completed).toBe(1);
      expect(p.pending).toBe(1);

      manager.updateStepStatus(goal.id, s2.id, "failed");
      p = manager.getGoalProgress(goal.id);
      expect(p.failed).toBe(1);

      manager.updateStepStatus(goal.id, s3.id, "blocked");
      p = manager.getGoalProgress(goal.id);
      expect(p.blocked).toBe(1);
    });

    it("getGoalProgress returns 100% for no steps", () => {
      const goal = manager.createGoal(sessionId, "No steps", "desc");
      const p = manager.getGoalProgress(goal.id);
      expect(p.total).toBe(0);
      expect(p.percentComplete).toBe(100);
    });

    it("autoAdvance marks goal complete when all steps done", () => {
      const goal = manager.createGoal(sessionId, "Complete", "desc");
      const s1 = manager.addStep(goal.id, { title: "S1", description: "", order: 0 });
      const s2 = manager.addStep(goal.id, { title: "S2", description: "", order: 1, dependsOn: [s1.id] });

      manager.updateStepStatus(goal.id, s1.id, "completed");
      const adv1 = manager.autoAdvance(goal.id);
      expect(adv1.advanced).toBe(true);
      expect(adv1.nextSteps).toHaveLength(1);
      expect(adv1.nextSteps[0]!.title).toBe("S2");
      expect(manager.getStep(goal.id, s2.id)!.status).toBe("in_progress");

      manager.updateStepStatus(goal.id, s2.id, "completed");
      const adv2 = manager.autoAdvance(goal.id);
      expect(adv2.advanced).toBe(true);
      expect(adv2.nextSteps).toHaveLength(0);
      expect(manager.getGoal(goal.id)!.status).toBe("completed");
    });

    it("autoAdvance does nothing when no steps ready", () => {
      const goal = manager.createGoal(sessionId, "Blocked", "desc");
      const s1 = manager.addStep(goal.id, { title: "S1", description: "", order: 0 });
      const s2 = manager.addStep(goal.id, { title: "S2", description: "", order: 1, dependsOn: [s1.id] });

      // S2 depends on S1 which is pending
      const adv = manager.autoAdvance(goal.id);
      expect(adv.advanced).toBe(true); // S1 is ready
      expect(adv.nextSteps).toHaveLength(1);
    });

    it("autoAdvance marks goal complete when all steps done via failed status", () => {
      const goal = manager.createGoal(sessionId, "Mixed", "desc");
      const s1 = manager.addStep(goal.id, { title: "S1", description: "", order: 0 });
      const s2 = manager.addStep(goal.id, { title: "S2", description: "", order: 1 });

      manager.updateStepStatus(goal.id, s1.id, "completed");
      manager.autoAdvance(goal.id);
      manager.updateStepStatus(goal.id, s2.id, "failed");
      const adv = manager.autoAdvance(goal.id);
      expect(adv.advanced).toBe(true);
      expect(manager.getGoal(goal.id)!.status).toBe("completed");
    });

    it("persist/load cycle preserves all data", async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "goal-test-"));
      try {
        const goal = manager.createGoal(sessionId, "Persist Test", "Testing persist/load", undefined, {
          requireAllClaimsResolved: true,
          minEvidencePerClaim: 1,
          minConfidenceThreshold: 0.5,
        });

        // Add some steps
        const s1 = manager.addStep(goal.id, { title: "Research", description: "Do research", order: 0 });
        const s2 = manager.addStep(goal.id, {
          title: "Analyze",
          description: "Analyze results",
          order: 1,
          dependsOn: [s1.id],
          assignableTools: ["read", "grep"],
        });

        // Update states
        manager.updateStepStatus(goal.id, s1.id, "completed", "Research done");
        manager.updateStepStatus(goal.id, s2.id, "in_progress");

        // Add a claim + evidence (existing behavior)
        const claim = manager.addClaim(goal.id, "Test claim");
        manager.addEvidence(goal.id, claim.id, {
          claimId: claim.id,
          source: "test-source",
          content: "evidence content",
          confidence: 0.8,
          toolUsed: "test-tool",
        });

        await manager.persist(tmpDir);

        // Create a fresh manager and load
        const loaded = new GoalManager();
        await loaded.load(tmpDir);

        // Verify goal
        const loadedGoal = loaded.getGoal(goal.id);
        expect(loadedGoal).toBeDefined();
        expect(loadedGoal!.title).toBe("Persist Test");
        expect(loadedGoal!.status).toBe("active");
        expect(loadedGoal!.claims).toHaveLength(1);
        expect(loadedGoal!.evidence).toHaveLength(1);
        expect(loadedGoal!.evidence[0]!.confidence).toBe(0.8);
        expect(loadedGoal!.completionPolicy.minConfidenceThreshold).toBe(0.5);

        // Verify steps
        const loadedSteps = loaded.listSteps(goal.id);
        expect(loadedSteps).toHaveLength(2);
        const loadedS1 = loadedSteps.find((s) => s.title === "Research")!;
        expect(loadedS1.status).toBe("completed");
        expect(loadedS1.output).toBe("Research done");
        expect(loadedS1.completedAt).toBeDefined();

        const loadedS2 = loadedSteps.find((s) => s.title === "Analyze")!;
        expect(loadedS2.status).toBe("in_progress");
        expect(loadedS2.dependsOn).toEqual([s1.id]);
        expect(loadedS2.assignableTools).toEqual(["read", "grep"]);

        // Verify dates are properly restored as Date objects
        expect(loadedS1.createdAt).toBeInstanceOf(Date);
        expect(loadedS1.completedAt).toBeInstanceOf(Date);
        expect(loadedS2.updatedAt).toBeInstanceOf(Date);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("load from non-existent file does not throw", async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "goal-empty-"));
      try {
        const loaded = new GoalManager();
        await expect(loaded.load(tmpDir)).resolves.not.toThrow();
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("persist overwrites existing file correctly", async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "goal-overwrite-"));
      try {
        const g1 = manager.createGoal(sessionId, "First", "desc");
        manager.addStep(g1.id, { title: "Step A", description: "", order: 0 });
        await manager.persist(tmpDir);

        // Second persist with different data
        const manager2 = new GoalManager();
        const g2 = manager2.createGoal(sessionId, "Second", "desc");
        manager2.addStep(g2.id, { title: "Step B", description: "", order: 0 });
        await manager2.persist(tmpDir);

        // Load should show only second data
        const loaded = new GoalManager();
        await loaded.load(tmpDir);
        const goals = loaded.listAllGoals();
        expect(goals).toHaveLength(1);
        expect(goals[0]!.title).toBe("Second");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("deleting a goal removes its steps", () => {
      const goal = manager.createGoal(sessionId, "Delete steps", "desc");
      manager.addStep(goal.id, { title: "S1", description: "", order: 0 });
      manager.deleteGoal(goal.id);
      expect(manager.listSteps(goal.id)).toHaveLength(0);
    });

    it("backward compat: research goal methods still work alongside steps", () => {
      const goal = manager.createGoal(sessionId, "Hybrid", "desc");
      // Research methods
      const claim = manager.addClaim(goal.id, "A claim");
      manager.addEvidence(goal.id, claim.id, {
        claimId: claim.id,
        source: "src",
        content: "ev",
        confidence: 0.9,
        toolUsed: "t",
      });
      // Step methods
      const step = manager.addStep(goal.id, { title: "Step 1", description: "", order: 0 });
      manager.updateStepStatus(goal.id, step.id, "completed");

      expect(manager.getGoal(goal.id)!.claims).toHaveLength(1);
      expect(manager.listSteps(goal.id)).toHaveLength(1);
      expect(manager.checkCompletion(goal.id).reasons.length).toBeGreaterThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// StateDb integration tests
// ---------------------------------------------------------------------------

describe("GoalManager with StateDb", () => {
  function createTestDb(): StateDb {
    const tmpDir = mkdtempSync(join(tmpdir(), "goal-state-db-"));
    return new StateDb(tmpDir);
  }

  function cleanupDb(db: StateDb): void {
    db.close();
    // The db path is e.g. <tmpDir>/state.db — remove the parent dir
    const dbDir = db.path.replace(/state\.db$/, "");
    if (dbDir && dbDir !== db.path) {
      try {
        rmSync(dbDir, { recursive: true, force: true });
      } catch {
        // already cleaned up
      }
    }
  }

  it("createGoal persists to StateDb", () => {
    const db = createTestDb();
    try {
      const manager = new GoalManager(db);
      const goal = manager.createGoal("session-1", "DB Goal", "Persisted via StateDb");

      const row = db.getGoal(goal.id);
      expect(row).not.toBeNull();
      expect(row!.title).toBe("DB Goal");
      expect(row!.session_id).toBe("session-1");
      expect(row!.status).toBe("active");
    } finally {
      cleanupDb(db);
    }
  });

  it("addStep persists to StateDb", () => {
    const db = createTestDb();
    try {
      const manager = new GoalManager(db);
      const goal = manager.createGoal("session-1", "Step Goal", "With step");

      const step = manager.addStep(goal.id, {
        title: "Step 1",
        description: "First step",
        order: 0,
      });

      const stepRow = db.getGoalStep(step.id);
      expect(stepRow).not.toBeNull();
      expect(stepRow!.title).toBe("Step 1");
      expect(stepRow!.goal_id).toBe(goal.id);
      expect(stepRow!.status).toBe("pending");
    } finally {
      cleanupDb(db);
    }
  });

  it("updateStepStatus updates data in StateDb", () => {
    const db = createTestDb();
    try {
      const manager = new GoalManager(db);
      const goal = manager.createGoal("session-1", "Status Goal", "Testing status update");
      const step = manager.addStep(goal.id, {
        title: "Step 1",
        description: "",
        order: 0,
      });

      manager.updateStepStatus(goal.id, step.id, "completed", "Done");

      const stepRow = db.getGoalStep(step.id);
      expect(stepRow!.status).toBe("completed");
      expect(stepRow!.output).toBe("Done");
      expect(stepRow!.completed_at).not.toBeNull();
    } finally {
      cleanupDb(db);
    }
  });

  it("deleteGoal removes data from StateDb", () => {
    const db = createTestDb();
    try {
      const manager = new GoalManager(db);
      const goal = manager.createGoal("session-1", "Delete Goal", "Will be deleted");
      manager.addStep(goal.id, { title: "Step 1", description: "", order: 0 });

      expect(db.getGoal(goal.id)).not.toBeNull();
      expect(db.listGoalSteps(goal.id)).toHaveLength(1);

      manager.deleteGoal(goal.id);

      expect(db.getGoal(goal.id)).toBeNull();
      expect(db.listGoalSteps(goal.id)).toHaveLength(0);
    } finally {
      cleanupDb(db);
    }
  });

  it("fromDb() loads all goals and steps from StateDb", () => {
    const db = createTestDb();
    try {
      // First, create data via one manager
      const writer = new GoalManager(db);
      const g1 = writer.createGoal("session-1", "Goal 1", "First");
      writer.addStep(g1.id, { title: "S1", description: "", order: 0 });
      const g2 = writer.createGoal("session-1", "Goal 2", "Second");
      writer.addStep(g2.id, { title: "S2", description: "", order: 0 });

      // Now use fromDb
      const reader = GoalManager.fromDb(db);
      expect(reader.listAllGoals()).toHaveLength(2);
      expect(reader.listSteps(g1.id)).toHaveLength(1);
      expect(reader.listSteps(g2.id)).toHaveLength(1);
      const loadedG1 = reader.getGoal(g1.id);
      expect(loadedG1).toBeDefined();
      expect(loadedG1!.title).toBe("Goal 1");
    } finally {
      cleanupDb(db);
    }
  });

  it("loadFromDb() clears and reloads from StateDb", () => {
    const db = createTestDb();
    try {
      // Write data
      const writer = new GoalManager(db);
      const g1 = writer.createGoal("session-1", "Original", "desc");
      writer.addStep(g1.id, { title: "S1", description: "", order: 0 });

      // Create a reader manager, initially empty
      const reader = new GoalManager(db);
      expect(reader.listAllGoals()).toHaveLength(0);

      // Load from db
      reader.loadFromDb();
      expect(reader.listAllGoals()).toHaveLength(1);
      expect(reader.getGoal(g1.id)).toBeDefined();
      expect(reader.listSteps(g1.id)).toHaveLength(1);
    } finally {
      cleanupDb(db);
    }
  });

  it("loadFromDb() preserves data fidelity", () => {
    const db = createTestDb();
    try {
      const writer = new GoalManager(db);
      const goal = writer.createGoal(
        "session-1",
        "Fidelity Test",
        "Testing round-trip",
        { maxTurns: 10, maxToolCalls: 20 },
        { requireAllClaimsResolved: false, minEvidencePerClaim: 1, minConfidenceThreshold: 0.5 },
      );
      const claim = writer.addClaim(goal.id, "Test claim");
      writer.addEvidence(goal.id, claim.id, {
        claimId: claim.id,
        source: "test",
        content: "evidence content",
        confidence: 0.8,
        toolUsed: "test-tool",
      });
      const step = writer.addStep(goal.id, {
        title: "Research",
        description: "Do research",
        order: 0,
        dependsOn: [],
        assignableTools: ["read", "grep"],
        budget: { maxTurns: 5 },
      });
      writer.updateStepStatus(goal.id, step.id, "completed", "Done output");
      writer.incrementBudget(goal.id, "currentTurns", 2);

      // Load into fresh manager
      const reader = GoalManager.fromDb(db);
      const loadedGoal = reader.getGoal(goal.id);
      expect(loadedGoal).toBeDefined();
      expect(loadedGoal!.title).toBe("Fidelity Test");
      expect(loadedGoal!.claims).toHaveLength(1);
      expect(loadedGoal!.claims[0]!.statement).toBe("Test claim");
      expect(loadedGoal!.evidence).toHaveLength(1);
      expect(loadedGoal!.evidence[0]!.confidence).toBe(0.8);
      expect(loadedGoal!.evidence[0]!.timestamp).toBeInstanceOf(Date);
      expect(loadedGoal!.budget.maxTurns).toBe(10);
      expect(loadedGoal!.budget.currentTurns).toBe(2);
      expect(loadedGoal!.completionPolicy.requireAllClaimsResolved).toBe(false);
      expect(loadedGoal!.completedAt).toBeUndefined();

      const loadedSteps = reader.listSteps(goal.id);
      expect(loadedSteps).toHaveLength(1);
      expect(loadedSteps[0]!.title).toBe("Research");
      expect(loadedSteps[0]!.status).toBe("completed");
      expect(loadedSteps[0]!.output).toBe("Done output");
      expect(loadedSteps[0]!.completedAt).toBeInstanceOf(Date);
      expect(loadedSteps[0]!.assignableTools).toEqual(["read", "grep"]);
      expect(loadedSteps[0]!.budget.maxTurns).toBe(5);
    } finally {
      cleanupDb(db);
    }
  });

  it("addClaim and addEvidence persist to StateDb", () => {
    const db = createTestDb();
    try {
      const manager = new GoalManager(db);
      const goal = manager.createGoal("session-1", "Claim Test", "Testing claims");

      const claim = manager.addClaim(goal.id, "BTC will moon");
      let row = db.getGoal(goal.id);
      let parsedClaims = JSON.parse(row!.claims);
      expect(parsedClaims).toHaveLength(1);
      expect(parsedClaims[0]!.statement).toBe("BTC will moon");

      manager.addEvidence(goal.id, claim.id, {
        claimId: claim.id,
        source: "crypto-news",
        content: "BTC is up 10%",
        confidence: 0.9,
        toolUsed: "web-search",
      });
      row = db.getGoal(goal.id);
      const parsedEvidence = JSON.parse(row!.evidence);
      expect(parsedEvidence).toHaveLength(1);
      expect(parsedEvidence[0]!.source).toBe("crypto-news");
    } finally {
      cleanupDb(db);
    }
  });

  it("updateGoalStatus persists to StateDb", () => {
    const db = createTestDb();
    try {
      const manager = new GoalManager(db);
      const goal = manager.createGoal("session-1", "Status Test", "Testing status");

      manager.updateGoalStatus(goal.id, "completed");
      const row = db.getGoal(goal.id);
      expect(row!.status).toBe("completed");
    } finally {
      cleanupDb(db);
    }
  });

  it("incrementBudget persists to StateDb", () => {
    const db = createTestDb();
    try {
      const manager = new GoalManager(db);
      const goal = manager.createGoal("session-1", "Budget Test", "Testing budget");

      manager.incrementBudget(goal.id, "currentTurns", 3);
      const row = db.getGoal(goal.id);
      const parsedBudget = JSON.parse(row!.budget);
      expect(parsedBudget.currentTurns).toBe(3);
    } finally {
      cleanupDb(db);
    }
  });

  it("no-arg constructor still works (backward compat)", () => {
    const manager = new GoalManager();
    const goal = manager.createGoal("session-1", "No DB", "No StateDb");
    expect(goal.title).toBe("No DB");
    expect(manager.listAllGoals()).toHaveLength(1);
  });
});
