import { describe, it, expect, vi } from "vitest";
import { CronTool } from "./cron-tools";
import type { CronEngine } from "@dyna/agent-cron";

function makeCronEngineStub() {
  return {
    createJob: vi.fn(async (spec: Record<string, unknown>) => ({
      id: String(spec.id ?? "job-1"),
      enabled: Boolean(spec.enabled ?? true),
    })),
    pauseJob: vi.fn(async (id: string) => ({ id, enabled: false })),
    listJobs: vi.fn(async (_enabledOnly?: boolean) => []),
    getJob: vi.fn(async (id: string) => ({
      id,
      name: "job",
      enabled: true,
      pipeline: "execution" as const,
      schedule: { display: "every 15m", kind: "interval" as const },
      state: "scheduled" as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })),
    getJobState: vi.fn((id: string) => ({
      version: 1,
      jobId: id,
      sessionId: `cron:${id}`,
      summary: "previous run summary",
      lastOutput: "previous run summary",
      lastStatus: "ok" as const,
      updatedAt: Date.now(),
    })),
    updateJob: vi.fn(async (_id: string, updates: Record<string, unknown>) => ({ id: "job-1", name: "job", enabled: updates.enabled !== false, pipeline: updates.pipeline ?? "execution" })),
    resumeJob: vi.fn(async (id: string) => ({ id, enabled: true })),
  } as unknown as CronEngine;
}

describe("Cron tools", () => {
  it("allows command-only cron creation", async () => {
    const cron = makeCronEngineStub();
    const tool = new CronTool(cron);

    const result = await tool.execute({
      args: {
        action: "create",
        name: "command-loop",
        command: "echo hello",
        schedule: "every 15m",
      },
    } as any);

    expect(result.success).toBe(true);
  });

  it("rejects execution cron creation unless approved or close-only", async () => {
    const cron = makeCronEngineStub();
    const tool = new CronTool(cron);

    const result = await tool.execute({
      args: {
        action: "create",
        name: "trade-loop",
        prompt: "Trade the market",
        schedule: "every 15m",
        pipeline: "execution",
      },
    } as any);

    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/approvalStatus=.*approved|executionPolicy=.*close-only/);
  });

  it("rejects execution cron updates unless approved or close-only", async () => {
    const cron = makeCronEngineStub();
    const tool = new CronTool(cron);

    const result = await tool.execute({
      args: {
        action: "update",
        jobId: "job-1",
        pipeline: "execution",
      },
    } as any);

    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/approvalStatus=.*approved|executionPolicy=.*close-only/);
  });

  it("requires action parameter", async () => {
    const cron = makeCronEngineStub();
    const tool = new CronTool(cron);

    const result = await tool.execute({
      args: {},
    } as any);

    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/action is required/);
  });

  it("rejects unknown action", async () => {
    const cron = makeCronEngineStub();
    const tool = new CronTool(cron);

    const result = await tool.execute({
      args: { action: "unknown" },
    } as any);

    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/Unknown action/);
  });

  it("lists jobs via action=list", async () => {
    const cron = makeCronEngineStub();
    const tool = new CronTool(cron);

    const result = await tool.execute({
      args: { action: "list" },
    } as any);

    expect(result.success).toBe(true);
    expect((result.data as any).count).toBeDefined();
  });

  it("includes cron state in inspect output", async () => {
    const cron = makeCronEngineStub();
    const tool = new CronTool(cron);

    const result = await tool.execute({
      args: { action: "inspect", jobId: "job-1" },
    } as any);

    expect(result.success).toBe(true);
    expect((result.data as any).runtimeState).toMatchObject({
      sessionId: "cron:job-1",
      summary: "previous run summary",
      lastStatus: "ok",
    });
  });

  it("requires jobId for delete action", async () => {
    const cron = makeCronEngineStub();
    const tool = new CronTool(cron);

    const result = await tool.execute({
      args: { action: "delete" },
    } as any);

    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/jobId must be a non-empty string/);
  });

  it("requires jobId for pause action", async () => {
    const cron = makeCronEngineStub();
    const tool = new CronTool(cron);

    const result = await tool.execute({
      args: { action: "pause" },
    } as any);

    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/jobId must be a non-empty string/);
  });

  it("requires jobId for resume action", async () => {
    const cron = makeCronEngineStub();
    const tool = new CronTool(cron);

    const result = await tool.execute({
      args: { action: "resume" },
    } as any);

    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/jobId must be a non-empty string/);
  });
});

describe("post-trade self-scheduling", () => {
  it("creates a one-shot follow-up job with 'in 2h' schedule", async () => {
    const cron = makeCronEngineStub();
    const tool = new CronTool(cron);

    // Simulate: agent placed a trade, now schedules its own wake-up.
    const res = await tool.execute({
      tool: "cron",
      args: {
        action: "create",
        name: "check-btc-position",
        prompt: "Check BTC position; tighten stop if up >3%",
        schedule: "in 2h",
      },
    });

    expect(res.success).toBe(true);
    const createCall = (cron.createJob as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(createCall).toBeDefined();
    expect(String(createCall.schedule)).toMatch(/^at \d{4}-\d{2}-\d{2}T/); // ISO one-shot
    expect(createCall.repeatCount).toBeNull(); // once
  });

  it("creates a forever scan job with 'every 15m'", async () => {
    const cron = makeCronEngineStub();
    const tool = new CronTool(cron);
    const res = await tool.execute({
      tool: "cron",
      args: {
        action: "create",
        name: "market-scan",
        prompt: "Scan the universe for setups",
        schedule: "every 15m",
      },
    });
    expect(res.success).toBe(true);
    const createCall = (cron.createJob as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(String(createCall.schedule)).toBe("every 15m");
    expect(createCall.repeatCount).toBeNull(); // forever
  });
});
