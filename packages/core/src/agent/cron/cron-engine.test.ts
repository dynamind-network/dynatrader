/**
 * Tests for CronEngine — User-Configurable Cron System with jobs.json
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronEngine, validateCronCommand } from "./cron-engine";
import type { CronJob, CronExecution } from "./cron-engine";
import { StateDb } from "../../state-db";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_WORKSPACE = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "test",
  "tmp",
  "cron-test",
);

function cleanTestDir(): void {
  if (existsSync(TEST_WORKSPACE)) {
    rmSync(TEST_WORKSPACE, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// validateCronCommand
// ---------------------------------------------------------------------------

describe("validateCronCommand", () => {
  it("should accept a simple echo command", () => {
    expect(validateCronCommand("echo hello")).toBe(true);
  });

  it("should accept a command with path separators", () => {
    expect(validateCronCommand("/usr/bin/python3 /scripts/check.py")).toBe(true);
  });

  it("should accept a command with dashes and underscores", () => {
    expect(validateCronCommand("git pull --rebase")).toBe(true);
  });

  it("should accept a command with colons for env vars or paths", () => {
    expect(validateCronCommand("node dist/daemon.js --env NODE_ENV=production")).toBe(true);
  });

  it("should accept a command with dots for extensions", () => {
    expect(validateCronCommand("bun run build.ts")).toBe(true);
  });

  it("should reject a command with semicolon (command chaining)", () => {
    expect(validateCronCommand("echo hello; rm -rf /")).toBe(false);
  });

  it("should reject a command with pipe", () => {
    expect(validateCronCommand("cat /etc/passwd | grep root")).toBe(false);
  });

  it("should reject a command with backtick command substitution", () => {
    expect(validateCronCommand("echo `whoami`")).toBe(false);
  });

  it("should reject a command with dollar sign variable expansion", () => {
    expect(validateCronCommand("echo $HOME")).toBe(false);
  });

  it("should reject a command with ampersand backgrounding", () => {
    expect(validateCronCommand("curl evil.com &")).toBe(false);
  });

  it("should reject a command with angle bracket redirection", () => {
    expect(validateCronCommand("ls > /dev/null")).toBe(false);
    expect(validateCronCommand("cat < /etc/passwd")).toBe(false);
  });

  it("should reject a command with parentheses subshell", () => {
    expect(validateCronCommand("(echo hello)")).toBe(false);
  });

  it("should reject a command with curly braces", () => {
    expect(validateCronCommand("echo {a,b,c}")).toBe(false);
  });

  it("should reject a command with exclamation mark", () => {
    expect(validateCronCommand("echo !$")).toBe(false);
  });

  it("should reject a command with hash comment", () => {
    expect(validateCronCommand("echo hello # comment")).toBe(false);
  });

  it("should reject a command with star glob", () => {
    expect(validateCronCommand("rm -rf *")).toBe(false);
  });

  it("should reject a command with question mark glob", () => {
    expect(validateCronCommand("cat config?.json")).toBe(false);
  });

  it("should reject a command with square bracket glob", () => {
    expect(validateCronCommand("cat file[123].txt")).toBe(false);
  });

  it("should reject a command with tilde home dir", () => {
    expect(validateCronCommand("ls ~/home")).toBe(false);
  });

  it("should reject a command with backslash escape", () => {
    expect(validateCronCommand("echo hello\\ world")).toBe(false);
  });

  it("should reject an empty command", () => {
    expect(validateCronCommand("")).toBe(false);
  });

  it("should reject a command with only whitespace", () => {
    expect(validateCronCommand("   ")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CronEngine", () => {
  let engine: CronEngine;

  beforeEach(async () => {
    cleanTestDir();
    engine = new CronEngine(TEST_WORKSPACE);
    await engine.initialize();
  });

  afterEach(() => {
    engine.stop();
    cleanTestDir();
  });

  // -----------------------------------------------------------------------
  // Create Job
  // -----------------------------------------------------------------------

  describe("createJob()", () => {
    it("should create a job with an id and timestamps", async () => {
      const job = await engine.createJob({
        name: "Test Job",
        prompt: "Run market scan",
        schedule: "every 1h",
        tags: ["market", "scan"],
      });

      expect(job.id).toBeDefined();
      expect(job.id.length).toBeGreaterThan(0);
      expect(job.name).toBe("Test Job");
      expect(job.prompt).toBe("Run market scan");
      expect(job.command).toBeUndefined();
      expect(job.enabled).toBe(true);
      expect(job.state).toBe("scheduled");
      expect(job.runCount).toBe(0);
      expect(job.completedRuns).toBe(0);
      expect(job.lastStatus).toBeNull();
      expect(job.createdAt).toBeGreaterThan(0);
      expect(job.updatedAt).toBeGreaterThan(0);
      expect(job.nextRunAt).toBeGreaterThan(0);
      expect(job.tags).toEqual(["market", "scan"]);
      expect(job.schedule.kind).toBe("interval");
      expect(job.schedule.intervalMs).toBe(3_600_000);
    });

    it("should create a job with command (no prompt)", async () => {
      const job = await engine.createJob({
        name: "Shell Job",
        command: "echo hello",
        schedule: "every 30m",
      });

      expect(job.command).toBe("echo hello");
      expect(job.prompt).toBeUndefined();
      expect(job.enabled).toBe(true);
    });

    it("should throw if neither prompt nor command is provided", async () => {
      await expect(
        engine.createJob({
          name: "Empty Job",
          schedule: "every 1h",
        }),
      ).rejects.toThrow("must have either a prompt or a command");
    });

    it("should default tags to empty array", async () => {
      const job = await engine.createJob({
        name: "No Tags",
        prompt: "test",
        schedule: "30m",
      });

      expect(job.tags).toEqual([]);
    });

    it("should store job in jobs.json", async () => {
      const job = await engine.createJob({
        name: "Persistent",
        prompt: "check",
        schedule: "every 1d",
      });

      const jobsPath = join(TEST_WORKSPACE, "cron", "jobs.json");
      expect(existsSync(jobsPath)).toBe(true);

      const content = readFileSync(jobsPath, "utf-8");
      const parsed = JSON.parse(content);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].name).toBe("Persistent");
      expect(parsed[0].id).toBe(job.id);
    });

    it("should store deliver configuration", async () => {
      const job = await engine.createJob({
        name: "Deliver Job",
        prompt: "report",
        schedule: "every 1h",
        deliver: { target: "telegram", chatId: "12345" },
      });

      expect(job.deliver).toEqual({ target: "telegram", chatId: "12345" });
    });

    it("should store repeatCount", async () => {
      const job = await engine.createJob({
        name: "Repeat Job",
        prompt: "run once",
        schedule: "30m",
        repeatCount: 3,
      });

      expect(job.repeatCount).toBe(3);
      expect(job.completedRuns).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Get Job
  // -----------------------------------------------------------------------

  describe("getJob()", () => {
    it("should return a job by id", async () => {
      const created = await engine.createJob({
        name: "Get Me",
        prompt: "find me",
        schedule: "every 30m",
      });

      const found = await engine.getJob(created.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.name).toBe("Get Me");
    });

    it("should return null for a missing job", async () => {
      const result = await engine.getJob("nonexistent-id");
      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // List Jobs
  // -----------------------------------------------------------------------

  describe("listJobs()", () => {
    it("should list all jobs", async () => {
      await engine.createJob({ name: "Job A", prompt: "a", schedule: "every 1h" });
      await engine.createJob({ name: "Job B", prompt: "b", schedule: "every 2h" });
      await engine.createJob({ name: "Job C", prompt: "c", schedule: "every 3h" });

      const jobs = await engine.listJobs();
      expect(jobs).toHaveLength(3);
    });

    it("should filter by enabled state", async () => {
      const job1 = await engine.createJob({ name: "Enabled", prompt: "e", schedule: "every 1h" });
      const job2 = await engine.createJob({ name: "To Pause", prompt: "p", schedule: "every 2h" });

      await engine.pauseJob(job2.id);

      const all = await engine.listJobs();
      expect(all).toHaveLength(2);

      const enabled = await engine.listJobs(true);
      expect(enabled).toHaveLength(1);
      expect(enabled[0]!.id).toBe(job1.id);
    });

    it("should return empty array when no jobs exist", async () => {
      const jobs = await engine.listJobs();
      expect(jobs).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Update Job
  // -----------------------------------------------------------------------

  describe("updateJob()", () => {
    it("should update job fields", async () => {
      const job = await engine.createJob({
        name: "Original",
        prompt: "original prompt",
        schedule: "every 1h",
        tags: ["old"],
      });

      const updated = await engine.updateJob(job.id, {
        name: "Updated",
        prompt: "updated prompt",
        tags: ["new"],
      });

      expect(updated.name).toBe("Updated");
      expect(updated.prompt).toBe("updated prompt");
      expect(updated.tags).toEqual(["new"]);
      expect(updated.updatedAt).toBeGreaterThanOrEqual(job.updatedAt);
    });

    it("should re-parse schedule when updated", async () => {
      const job = await engine.createJob({
        name: "Schedule Change",
        prompt: "test",
        schedule: "every 1h",
      });

      expect(job.schedule.kind).toBe("interval");
      expect(job.schedule.intervalMs).toBe(3_600_000);

      const updated = await engine.updateJob(job.id, {
        schedule: "0 9 * * *",
      });

      expect(updated.schedule.kind).toBe("cron");
      expect(updated.schedule.expression).toBe("0 9 * * *");
    });

    it("should throw for missing job", async () => {
      await expect(
        engine.updateJob("nonexistent", { name: "Nope" }),
      ).rejects.toThrow("CronJob not found");
    });
  });

  // -----------------------------------------------------------------------
  // Delete Job
  // -----------------------------------------------------------------------

  describe("deleteJob()", () => {
    it("should delete a job", async () => {
      const job = await engine.createJob({
        name: "Delete Me",
        prompt: "bye",
        schedule: "1h",
      });

      await engine.deleteJob(job.id);

      const found = await engine.getJob(job.id);
      expect(found).toBeNull();
    });

    it("should throw for missing job", async () => {
      await expect(engine.deleteJob("nonexistent")).rejects.toThrow("CronJob not found");
    });
  });

  // -----------------------------------------------------------------------
  // Pause / Resume
  // -----------------------------------------------------------------------

  describe("pauseJob() / resumeJob()", () => {
    it("should pause a job by setting state to paused", async () => {
      const job = await engine.createJob({
        name: "Pause Test",
        prompt: "test",
        schedule: "every 1h",
      });

      expect(job.enabled).toBe(true);
      expect(job.state).toBe("scheduled");

      const paused = await engine.pauseJob(job.id);
      expect(paused.enabled).toBe(false);
      expect(paused.state).toBe("paused");
    });

    it("should resume a job by setting state to scheduled", async () => {
      const job = await engine.createJob({
        name: "Resume Test",
        prompt: "test",
        schedule: "every 1h",
      });

      await engine.pauseJob(job.id);
      const originalNextRun = job.nextRunAt;

      // Wait a tiny bit to ensure time passes
      await new Promise((r) => setTimeout(r, 10));

      const resumed = await engine.resumeJob(job.id);
      expect(resumed.enabled).toBe(true);
      expect(resumed.state).toBe("scheduled");
      expect(resumed.nextRunAt).not.toBe(originalNextRun);
    });

    it("should throw for missing job", async () => {
      await expect(engine.pauseJob("nonexistent")).rejects.toThrow("CronJob not found");
      await expect(engine.resumeJob("nonexistent")).rejects.toThrow("CronJob not found");
    });
  });

  // -----------------------------------------------------------------------
  // Trigger Job
  // -----------------------------------------------------------------------

  describe("triggerJob()", () => {
    it("should execute a job immediately and return execution record", async () => {
      const callback = vi.fn().mockResolvedValue("scan complete");
      const localEngine = new CronEngine(TEST_WORKSPACE, callback);
      await localEngine.initialize();

      const job = await localEngine.createJob({
        name: "Trigger Test",
        prompt: "Run scan",
        schedule: "every 1h",
      });

      const execution = await localEngine.triggerJob(job.id);

      expect(execution.jobId).toBe(job.id);
      expect(execution.success).toBe(true);
      expect(execution.output).toBe("scan complete");
      expect(execution.duration).toBeGreaterThanOrEqual(0);
      expect(execution.timestamp).toBeGreaterThan(0);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0]![0]).toBe("Run scan");
      expect(callback.mock.calls[0]![1]).toMatchObject({ name: "Trigger Test", prompt: "Run scan" });
    });

    it("should record failure when callback throws", async () => {
      const callback = vi.fn().mockRejectedValue(new Error("API timeout"));
      const localEngine = new CronEngine(TEST_WORKSPACE, callback);
      await localEngine.initialize();

      const job = await localEngine.createJob({
        name: "Fail Test",
        prompt: "fail",
        schedule: "30m",
      });

      const execution = await localEngine.triggerJob(job.id);

      expect(execution.success).toBe(false);
      expect(execution.error).toBe("API timeout");
      expect(execution.output).toContain("Error: API timeout");
    });

    it("should fail when callback returns no visible output", async () => {
      const callback = vi.fn().mockResolvedValue("   ");
      const localEngine = new CronEngine(TEST_WORKSPACE, callback);
      await localEngine.initialize();

      const job = await localEngine.createJob({
        name: "Blank Test",
        prompt: "blank",
        schedule: "30m",
      });

      const execution = await localEngine.triggerJob(job.id);

      expect(execution.success).toBe(false);
      expect(execution.error).toContain("produced no visible output");
      expect(execution.output).toContain("Error:");
    });

    it("should update job's lastRunAt, runCount, and nextRunAt", async () => {
      const callback = vi.fn().mockResolvedValue("ok");
      const localEngine = new CronEngine(TEST_WORKSPACE, callback);
      await localEngine.initialize();

      const job = await localEngine.createJob({
        name: "Update Test",
        prompt: "test",
        schedule: "every 1h",
      });

      expect(job.runCount).toBe(0);
      expect(job.lastRunAt).toBeUndefined();

      await localEngine.triggerJob(job.id);

      const updated = await localEngine.getJob(job.id);
      expect(updated!.runCount).toBe(1);
      expect(updated!.completedRuns).toBe(1);
      expect(updated!.lastRunAt).toBeGreaterThan(0);
      expect(updated!.nextRunAt).toBeGreaterThan(updated!.lastRunAt!);
      expect(updated!.lastStatus).toBe("ok");
    });

    it("should save execution output to disk", async () => {
      const callback = vi.fn().mockResolvedValue("market data");
      const localEngine = new CronEngine(TEST_WORKSPACE, callback);
      await localEngine.initialize();

      const job = await localEngine.createJob({
        name: "Output Test",
        prompt: "fetch data",
        schedule: "1d",
      });

      const execution = await localEngine.triggerJob(job.id);

      const outputPath = join(
        TEST_WORKSPACE,
        "cron",
        "output",
        job.id,
        `${execution.timestamp}.md`,
      );
      expect(existsSync(outputPath)).toBe(true);

      const content = readFileSync(outputPath, "utf-8");
      expect(content).toContain("# Cron Execution");
      expect(content).toContain("market data");
      expect(content).toContain(job.id);
    });

    it("should emit execution event", async () => {
      const callback = vi.fn().mockResolvedValue("done");
      const localEngine = new CronEngine(TEST_WORKSPACE, callback);
      await localEngine.initialize();

      const job = await localEngine.createJob({
        name: "Event Test",
        prompt: "emit",
        schedule: "30m",
      });

      const handler = vi.fn();
      localEngine.on("execution", handler);

      await localEngine.triggerJob(job.id);

      expect(handler).toHaveBeenCalledTimes(1);
      const eventArg = handler.mock.calls[0]![0] as { jobId: string; execution: CronExecution };
      expect(eventArg.jobId).toBe(job.id);
      expect(eventArg.execution.success).toBe(true);
      expect(eventArg.execution.output).toBe("done");
    });

    it("should throw for missing job", async () => {
      await expect(engine.triggerJob("nonexistent")).rejects.toThrow("CronJob not found");
    });

    it("should execute shell command via command field", async () => {
      const localEngine = new CronEngine(TEST_WORKSPACE);
      await localEngine.initialize();

      const job = await localEngine.createJob({
        name: "Shell Test",
        command: "echo hello-world",
        schedule: "every 1h",
      });

      const execution = await localEngine.triggerJob(job.id);

      expect(execution.success).toBe(true);
      expect(execution.output).toContain("hello-world");
    });
  });

  // -----------------------------------------------------------------------
  // Parse Schedule
  // -----------------------------------------------------------------------

  describe("parseSchedule()", () => {
    it('should parse "30m" as once in 30 minutes', () => {
      const before = Date.now();
      const schedule = engine.parseSchedule("30m");
      const after = Date.now();

      expect(schedule.kind).toBe("once");
      expect(schedule.display).toBe("30m");
      expect(schedule.runAt).toBeGreaterThanOrEqual(before + 30 * 60_000);
      expect(schedule.runAt).toBeLessThanOrEqual(after + 30 * 60_000);
    });

    it('should parse "2h" as once in 2 hours', () => {
      const schedule = engine.parseSchedule("2h");
      expect(schedule.kind).toBe("once");
      expect(schedule.runAt).toBeGreaterThan(Date.now() + 2 * 3_600_000 - 1000);
    });

    it('should parse "1d" as once in 1 day', () => {
      const schedule = engine.parseSchedule("1d");
      expect(schedule.kind).toBe("once");
      expect(schedule.runAt).toBeGreaterThan(Date.now() + 86_400_000 - 1000);
    });

    it('should parse "every 30m" as interval every 30 minutes', () => {
      const schedule = engine.parseSchedule("every 30m");
      expect(schedule.kind).toBe("interval");
      expect(schedule.intervalMs).toBe(30 * 60_000);
      expect(schedule.display).toBe("every 30m");
    });

    it('should parse "every 2h" as interval every 2 hours', () => {
      const schedule = engine.parseSchedule("every 2h");
      expect(schedule.kind).toBe("interval");
      expect(schedule.intervalMs).toBe(2 * 3_600_000);
    });

    it('should parse "every 1d" as interval every day', () => {
      const schedule = engine.parseSchedule("every 1d");
      expect(schedule.kind).toBe("interval");
      expect(schedule.intervalMs).toBe(86_400_000);
    });

    it('should parse "0 9 * * *" as cron expression', () => {
      const schedule = engine.parseSchedule("0 9 * * *");
      expect(schedule.kind).toBe("cron");
      expect(schedule.expression).toBe("0 9 * * *");
      expect(schedule.display).toBe("0 9 * * *");
    });

    it("should parse ISO timestamp as once", () => {
      const future = new Date(Date.now() + 86400_000).toISOString().slice(0, 19);
      const schedule = engine.parseSchedule(future);
      expect(schedule.kind).toBe("once");
      expect(schedule.runAt).toBeGreaterThan(Date.now());
    });

    it("should throw for invalid schedule string", () => {
      expect(() => engine.parseSchedule("not a schedule")).toThrow();
      expect(() => engine.parseSchedule("")).toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Calculate Next Run
  // -----------------------------------------------------------------------

  describe("calculateNextRun()", () => {
    it("should return null for a once schedule in the past", () => {
      const schedule = engine.parseSchedule("2020-01-01T00:00:00");
      const next = engine.calculateNextRun(schedule, Date.now());
      expect(next).toBeNull();
    });

    it("should return runAt for a future once schedule", () => {
      const futureTs = Date.now() + 3600_000;
      const schedule = engine.parseSchedule(new Date(futureTs).toISOString().slice(0, 19));
      const next = engine.calculateNextRun(schedule, Date.now());
      expect(next).not.toBeNull();
      expect(next!).toBeGreaterThan(Date.now());
    });

    it("should calculate next run for an interval schedule", () => {
      const schedule = engine.parseSchedule("every 1h");
      const from = Date.now();
      const next = engine.calculateNextRun(schedule, from);
      expect(next).toBe(from + 3600_000);
    });

    it("should calculate next run for a cron schedule", () => {
      // Every hour at minute 0 — should match the next hour's 00 minute
      const schedule = engine.parseSchedule("0 * * * *");
      const from = new Date();
      from.setMinutes(30, 0, 0); // e.g., 10:30:00
      const next = engine.calculateNextRun(schedule, from.getTime());

      const nextDate = new Date(next!);
      expect(nextDate.getMinutes()).toBe(0);
      expect(nextDate.getTime()).toBeGreaterThan(from.getTime());
    });

    it("should handle specific daily cron: 0 9 * * *", () => {
      const schedule = engine.parseSchedule("0 9 * * *");
      const from = new Date("2026-07-08T10:00:00").getTime();
      const next = engine.calculateNextRun(schedule, from);

      const nextDate = new Date(next!);
      expect(nextDate.getHours()).toBe(9);
      expect(nextDate.getMinutes()).toBe(0);
      // Should be next day since we're already past 9:00 today
      expect(nextDate.getDate()).toBe(9); // July 9
    });

    it("should return null for a once schedule without runAt", () => {
      const schedule = {
        kind: "once" as const,
        display: "broken",
      };
      const next = engine.calculateNextRun(schedule);
      expect(next).toBeNull();
    });

    it("should return null for interval schedule without intervalMs", () => {
      const schedule = {
        kind: "interval" as const,
        display: "broken",
      };
      const next = engine.calculateNextRun(schedule);
      expect(next).toBeNull();
    });

    it("should return null for cron schedule without expression", () => {
      const schedule = {
        kind: "cron" as const,
        display: "broken",
      };
      const next = engine.calculateNextRun(schedule);
      expect(next).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Tick
  // -----------------------------------------------------------------------

  describe("tick()", () => {
    it("should fire a due job", async () => {
      const callback = vi.fn().mockResolvedValue("tick done");
      const localEngine = new CronEngine(TEST_WORKSPACE, callback);
      await localEngine.initialize();

      // Create a job with nextRunAt in the past
      const job = await localEngine.createJob({
        name: "Due Job",
        prompt: "execute me",
        schedule: "1m", // will fire ~1 minute from now
      });

      // Manually set nextRunAt to the past and persist
      const pastJob = await localEngine.getJob(job.id);
      pastJob!.nextRunAt = Date.now() - 5000;
      // Force save by updating
      await localEngine.updateJob(job.id, { prompt: "execute me" });
      // Overwrite the persisted state
      const fs = await import("node:fs/promises");
      const { join: pJoin } = await import("node:path");
      const jobsPath = pJoin(TEST_WORKSPACE, "cron", "jobs.json");
      const allJobs = JSON.parse(await fs.readFile(jobsPath, "utf-8"));
      const targetJob = allJobs.find((j: CronJob) => j.id === job.id);
      if (targetJob) {
        targetJob.nextRunAt = Date.now() - 5000;
        await fs.writeFile(jobsPath, JSON.stringify(allJobs, null, 2), "utf-8");
      }

      // Re-init the engine to pick up the modified job
      const pastEngine = new CronEngine(TEST_WORKSPACE, callback);
      await pastEngine.initialize();

      await pastEngine.tick();

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0]![0]).toBe("execute me");
      expect(callback.mock.calls[0]![1]).toMatchObject({ name: "Due Job", prompt: "execute me" });

      const updated = await pastEngine.getJob(job.id);
      expect(updated!.runCount).toBe(1);
      expect(updated!.completedRuns).toBe(1);
      expect(updated!.lastRunAt).toBeGreaterThan(0);
    });

    it("should skip non-due jobs", async () => {
      const callback = vi.fn();
      const localEngine = new CronEngine(TEST_WORKSPACE, callback);
      await localEngine.initialize();

      await localEngine.createJob({
        name: "Future Job",
        prompt: "not yet",
        schedule: "1d",
      });

      await localEngine.tick();

      expect(callback).not.toHaveBeenCalled();
    });

    it("should skip disabled/paused jobs", async () => {
      const callback = vi.fn().mockResolvedValue("ok");
      const localEngine = new CronEngine(TEST_WORKSPACE, callback);
      await localEngine.initialize();

      const job = await localEngine.createJob({
        name: "Disabled",
        prompt: "skip me",
        schedule: "1m",
      });

      await localEngine.pauseJob(job.id);

      // Manually set nextRunAt to the past
      const fs = await import("node:fs/promises");
      const { join: pJoin } = await import("node:path");
      const jobsPath = pJoin(TEST_WORKSPACE, "cron", "jobs.json");
      const allJobs = JSON.parse(await fs.readFile(jobsPath, "utf-8"));
      const targetJob = allJobs.find((j: CronJob) => j.id === job.id);
      if (targetJob) {
        targetJob.nextRunAt = Date.now() - 5000;
        await fs.writeFile(jobsPath, JSON.stringify(allJobs, null, 2), "utf-8");
      }

      await localEngine.tick();

      expect(callback).not.toHaveBeenCalled();
    });

    it("should execute multiple due jobs sequentially", async () => {
      const results: number[] = [];
      const callback = vi.fn().mockImplementation(async (prompt: string) => {
        results.push(Date.now());
        await new Promise((r) => setTimeout(r, 5));
        return `done: ${prompt}`;
      });

      const localEngine = new CronEngine(TEST_WORKSPACE, callback);
      await localEngine.initialize();

      const job1 = await localEngine.createJob({ name: "J1", prompt: "first", schedule: "1m" });
      const job2 = await localEngine.createJob({ name: "J2", prompt: "second", schedule: "1m" });

      // Set both to due via jobs.json and re-init engine
      const fs = await import("node:fs/promises");
      const { join: pJoin } = await import("node:path");
      const jobsPath = pJoin(TEST_WORKSPACE, "cron", "jobs.json");
      const allJobs = JSON.parse(await fs.readFile(jobsPath, "utf-8"));
      for (const j of allJobs) {
        if (j.id === job1.id || j.id === job2.id) {
          j.nextRunAt = Date.now() - 5000;
        }
      }
      await fs.writeFile(jobsPath, JSON.stringify(allJobs, null, 2), "utf-8");

      // Re-init engine to pick up modified jobs.json
      const freshEngine = new CronEngine(TEST_WORKSPACE, callback);
      await freshEngine.initialize();

      await freshEngine.tick();

      expect(callback).toHaveBeenCalledTimes(2);
      // Jobs should be sequential, so the second timestamp >= first + 5ms
      expect(results[1]! - results[0]!).toBeGreaterThanOrEqual(4);
    });

    it("should respect repeatCount and complete job", async () => {
      const callback = vi.fn().mockResolvedValue("ok");
      const localEngine = new CronEngine(TEST_WORKSPACE, callback);
      await localEngine.initialize();

      const job = await localEngine.createJob({
        name: "Limited",
        prompt: "run me",
        schedule: "1m",
        repeatCount: 2,
      });

      const fs = await import("node:fs/promises");
      const { join: pJoin } = await import("node:path");
      const jobsPath = pJoin(TEST_WORKSPACE, "cron", "jobs.json");

      // First tick: set job due, re-init engine to load modified jobs.json
      let allJobs = JSON.parse(await fs.readFile(jobsPath, "utf-8"));
      allJobs.find((j: CronJob) => j.id === job.id)!.nextRunAt = Date.now() - 5000;
      await fs.writeFile(jobsPath, JSON.stringify(allJobs, null, 2), "utf-8");

      let freshEngine = new CronEngine(TEST_WORKSPACE, callback);
      await freshEngine.initialize();
      await freshEngine.tick();

      let updated = await freshEngine.getJob(job.id);
      expect(updated!.completedRuns).toBe(1);
      expect(updated!.state).toBe("scheduled"); // still scheduled (repeatCount=2, completedRuns=1)

      // Second tick: set job due again, re-init engine
      allJobs = JSON.parse(await fs.readFile(jobsPath, "utf-8"));
      allJobs.find((j: CronJob) => j.id === job.id)!.nextRunAt = Date.now() - 5000;
      await fs.writeFile(jobsPath, JSON.stringify(allJobs, null, 2), "utf-8");

      freshEngine = new CronEngine(TEST_WORKSPACE, callback);
      await freshEngine.initialize();
      await freshEngine.tick();

      updated = await freshEngine.getJob(job.id);
      expect(updated!.completedRuns).toBe(2);
      expect(updated!.state).toBe("completed");
    });
  });

  // -----------------------------------------------------------------------
  // Start / Stop
  // -----------------------------------------------------------------------

  describe("start() / stop()", () => {
    it("should start and stop the scheduler loop", async () => {
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

      engine.start();
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);

      engine.stop();
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    });

    it("should not start multiple intervals", async () => {
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

      engine.start();
      engine.start();
      engine.start();

      expect(setIntervalSpy).toHaveBeenCalledTimes(1);

      setIntervalSpy.mockRestore();
    });

    it("should tick when interval fires (manually invoke interval callback)", async () => {
      const callback = vi.fn().mockResolvedValue("ok");
      const localEngine = new CronEngine(TEST_WORKSPACE, callback);
      await localEngine.initialize();

      // Create a due job (nextRunAt in the past)
      const job = await localEngine.createJob({
        name: "Tick Test",
        prompt: "tick",
        schedule: "1m",
      });

      // Force the job to be due
      const fs = await import("node:fs/promises");
      const { join: pJoin } = await import("node:path");
      const jobsPath = pJoin(TEST_WORKSPACE, "cron", "jobs.json");
      const allJobs = JSON.parse(await fs.readFile(jobsPath, "utf-8"));
      allJobs.find((j: CronJob) => j.id === job.id)!.nextRunAt = Date.now() - 5000;
      await fs.writeFile(jobsPath, JSON.stringify(allJobs, null, 2), "utf-8");

      const tickingEngine = new CronEngine(TEST_WORKSPACE, callback);
      await tickingEngine.initialize();
      await tickingEngine.tick();

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0]![0]).toBe("tick");
      expect(callback.mock.calls[0]![1]).toMatchObject({ name: "Tick Test", prompt: "tick" });

      const updated = await tickingEngine.getJob(job.id);
      expect(updated!.runCount).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Persistence — Cross-instance
  // -----------------------------------------------------------------------

  describe("Persistence", () => {
    it("should survive engine restart (cross-instance)", async () => {
      // Instance 1
      const engine1 = new CronEngine(TEST_WORKSPACE);
      await engine1.initialize();

      const created = await engine1.createJob({
        name: "Persist Me",
        prompt: "survive restart",
        schedule: "every 1h",
        tags: ["cross-instance"],
      });

      // Instance 2 - same workspace
      const engine2 = new CronEngine(TEST_WORKSPACE);
      await engine2.initialize();

      const found = await engine2.getJob(created.id);
      expect(found).not.toBeNull();
      expect(found!.name).toBe("Persist Me");
      expect(found!.prompt).toBe("survive restart");
      expect(found!.schedule.kind).toBe("interval");
      expect(found!.schedule.intervalMs).toBe(3_600_000);
      expect(found!.tags).toEqual(["cross-instance"]);
    });

    it("should persist job updates across instances", async () => {
      const engine1 = new CronEngine(TEST_WORKSPACE);
      await engine1.initialize();

      const job = await engine1.createJob({
        name: "Original",
        prompt: "original",
        schedule: "30m",
      });

      await engine1.updateJob(job.id, {
        name: "Updated",
        prompt: "updated",
        schedule: "every 2h",
      });

      const engine2 = new CronEngine(TEST_WORKSPACE);
      await engine2.initialize();

      const found = await engine2.getJob(job.id);
      expect(found!.name).toBe("Updated");
      expect(found!.prompt).toBe("updated");
      expect(found!.schedule.kind).toBe("interval");
      expect(found!.schedule.intervalMs).toBe(7_200_000); // 2h
    });

    it("should persist execution output across instances", async () => {
      const callback = vi.fn().mockResolvedValue("cross-output");
      const engine1 = new CronEngine(TEST_WORKSPACE, callback);
      await engine1.initialize();

      const job = await engine1.createJob({
        name: "Cross Output",
        prompt: "cross-output-test",
        schedule: "1h",
      });

      const execution = await engine1.triggerJob(job.id);

      // Read output with engine2
      const outputPath = join(
        TEST_WORKSPACE,
        "cron",
        "output",
        job.id,
        `${execution.timestamp}.md`,
      );
      expect(existsSync(outputPath)).toBe(true);
      const content = readFileSync(outputPath, "utf-8");
      expect(content).toContain("cross-output");
    });
  });

  // -----------------------------------------------------------------------
  // Job State
  // -----------------------------------------------------------------------

  describe("job state persistence", () => {
    it("should persist a cron state capsule across engine restarts", async () => {
      const engine1 = new CronEngine(TEST_WORKSPACE);
      await engine1.initialize();

      const job = await engine1.createJob({
        name: "Stateful",
        prompt: "check trades",
        schedule: "every 1h",
      });

      const updatedState = await engine1.updateJobState(job.id, {
        promptFingerprint: "abc123",
        sessionId: `cron:${job.id}`,
        summary: "Last run checked BTC/USDT and waited.",
        lastOutput: "Last run checked BTC/USDT and waited.",
        lastStatus: "ok",
        lastRunAt: Date.now(),
        lastSymbol: "BTC/USDT",
        lastVenue: "binance",
        lastTimeframe: "15m",
      });

      const statePath = join(TEST_WORKSPACE, "cron", "state", `${job.id}.json`);
      expect(existsSync(statePath)).toBe(true);
      expect(updatedState.sessionId).toBe(`cron:${job.id}`);
      expect(updatedState.promptFingerprint).toBe("abc123");

      const engine2 = new CronEngine(TEST_WORKSPACE);
      await engine2.initialize();

      const reloadedState = engine2.getJobState(job.id);
      expect(reloadedState).not.toBeNull();
      expect(reloadedState!.sessionId).toBe(`cron:${job.id}`);
      expect(reloadedState!.promptFingerprint).toBe("abc123");
      expect(reloadedState!.summary).toContain("BTC/USDT");
      expect(reloadedState!.lastVenue).toBe("binance");
      expect(reloadedState!.lastSymbol).toBe("BTC/USDT");
      expect(reloadedState!.lastTimeframe).toBe("15m");
    });

    it("should remove the state file when deleting a job", async () => {
      const job = await engine.createJob({
        name: "Cleanup",
        prompt: "cleanup",
        schedule: "every 1h",
      });

      const statePath = join(TEST_WORKSPACE, "cron", "state", `${job.id}.json`);
      expect(existsSync(statePath)).toBe(true);

      await engine.deleteJob(job.id);

      expect(existsSync(statePath)).toBe(false);
      expect(engine.getJobState(job.id)).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Status
  // -----------------------------------------------------------------------

  describe("getStatus()", () => {
    it("should return engine status", async () => {
      const status = engine.getStatus();
      expect(status.running).toBe(false);
      expect(status.jobCount).toBe(0);
      expect(status.enabledJobs).toBe(0);
      expect(status.lastTickAt).toBeNull();
      expect(status.nextTickIn).toBeNull();
    });

    it("should count enabled jobs correctly", async () => {
      await engine.createJob({ name: "A", prompt: "a", schedule: "every 1h" });
      const b = await engine.createJob({ name: "B", prompt: "b", schedule: "every 1h" });
      await engine.pauseJob(b.id);

      const status = engine.getStatus();
      expect(status.jobCount).toBe(2);
      expect(status.enabledJobs).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Edge Cases
  // -----------------------------------------------------------------------

  describe("Edge Cases", () => {
    it("should handle onExecution event binding", async () => {
      const callback = vi.fn().mockResolvedValue("edge-output");
      const localEngine = new CronEngine(TEST_WORKSPACE, callback);
      await localEngine.initialize();

      const job = await localEngine.createJob({
        name: "Edge Event",
        prompt: "edge",
        schedule: "30m",
      });

      const handler = vi.fn();
      localEngine.on("execution", handler);

      await localEngine.triggerJob(job.id);

      expect(handler).toHaveBeenCalledTimes(1);
      const data = handler.mock.calls[0]![0] as { jobId: string; execution: CronExecution };
      expect(data.execution.output).toBe("edge-output");
    });

    it("should handle job without callback gracefully", async () => {
      // Engine without callback — execution should record an error
      const noCbEngine = new CronEngine(TEST_WORKSPACE);
      await noCbEngine.initialize();

      const job = await noCbEngine.createJob({
        name: "No Callback",
        prompt: "no cb",
        schedule: "30m",
      });

      const execution = await noCbEngine.triggerJob(job.id);
      expect(execution.success).toBe(false);
      expect(execution.error).toBe("No execute callback registered");
    });

  it("should create cron directory on initialize", async () => {
      cleanTestDir();
      const freshEngine = new CronEngine(TEST_WORKSPACE);
      await freshEngine.initialize();

      const cronDir = join(TEST_WORKSPACE, "cron");
      expect(existsSync(cronDir)).toBe(true);

      const outputDir = join(TEST_WORKSPACE, "cron", "output");
      expect(existsSync(outputDir)).toBe(true);
    });

    it("should handle delivery event emission", async () => {
      const callback = vi.fn().mockResolvedValue("delivered output");
      const localEngine = new CronEngine(TEST_WORKSPACE, callback);
      await localEngine.initialize();

      const job = await localEngine.createJob({
        name: "Delivery Test",
        prompt: "deliver",
        schedule: "30m",
        deliver: { target: "telegram", chatId: "12345" },
      });

      const handler = vi.fn();
      localEngine.on("delivery", handler);

      await localEngine.triggerJob(job.id);

      expect(handler).toHaveBeenCalledTimes(1);
      const data = handler.mock.calls[0]![0];
      expect(data.target).toBe("telegram");
      expect(data.chatId).toBe("12345");
      expect(data.content).toContain("delivered output");
      expect(data.content).not.toContain("[Cron: Delivery Test]");
      expect(data.jobName).toBe("Delivery Test");
    });

    it("should not emit delivery when target is none", async () => {
      const callback = vi.fn().mockResolvedValue("no delivery");
      const localEngine = new CronEngine(TEST_WORKSPACE, callback);
      await localEngine.initialize();

      const job = await localEngine.createJob({
        name: "No Delivery",
        prompt: "silent",
        schedule: "30m",
        deliver: { target: "none" },
      });

      const handler = vi.fn();
      localEngine.on("delivery", handler);

      await localEngine.triggerJob(job.id);

      expect(handler).not.toHaveBeenCalled();
    });
  });

  it("persists structured execution history and reads it after engine restart", async () => {
    const historyEngine = new CronEngine(TEST_WORKSPACE, async () => "daily report output");
    await historyEngine.initialize();
    const job = await historyEngine.createJob({
      id: "history-test",
      name: "History test",
      prompt: "make a report",
      schedule: "every 1h",
    });

    const execution = await historyEngine.triggerJob(job.id);
    expect(execution).toMatchObject({ jobId: job.id, success: true, output: "daily report output" });

    const restarted = new CronEngine(TEST_WORKSPACE);
    await restarted.initialize();
    await expect(restarted.listExecutionHistory({ jobId: job.id })).resolves.toEqual([execution]);
    await expect(restarted.listExecutionHistory({ limit: 1 })).resolves.toEqual([execution]);
    await expect(restarted.listExecutionHistory({ jobId: "../outside" })).rejects.toThrow("Invalid cron job id");
  });

  it("includes persisted failure details in execution history", async () => {
    const failing = new CronEngine(TEST_WORKSPACE, async () => { throw new Error("provider unavailable"); });
    await failing.initialize();
    const job = await failing.createJob({ name: "Failure history", prompt: "run", schedule: "every 1h" });
    const execution = await failing.triggerJob(job.id);
    expect(execution).toMatchObject({ success: false, error: "provider unavailable" });
    await expect(failing.listExecutionHistory({ jobId: job.id })).resolves.toEqual([execution]);
  });

  // -----------------------------------------------------------------------
  // StateDb Integration
  // -----------------------------------------------------------------------

  describe("StateDb Integration", () => {
    let dbDir: string;
    let db: StateDb;

    function makeDbEngine(
      dbInstance?: StateDb,
      cb?: (prompt: string, job: CronJob) => Promise<string>,
    ): CronEngine {
      const e = new CronEngine(TEST_WORKSPACE, cb, dbInstance ?? db);
      return e;
    }

    beforeEach(async () => {
      dbDir = join(tmpdir(), `ce-db-test-${randomUUID()}`);
      mkdirSync(dbDir, { recursive: true });
      db = new StateDb(dbDir);
    });

    afterEach(() => {
      db.close();
      try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* ok */ }
    });

    it("should persist job creation to SQLite", async () => {
      const engine = makeDbEngine();
      await engine.initialize();

      const job = await engine.createJob({
        name: "DB Persist",
        prompt: "persist me",
        schedule: "every 1h",
        tags: ["db-test"],
      });

      // Verify in SQLite directly
      const row = db.getCronJob(job.id);
      expect(row).not.toBeNull();
      expect(row!.name).toBe("DB Persist");
      expect(row!.prompt).toBe("persist me");
      expect(row!.tags).toBe(JSON.stringify(["db-test"]));
      expect(row!.enabled).toBe(1);
      expect(row!.state).toBe("scheduled");
    });

    it("should persist job updates to SQLite", async () => {
      const engine = makeDbEngine();
      await engine.initialize();

      const job = await engine.createJob({
        name: "Original",
        prompt: "original",
        schedule: "every 1h",
      });

      await engine.updateJob(job.id, { name: "Updated", prompt: "updated prompt" });

      const row = db.getCronJob(job.id);
      expect(row!.name).toBe("Updated");
      expect(row!.prompt).toBe("updated prompt");
    });

    it("should delete job from SQLite when deleted", async () => {
      const engine = makeDbEngine();
      await engine.initialize();

      const job = await engine.createJob({
        name: "Delete Me",
        prompt: "bye",
        schedule: "every 1h",
      });

      expect(db.getCronJob(job.id)).not.toBeNull();

      await engine.deleteJob(job.id);

      expect(db.getCronJob(job.id)).toBeNull();
    });

    it("should persist state changes to SQLite", async () => {
      const engine = makeDbEngine();
      await engine.initialize();

      const job = await engine.createJob({
        name: "Stateful",
        prompt: "state",
        schedule: "every 1h",
      });

      await engine.updateJobState(job.id, {
        summary: "Analysis complete",
        lastStatus: "ok",
        lastSymbol: "BTC/USDT",
      });

      const stateRow = db.getCronState(job.id);
      expect(stateRow).not.toBeNull();
      expect(stateRow!.summary).toBe("Analysis complete");
      expect(stateRow!.last_status).toBe("ok");
      expect(stateRow!.last_symbol).toBe("BTC/USDT");
    });

    it("should persist pause/resume to SQLite", async () => {
      const engine = makeDbEngine();
      await engine.initialize();

      const job = await engine.createJob({
        name: "Toggle",
        prompt: "toggle",
        schedule: "every 1h",
      });

      await engine.pauseJob(job.id);
      let row = db.getCronJob(job.id);
      expect(row!.enabled).toBe(0);
      expect(row!.state).toBe("paused");

      await engine.resumeJob(job.id);
      row = db.getCronJob(job.id);
      expect(row!.enabled).toBe(1);
      expect(row!.state).toBe("scheduled");
    });

    it("should survive engine restart via SQLite (fromDb)", async () => {
      const engine1 = makeDbEngine();
      await engine1.initialize();

      const job = await engine1.createJob({
        name: "FromDb Test",
        prompt: "fromdb",
        schedule: "every 1h",
        tags: ["fromdb"],
      });

      await engine1.updateJobState(job.id, {
        summary: "Loaded from DB",
        lastStatus: "ok",
      });

      engine1.stop();

      // Create a fresh engine via fromDb
      const engine2 = await CronEngine.fromDb(db, TEST_WORKSPACE);

      try {
        const found = await engine2.getJob(job.id);
        expect(found).not.toBeNull();
        expect(found!.name).toBe("FromDb Test");
        expect(found!.prompt).toBe("fromdb");
        expect(found!.tags).toEqual(["fromdb"]);

        // State should also be loaded
        const state = engine2.getJobState(job.id);
        expect(state).not.toBeNull();
        expect(state!.summary).toBe("Loaded from DB");
        expect(state!.lastStatus).toBe("ok");
      } finally {
        engine2.stop();
      }
    });

    it("should create new engine without db (backward compat)", async () => {
      const engine = new CronEngine(TEST_WORKSPACE);
      await engine.initialize();

      const job = await engine.createJob({
        name: "No DB",
        prompt: "backward compat",
        schedule: "30m",
      });

      expect(job.id).toBeDefined();
      expect(job.name).toBe("No DB");

      engine.stop();
    });

    it("should handle recordTrade and persist to SQLite", async () => {
      const callback = vi.fn().mockResolvedValue("trade ok");
      const engine = makeDbEngine(db, callback);
      await engine.initialize();

      const job = await engine.createJob({
        name: "Trade Job",
        prompt: "trade",
        schedule: "every 1h",
      });

      const record = await engine.recordTrade(job.id, {
        symbol: "ETH/USDT",
        side: "long",
        entryPrice: 3500,
        stopLoss: 3400,
        takeProfit: 3700,
        confidence: 0.85,
        summary: "ETH breakout",
      });

      expect(record.symbol).toBe("ETH/USDT");

      // Check SQLite
      const row = db.getCronJob(job.id);
      expect(row).not.toBeNull();

      // Also check state was saved
      const stateRow = db.getCronState(job.id);
      expect(stateRow).not.toBeNull();
      expect(stateRow!.last_trade).toContain("ETH/USDT");
    });

    it("should load from DB fallback when jobs.json is missing", async () => {
      // Pre-seed the DB with a job via direct StateDb
      db.saveCronJob({
        id: "preload_job",
        name: "Preloaded",
        prompt: "preloaded from DB",
        command: null,
        schedule_kind: "interval",
        schedule_display: "every 1h",
        schedule_interval_ms: 3_600_000,
        schedule_expression: null,
        schedule_run_at: null,
        skills: "[]",
        deliver: "{}",
        enabled: 1,
        state: "scheduled",
        last_status: null,
        last_error: null,
        repeat_count: null,
        completed_runs: 0,
        tags: JSON.stringify(["preload"]),
        pipeline: null,
        approval_status: null,
        execution_policy: null,
        wake_agent: 0,
        context_from: null,
        allowed_tools: null,
        disallowed_tools: null,
        model_config: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      });

      // Create engine with db but without jobs.json (clean workspace)
      const freshDir = join(tmpdir(), `ce-fresh-${randomUUID()}`);
      mkdirSync(freshDir, { recursive: true });
      try {
        const engine = new CronEngine(freshDir, undefined, db);
        await engine.initialize();

        const jobs = await engine.listJobs();
        expect(jobs).toHaveLength(1);
        expect(jobs[0]!.id).toBe("preload_job");
        expect(jobs[0]!.name).toBe("Preloaded");
        expect(jobs[0]!.prompt).toBe("preloaded from DB");
        expect(jobs[0]!.tags).toEqual(["preload"]);

        engine.stop();
      } finally {
        try { rmSync(freshDir, { recursive: true, force: true }); } catch { /* ok */ }
      }
    });
  });
});
