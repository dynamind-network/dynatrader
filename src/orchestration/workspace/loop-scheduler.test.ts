import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CronEngine } from "@dyna/agent-cron";
import { LoopScheduler, buildLoopPrompt } from "./loop-scheduler";
import type { LoopManifest } from "./types";

describe("LoopScheduler", () => {
  let testDir: string;
  let cron: CronEngine;
  let scheduler: LoopScheduler;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "dynatrader-loop-sync-"));
    cron = new CronEngine(testDir);
    await cron.initialize();
    scheduler = new LoopScheduler();
  });

  afterEach(() => {
    cron.stop();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("pauses execution loops until they are explicitly approved", async () => {
    const loops: LoopManifest[] = [
      {
        id: "research-loop",
        name: "Research Loop",
        description: "Research market structure",
        schedule: "every 15m",
        prompt: "Gather observations and summarize them.",
        skills: [],
        tags: ["research"],
        enabled: true,
        pipeline: "research",
      },
      {
        id: "execution-loop",
        name: "Execution Loop",
        description: "Trade only when approved",
        schedule: "every 15m",
        prompt: "Manage execution risk and positions.",
        skills: [],
        tags: ["execution"],
        enabled: true,
        pipeline: "execution",
        approvalStatus: "pending",
      },
      {
        id: "close-only-loop",
        name: "Close Only Loop",
        description: "Reduce exposure without opening new risk",
        schedule: "every 15m",
        prompt: "Only close or reduce positions.",
        skills: [],
        tags: ["execution"],
        enabled: true,
        pipeline: "execution",
        executionPolicy: "close-only",
      },
    ];

    const result = await scheduler.sync(cron, loops);
    expect(result.created).toEqual(expect.arrayContaining(["research-loop", "close-only-loop"]));
    expect(result.paused).toContain("execution-loop");

    const jobs = await cron.listJobs();
    const research = jobs.find((job) => job.id === "research-loop");
    const execution = jobs.find((job) => job.id === "execution-loop");
    const closeOnly = jobs.find((job) => job.id === "close-only-loop");

    expect(research?.enabled).toBe(true);
    expect(research?.pipeline).toBe("research");
    expect(execution?.enabled).toBe(false);
    expect(execution?.state).toBe("paused");
    expect(closeOnly?.enabled).toBe(true);
    expect(closeOnly?.executionPolicy).toBe("close-only");
  });

  it("builds a prompt from loop metadata without injecting a fixed template", () => {
    const prompt = buildLoopPrompt({
      id: "loop-1",
      name: "My Loop",
      description: "Custom operator loop",
      schedule: "every 1h",
      prompt: "Use workspace instructions only.",
      skills: ["skill-a"],
      tags: ["tag-a"],
      enabled: true,
      pipeline: "analysis",
      approvalStatus: "approved",
      executionPolicy: "trade",
    });

    expect(prompt).toContain("You are executing a user-defined loop: My Loop");
    expect(prompt).not.toContain("Pipeline:");
    expect(prompt).not.toContain("Approval status:");
    expect(prompt).not.toContain("Execution policy:");
    expect(prompt).toContain("Use workspace instructions only.");
  });
});
