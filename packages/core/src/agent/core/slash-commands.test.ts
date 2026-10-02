import { describe, expect, it, vi, beforeEach } from "vitest";
import { SlashCommandRegistry, registerDefaultCommands } from "./slash-commands";
import { GoalLoopManager } from "./goal-loop";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function registry(): SlashCommandRegistry {
  const result = new SlashCommandRegistry();
  registerDefaultCommands(result);
  return result;
}

const loop = new GoalLoopManager();

describe("general slash commands", () => {
  it("sets and manages a goal loop", async () => {
    const commands = registry();
    const ctx = { agent: { getGoalLoop: () => loop } };
    const result = await commands.execute("/goal Ship release", ctx);
    expect(result?.content).toContain("Goal set");
    expect((await commands.execute("/goal status", ctx))?.content).toContain("Ship release");
    await commands.execute("/goal pause", ctx);
    expect((await commands.execute("/goal status", ctx))?.content).toContain("[paused]");
    await commands.execute("/goal resume", ctx);
    expect((await commands.execute("/goal clear", ctx))?.content).toContain("cleared");
  });

  it("creates a skill from a completed task", async () => {
    const createSkillFromTask = vi.fn().mockResolvedValue({ name: "debug-websocket" });
    const result = await registry().execute("/skill create Debug websocket -- Inspect close events", { skillFactory: { createSkillFromTask } });
    expect(result?.content).toBe("Skill created: debug-websocket");
    expect(createSkillFromTask).toHaveBeenCalledWith(expect.objectContaining({ title: "Debug websocket", successful: true }));
  });

  it("runs a dream cycle", async () => {
    const runDreamCycle = vi.fn().mockResolvedValue({ id: "dream-1", summary: "Found two patterns" });
    const result = await registry().execute("/dream", { dreamEngine: { runDreamCycle } });
    expect(result?.content).toContain("Found two patterns");
  });
});

describe("DynaTrader slash commands", () => {
  let commands: SlashCommandRegistry;

  beforeEach(() => {
    commands = registry();
  });

  it("should have /me command", async () => {
    const result = await commands.execute("/me", {});
    expect(result).not.toBeNull();
    expect(result!.content).toContain("Agent Profile");
  });

  it("should have /positions command", async () => {
    const result = await commands.execute("/positions", {});
    expect(result).not.toBeNull();
    expect(result!.content).toContain("Positions");
  });

  it("creates one persistent recurring prompt and reports its actual status", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dynatrader-loop-"));
    const { CronEngine } = await import("../cron/cron-engine");
    const engine = new CronEngine(dir);
    await engine.initialize();
    const ctx = { cronEngine: engine };
    try {
      const result = await commands.execute("/loop 5m /positions", ctx);
      expect(result?.content).toContain("Loop set");
      const jobs = await engine.listJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ name: "slash-loop", prompt: "/positions", tags: ["slash-loop"], repeatCount: null, enabled: true });
      expect((await commands.execute("/loop status", ctx))?.content).toContain(jobs[0].id);
    } finally {
      await engine.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the existing loop when replacement schedule is invalid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dynatrader-loop-invalid-"));
    const { CronEngine } = await import("../cron/cron-engine");
    const engine = new CronEngine(dir);
    await engine.initialize();
    try {
      await commands.execute("/loop 5m /positions", { cronEngine: engine });
      const before = await engine.listJobs();
      const result = await commands.execute("/loop invalid /new", { cronEngine: engine });
      expect(result?.content).toContain("Loop error");
      expect(await engine.listJobs()).toEqual(before);
    } finally {
      await engine.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rolls back the replacement job when deleting the current loop fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dynatrader-loop-delete-failure-"));
    const { CronEngine } = await import("../cron/cron-engine");
    const engine = new CronEngine(dir);
    await engine.initialize();
    try {
      await commands.execute("/loop 5m /positions", { cronEngine: engine });
      const [currentJob] = await engine.listJobs();
      const deleteJob = engine.deleteJob.bind(engine);
      vi.spyOn(engine, "deleteJob").mockImplementation(async (jobId) => {
        if (jobId === currentJob!.id) throw new Error("simulated delete failure");
        await deleteJob(jobId);
      });

      const result = await commands.execute("/loop 10m /new", { cronEngine: engine });

      expect(result?.content).toContain("Loop error");
      expect(await engine.listJobs()).toEqual([expect.objectContaining({ id: currentJob!.id, prompt: "/positions" })]);
    } finally {
      await engine.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("executes a loop-created prompt through CronEngine", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dynatrader-loop-trigger-"));
    const executed: string[] = [];
    const { CronEngine } = await import("../cron/cron-engine");
    const engine = new CronEngine(dir, async (prompt) => { executed.push(prompt); return "executed"; });
    await engine.initialize();
    try {
      await commands.execute("/loop 5m /positions", { cronEngine: engine });
      const job = (await engine.listJobs())[0]!;
      await engine.triggerJob(job.id);
      expect(executed).toContain("/positions");
    } finally {
      await engine.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("/loop stop ends the loop", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dynatrader-loop-stop-"));
    const { CronEngine } = await import("../cron/cron-engine");
    const engine = new CronEngine(dir);
    await engine.initialize();
    const unrelated = await engine.createJob({ name: "other", prompt: "keep", schedule: "every 5m" });
    const ctx = { cronEngine: engine };
    try {
      await commands.execute("/loop 5m /positions", ctx);
      const result = await commands.execute("/loop stop", ctx);
      expect(result?.content).toContain("Loop stopped");
      expect(await engine.listJobs()).toEqual([expect.objectContaining({ id: unrelated.id })]);
    } finally {
      await engine.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not register removed portfolio commands", async () => {
    expect((await commands.execute("/p", {}))?.content).toContain("Unknown command: /p");
    expect((await commands.execute("/portfolio", {}))?.content).toContain("Unknown command: /portfolio");
  });

  it("requires CronEngine to create loop jobs", async () => {
    const result = await commands.execute("/loop 5m /positions", {});
    expect(result?.content).toContain("No cron engine configured");
  });

  it("/loop status shows not active", async () => {
    expect((await commands.execute("/loop status", {}))?.content).toContain("No cron engine configured");
  });

  it("shows an unavailable schedule for legacy loop jobs", async () => {
    const job = { id: "legacy-loop", schedule: undefined, enabled: true, state: "scheduled", prompt: "Check positions", tags: ["slash-loop"] };
    const result = await commands.execute("/loop status", { cronEngine: { listJobs: vi.fn().mockResolvedValue([job]) } });
    expect(result?.content).toContain("unknown schedule");
    expect(result?.content).toContain("legacy-loop");
  });

  it("shows status and stop reports correctly when no loop exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dynatrader-loop-empty-"));
    const { CronEngine } = await import("../cron/cron-engine");
    const engine = new CronEngine(dir);
    await engine.initialize();
    try {
      expect((await commands.execute("/loop status", { cronEngine: engine }))?.content).toContain("not active");
      expect((await commands.execute("/loop stop", { cronEngine: engine }))?.content).toContain("no loop jobs");
    } finally {
      await engine.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("/status reports cron job listing failures instead of zero jobs", async () => {
    const result = await commands.execute("/status", {
      agent: { getState: () => "running" },
      cronEngine: { listJobs: vi.fn().mockRejectedValue(new Error("storage unavailable")) },
    });
    expect(result?.content).toContain("Cron Jobs: unavailable");
    expect(result?.content).toContain("storage unavailable");
    expect(result?.content).not.toContain("0 active of 0 total");
  });

  it("should have /cron command", async () => {
    const mockCronEngine = {
      listJobs: vi.fn().mockResolvedValue([]),
      getJob: vi.fn().mockResolvedValue(null),
      createJob: vi.fn().mockResolvedValue({ id: "job-1", name: "Test", schedule: { display: "every 1h" }, enabled: true, state: "scheduled" }),
      triggerJob: vi.fn().mockResolvedValue({ jobId: "job-1", timestamp: Date.now(), duration: 100, success: true, output: "ok" }),
      pauseJob: vi.fn().mockResolvedValue({ name: "Test", id: "job-1" }),
      resumeJob: vi.fn().mockResolvedValue({ name: "Test", id: "job-1" }),
      deleteJob: vi.fn().mockResolvedValue(undefined),
    };
    const result = await commands.execute("/cron list", { cronEngine: mockCronEngine });
    expect(result).not.toBeNull();
    expect(result!.content).toContain("No cron jobs scheduled.");
  });

  it("/cron add creates a new job", async () => {
    const mockCronEngine = {
      listJobs: vi.fn().mockResolvedValue([]),
      getJob: vi.fn().mockResolvedValue(null),
      createJob: vi.fn().mockImplementation(async (spec: any) => ({ id: "job-1", name: "Cron Job", prompt: spec.prompt, schedule: { display: spec.schedule }, enabled: true, state: "scheduled" })),
      triggerJob: vi.fn(), pauseJob: vi.fn(), resumeJob: vi.fn(), deleteJob: vi.fn(),
    };
      const result = await commands.execute('/cron add "0 9 * * *" "Check positions"', { cronEngine: mockCronEngine });
      expect(result).not.toBeNull();
      expect(result!.content).toContain("Cron job created");
      expect(mockCronEngine.createJob).toHaveBeenCalledWith({ name: "Cron Job", prompt: "Check positions", schedule: "0 9 * * *", enabled: true });
  });

  it("/cron add parses an unquoted five-field schedule before the prompt", async () => {
    const createJob = vi.fn().mockImplementation(async (spec: any) => ({ id: "job-1", name: "Cron Job", prompt: spec.prompt, schedule: { display: spec.schedule }, enabled: true, state: "scheduled" }));
    const result = await commands.execute("/cron add 0 9 * * * Check positions", { cronEngine: { createJob } });
    expect(result?.content).toContain("Cron job created");
    expect(createJob).toHaveBeenCalledWith({ name: "Cron Job", schedule: "0 9 * * *", prompt: "Check positions", enabled: true });
  });

  it("/cron add preserves a quoted interval schedule", async () => {
    const createJob = vi.fn().mockImplementation(async (spec: any) => ({ id: "job-1", name: "Cron Job", prompt: spec.prompt, schedule: { display: spec.schedule }, enabled: true, state: "scheduled" }));
    const result = await commands.execute('/cron add "every 5m" "Check positions"', { cronEngine: { createJob } });
    expect(result?.content).toContain("Cron job created");
    expect(createJob).toHaveBeenCalledWith({ name: "Cron Job", schedule: "every 5m", prompt: "Check positions", enabled: true });
  });

  it("/cron add persists the quoted five-field schedule and prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dynatrader-cron-add-"));
    const { CronEngine } = await import("../cron/cron-engine");
    const engine = new CronEngine(dir);
    await engine.initialize();
    try {
      const result = await commands.execute('/cron add "0 9 * * *" "Check positions"', { cronEngine: engine });
      expect(result?.content).toContain("Cron job created");
      expect(await engine.listJobs()).toEqual([expect.objectContaining({ name: "Cron Job", schedule: expect.objectContaining({ display: "0 9 * * *" }), prompt: "Check positions", enabled: true })]);
    } finally {
      await engine.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("/cron remove removes a job", async () => {
    const mockCronEngine = {
      listJobs: vi.fn().mockResolvedValue([]),
      getJob: vi.fn().mockResolvedValue(null),
      createJob: vi.fn(),
      triggerJob: vi.fn(), pauseJob: vi.fn(), resumeJob: vi.fn(),
      deleteJob: vi.fn().mockResolvedValue(undefined),
    };
    const result = await commands.execute("/cron remove job-1", { cronEngine: mockCronEngine });
    expect(result).not.toBeNull();
    expect(result!.content).toContain("Cron job removed");
  });

  it("/help lists all commands", async () => {
    const result = await commands.execute("/help", {});
    expect(result).not.toBeNull();
    expect(result!.content).toContain("Available commands");
  });

  it("/loop shows usage when no args", async () => {
    const result = await commands.execute("/loop", {});
    expect(result).not.toBeNull();
    expect(result!.content).toContain("Usage");
  });

  it("/cron shows usage when no subcommand", async () => {
    const mockCronEngine = {
      listJobs: vi.fn().mockResolvedValue([]),
      getJob: vi.fn().mockResolvedValue(null),
      createJob: vi.fn(), triggerJob: vi.fn(), pauseJob: vi.fn(), resumeJob: vi.fn(), deleteJob: vi.fn(),
    };
    const result = await commands.execute("/cron", { cronEngine: mockCronEngine });
    expect(result).not.toBeNull();
    expect(result!.content).toContain("Usage");
  });

  it("should still have /version command", async () => {
    const result = await commands.execute("/version", {});
    expect(result).not.toBeNull();
    expect(result!.content).toContain("DynaTrader");
  });

  it("/me shows agent info when agent is provided", async () => {
    const mockAgent = { agentId: "agent-123", mode: "live", executionMode: "paper" };
    const mockModelRouter = { getActiveModel: () => ({ name: "gpt-4" }) };
    const result = await commands.execute("/me", { agent: mockAgent, modelRouter: mockModelRouter });
    expect(result!.content).toContain("agent-123");
    expect(result!.content).toContain("gpt-4");
  });

  it("/pnl reports profit and loss", async () => {
    const result = await commands.execute("/pnl", { agent: { paperEngine: { getPortfolio: () => ({ realizedPnl: 3, unrealizedPnl: 2, totalValue: 100 }) } } });
    expect(result).not.toBeNull();
  });

  it("/alerts handles empty alerts", async () => {
    const result = await commands.execute("/alerts", {});
    expect(result).not.toBeNull();
    expect(result?.content).toContain("Alerts");
  });

  it("/sim start calls dreamEngine.start", async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const result = await commands.execute("/sim start", { dreamEngine: { start } });
    expect(start).toHaveBeenCalledOnce();
    expect(result!.content).toContain("started");
  });

  it("/sim stop calls dreamEngine.stop", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const result = await commands.execute("/sim stop", { dreamEngine: { stop } });
    expect(stop).toHaveBeenCalledOnce();
    expect(result!.content).toContain("stopped");
  });
});
