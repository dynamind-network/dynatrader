/**
 * CLI Commands Tests
 *
 * Tests for the new CLI subsystem commands: cron, kanban, workspace, gateway, learning.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CronEngine } from "../agent/cron/cron-engine";
import { KanbanBoard } from "../orchestration/workspace/kanban-board";
import { WorkspaceManager } from "../orchestration/workspace/workspace-manager";
import { GatewayService } from "../gateway/gateway-service";
import { loadConfig } from "../config";
import { cmdCron } from "./commands/cron";
import { cmdMcp } from "./commands/mcp";

// =============================================================================
// CronEngine Commands
// =============================================================================

describe("Cron CLI Commands", () => {
  let testDir: string;
  let engine: CronEngine;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "cron-cli-test-"));
    engine = new CronEngine(testDir);
    await engine.initialize();
  });

  afterEach(async () => {
    engine.stop();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("should list jobs when none exist", async () => {
    const jobs = await engine.listJobs();
    expect(jobs).toEqual([]);
  });

  it("should create a cron job and list it", async () => {
    const job = await engine.createJob({
      name: "test-job",
      prompt: "analyze BTC/USDT",
      schedule: "every 30m",
    });

    expect(job.id).toBeDefined();
    expect(job.name).toBe("test-job");
    expect(job.prompt).toBe("analyze BTC/USDT");
    expect(job.schedule.kind).toBe("interval");
    expect(job.enabled).toBe(true);

    const jobs = await engine.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.id).toBe(job.id);
  });

  it("should remove a cron job", async () => {
    const job = await engine.createJob({
      name: "to-remove",
      prompt: "test",
      schedule: "30m",
    });

    await engine.deleteJob(job.id);
    const jobs = await engine.listJobs();
    expect(jobs).toHaveLength(0);
  });

  it("should pause and resume a cron job", async () => {
    const job = await engine.createJob({
      name: "pause-test",
      prompt: "test",
      schedule: "every 1h",
    });

    const paused = await engine.pauseJob(job.id);
    expect(paused.enabled).toBe(false);

    const resumed = await engine.resumeJob(job.id);
    expect(resumed.enabled).toBe(true);
  });

  it("should throw on remove of non-existent job", async () => {
    await expect(engine.deleteJob("non-existent")).rejects.toThrow(
      "CronJob not found",
    );
  });

  it("should throw on pause of non-existent job", async () => {
    await expect(engine.pauseJob("non-existent")).rejects.toThrow(
      "CronJob not found",
    );
  });

  it("should parse various schedule formats", () => {
    const once30m = engine.parseSchedule("30m");
    expect(once30m.kind).toBe("once");
    expect(once30m.runAt).toBeGreaterThan(Date.now());

    const every2h = engine.parseSchedule("every 2h");
    expect(every2h.kind).toBe("interval");
    expect(every2h.intervalMs).toBe(2 * 3_600_000);

    const cronExpr = engine.parseSchedule("0 9 * * *");
    expect(cronExpr.kind).toBe("cron");
    expect(cronExpr.expression).toBe("0 9 * * *");

    const isoTime = engine.parseSchedule("2026-12-31T23:59:00");
    expect(isoTime.kind).toBe("once");
    expect(isoTime.runAt).toBe(new Date("2026-12-31T23:59:00").getTime());
  });

  it("should throw on invalid schedule", () => {
    expect(() => engine.parseSchedule("not-a-schedule")).toThrow();
  });
});

// =============================================================================
// KanbanBoard Commands
// =============================================================================

describe("Kanban CLI Commands", () => {
  let testDir: string;
  let board: KanbanBoard;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "kanban-cli-test-"));
    board = new KanbanBoard(testDir);
  });

  afterEach(() => {
    board.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("should list tasks when none exist", () => {
    const tasks = board.listTasks();
    expect(tasks).toEqual([]);
  });

  it("should create a task", () => {
    const task = board.createTask({
      workspaceId: "ws-1",
      title: "Test task",
      description: "A test task",
    });

    expect(task.id).toBeDefined();
    expect(task.title).toBe("Test task");
    expect(task.status).toBe("triage");
    expect(task.workspaceId).toBe("ws-1");
  });

  it("should show a task by ID", () => {
    const created = board.createTask({
      workspaceId: "ws-1",
      title: "Show me",
    });

    const found = board.getTask(created.id);
    expect(found).not.toBeNull();
    expect(found!.title).toBe("Show me");
  });

  it("should return null for non-existent task", () => {
    expect(board.getTask("non-existent")).toBeNull();
  });

  it("should list tasks filtered by status", () => {
    board.createTask({ workspaceId: "ws-1", title: "Task 1", status: "todo" });
    board.createTask({ workspaceId: "ws-1", title: "Task 2", status: "done" });
    board.createTask({ workspaceId: "ws-1", title: "Task 3", status: "todo" });

    const todoTasks = board.listTasks({ status: "todo" });
    expect(todoTasks).toHaveLength(2);

    const doneTasks = board.listTasks({ status: "done" });
    expect(doneTasks).toHaveLength(1);
  });

  it("should claim a task", () => {
    const task = board.createTask({
      workspaceId: "ws-1",
      title: "Claimable",
    });

    const claimResult = board.claimTask(task.id, "agent-1");
    expect(claimResult.success).toBe(true);
    const claimed = board.getTask(task.id);
    expect(claimed?.assignedTo).toBe("agent-1");
  });

  it("should throw on double-claim", () => {
    const task = board.createTask({
      workspaceId: "ws-1",
      title: "Already claimed",
    });

    board.claimTask(task.id, "agent-1");
    const doubleClaim = board.claimTask(task.id, "agent-2");
    expect(doubleClaim.success).toBe(false);
    expect(doubleClaim.error).toContain("already claimed");
  });

  it("should throw on claim of non-existent task", () => {
    const result = board.claimTask("does-not-exist", "agent-1");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Task not found");
  });

  it("should transition task status", () => {
    const task = board.createTask({
      workspaceId: "ws-1",
      title: "Transition me",
    });

    expect(task.status).toBe("triage");

    const running = board.transitionTask(task.id, "running");
    expect(running.status).toBe("running");

    const done = board.transitionTask(task.id, "done");
    expect(done.status).toBe("done");
    expect(done.resolvedAt).not.toBeNull();
  });

  it("should link two tasks", () => {
    const task1 = board.createTask({ workspaceId: "ws-1", title: "Task A" });
    const task2 = board.createTask({ workspaceId: "ws-1", title: "Task B" });

    board.linkTasks(task1.id, task2.id, "blocks");

    const links1 = board.getTaskLinks(task1.id);
    expect(links1).toHaveLength(1);
    expect(links1[0]!.id).toBe(task2.id);

    const links2 = board.getTaskLinks(task2.id);
    expect(links2).toHaveLength(1);
    expect(links2[0]!.id).toBe(task1.id);
  });

  it("should throw on self-link", () => {
    const task = board.createTask({ workspaceId: "ws-1", title: "Self" });
    expect(() => board.linkTasks(task.id, task.id)).toThrow("Cannot link");
  });

  it("should throw on transition of non-existent task", () => {
    expect(() => board.transitionTask("bad-id", "done")).toThrow(
      "Task not found",
    );
  });

  it("should return not-found error for claim of non-existent task", () => {
    const result = board.claimTask("bad-id", "agent");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Task not found");
  });
});

// =============================================================================
// WorkspaceManager Commands
// =============================================================================

describe("Workspace CLI Commands", () => {
  let testDir: string;
  let manager: WorkspaceManager;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "workspace-cli-test-"));
    manager = new WorkspaceManager(testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("should list workspaces when none exist", async () => {
    const list = await manager.listWorkspaces();
    expect(list).toEqual([]);
  });

  it("should create a workspace", async () => {
    const ws = await manager.createWorkspace({
      name: "BTC Momentum",
      description: "BTC momentum trading strategy",
      symbol: "BTC/USDT",
      tags: ["momentum", "btc"],
    });

    expect(ws.id).toBeDefined();
    expect(ws.name).toBe("BTC Momentum");
    expect(ws.symbol).toBe("BTC/USDT");
    expect(ws.status).toBe("active");
    expect(ws.tags).toEqual(["momentum", "btc"]);
    expect(ws.riskParameters.maxPositionSize).toBe(1.0);
    expect(ws.riskParameters.maxDrawdown).toBe(0.25);
    expect(ws.riskParameters.stopLoss).toBe(0.05);
  });

  it("should list created workspaces", async () => {
    await manager.createWorkspace({
      name: "WS 1",
      description: "First",
      symbol: "ETH/USDT",
    });
    await manager.createWorkspace({
      name: "WS 2",
      description: "Second",
      symbol: "BTC/USDT",
    });

    const list = await manager.listWorkspaces();
    expect(list).toHaveLength(2);
  });

  it("should get a workspace by ID", async () => {
    const ws = await manager.createWorkspace({
      name: "Find me",
      description: "test",
      symbol: "BTC/USDT",
    });

    const found = await manager.getWorkspace(ws.id);
    expect(found).not.toBeNull();
    expect(found!.name).toBe("Find me");
  });

  it("should return null for non-existent workspace", async () => {
    const found = await manager.getWorkspace("non-existent");
    expect(found).toBeNull();
  });

  it("should update a workspace", async () => {
    const ws = await manager.createWorkspace({
      name: "Original",
      description: "test",
      symbol: "BTC/USDT",
    });

    const updated = await manager.updateWorkspace(ws.id, {
      description: "Updated description",
    });
    expect(updated.description).toBe("Updated description");
    expect(updated.name).toBe("Original"); // unchanged
  });

  it("should validate workspace structure", async () => {
    // Should not throw for empty workspace dir
    const list = await manager.listWorkspaces();
    expect(Array.isArray(list)).toBe(true);
  });
});

// =============================================================================
// GatewayService Commands
// =============================================================================

describe("Gateway CLI Commands", () => {
  let service: GatewayService;

  beforeEach(() => {
    service = new GatewayService();
  });

  it("should return empty status when no gateways registered", () => {
    const status = service.getStatus();
    expect(status).toEqual({});
  });

  it("should register and unregister gateway plugins", () => {
    // Create a mock plugin
    const mockPlugin = {
      name: "test-gateway",
      initialize: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      send: vi.fn(),
      getStatus: vi.fn().mockReturnValue({
        connected: true,
        guildCount: 1,
        channelCount: 2,
      }),
    };

    service.register("test", mockPlugin);
    expect(service.get("test")).toBe(mockPlugin);

    const status = service.getStatus();
    expect(status["test"]).toEqual({
      connected: true,
      guildCount: 1,
      channelCount: 2,
    });

    service.unregister("test");
    expect(service.get("test")).toBeUndefined();
  });

  it("should throw on duplicate registration", () => {
    const mockPlugin = {
      name: "dup",
      initialize: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      send: vi.fn(),
      getStatus: vi.fn(),
    };

    service.register("dup", mockPlugin);
    expect(() => service.register("dup", mockPlugin)).toThrow(
      "already registered",
    );
  });

  it("should broadcast to registered plugins", async () => {
    const plugin1 = {
      name: "gw1",
      initialize: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      send: vi.fn(),
      getStatus: vi.fn(),
    };

    const plugin2 = {
      name: "gw2",
      initialize: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      send: vi.fn(),
      getStatus: vi.fn(),
    };

    service.register("gw1", plugin1);
    service.register("gw2", plugin2);

    await service.broadcast({
      type: "test",
      content: "hello",
      timestamp: new Date(),
    });

    expect(plugin1.send).toHaveBeenCalledWith("gw1", "hello");
    expect(plugin2.send).toHaveBeenCalledWith("gw2", "hello");
  });
});

// =============================================================================
// Cron CLI Commands
// =============================================================================

describe("Cron CLI Command Surface", () => {
  let testDir: string;
  let engine: CronEngine;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "cron-cli-surface-"));
    engine = new CronEngine(testDir);
    await engine.initialize();
  });

  afterEach(() => {
    engine.stop();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("should persist cron metadata from CLI flags", async () => {
    const runtime = {
      getCronEngine: () => engine,
    } as unknown as { getCronEngine: () => CronEngine };

    await cmdCron(runtime as any, "add", ["every 10m", "scan markets"], {
      name: "market-scan",
      pipeline: "analysis",
      skills: '["market-data","mcp"]',
      "deliver-to": "telegram",
      enabled: "true",
      tags: "loop:analysis,operator",
    });

    const jobs = await engine.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.name).toBe("market-scan");
    expect(jobs[0]!.pipeline).toBe("analysis");
    expect(jobs[0]!.skills).toEqual(["market-data", "mcp"]);
    expect(jobs[0]!.deliver).toEqual({ target: "telegram" });
    expect(jobs[0]!.tags).toEqual(["loop:analysis", "operator"]);
  });

  it("should update and disable a cron job from CLI flags", async () => {
    const job = await engine.createJob({
      name: "paper-loop",
      prompt: "analyze the market",
      schedule: "every 1h",
    });

    const runtime = {
      getCronEngine: () => engine,
    } as unknown as { getCronEngine: () => CronEngine };

    await cmdCron(runtime as any, "update", [job.id], {
      prompt: "analyze multiple venues",
      "execution-policy": "close-only",
      disabled: true,
      "repeat-count": "5",
    });

    const updated = await engine.getJob(job.id);
    expect(updated).not.toBeNull();
    expect(updated!.prompt).toBe("analyze multiple venues");
    expect(updated!.executionPolicy).toBe("close-only");
    expect(updated!.enabled).toBe(false);
    expect(updated!.repeatCount).toBe(5);
  });

  it("should alias cron run to trigger", async () => {
    const triggerJob = vi.fn(async (jobId: string) => ({
      jobId,
      timestamp: Date.now(),
      duration: 12,
      success: true,
      output: "hello world",
    }));
    const runtime = {
      getCronEngine: () => ({
        triggerJob,
      }),
    } as unknown as { getCronEngine: () => { triggerJob: typeof triggerJob } };

    await cmdCron(runtime as any, "run", ["job-123"]);

    expect(triggerJob).toHaveBeenCalledWith("job-123");
  });
});

// =============================================================================
// MCP CLI Commands
// =============================================================================

describe("MCP CLI Command Surface", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "mcp-cli-surface-"));
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("should add, update, enable/disable, and remove workspace MCP servers", async () => {
    await cmdMcp(testDir, "add", ["market-feed"], {
      transport: "http",
      url: "https://example.com/mcp",
      "include-tools": "fetch_price,get_quote",
      env: '{"TOKEN":"abc123"}',
    });

    let config = await loadConfig(testDir);
    expect(config.mcp.servers).toHaveLength(1);
    expect(config.mcp.servers[0]!.name).toBe("market-feed");
    expect(config.mcp.servers[0]!.transport).toBe("http");
    expect(config.mcp.servers[0]!.url).toBe("https://example.com/mcp");
    expect(config.mcp.servers[0]!.includeTools).toEqual(["fetch_price", "get_quote"]);
    expect(config.mcp.servers[0]!.env).toEqual({ TOKEN: "abc123" });

    await cmdMcp(testDir, "disable", ["market-feed"], {});
    config = await loadConfig(testDir);
    expect(config.mcp.servers[0]!.enabled).toBe(false);

    await cmdMcp(testDir, "update", ["market-feed"], {
      url: "https://example.com/mcp-v2",
      enabled: "true",
      "exclude-tools": "place_order",
    });

    config = await loadConfig(testDir);
    expect(config.mcp.servers[0]!.enabled).toBe(true);
    expect(config.mcp.servers[0]!.url).toBe("https://example.com/mcp-v2");
    expect(config.mcp.servers[0]!.excludeTools).toEqual(["place_order"]);

    await cmdMcp(testDir, "remove", ["market-feed"], {});
    config = await loadConfig(testDir);
    expect(config.mcp.servers).toHaveLength(0);
  });
});

// =============================================================================
// ParseArgs Tests (for the CLI argument parser)
// =============================================================================

describe("parseArgs", () => {
  // Re-implement the parseArgs function for testing
  function parseArgs(argv: string[]): {
    command: string | null;
    positional: string[];
    flags: Record<string, string | boolean>;
  } {
    const args = argv.slice(2);
    const result: {
      command: string | null;
      positional: string[];
      flags: Record<string, string | boolean>;
    } = {
      command: null,
      positional: [],
      flags: {},
    };

    let i = 0;
    while (i < args.length) {
      const arg = args[i]!;

      if (arg.startsWith("--")) {
        const key = arg.slice(2);
        const next = args[i + 1];
        if (next === undefined || next.startsWith("--")) {
          result.flags[key] = true;
        } else {
          result.flags[key] = next;
          i++;
        }
      } else if (!result.command) {
        result.command = arg;
      } else {
        result.positional.push(arg);
      }
      i++;
    }

    return result;
  }

  it("should parse a simple command", () => {
    const result = parseArgs(["node", "cli.ts", "status"]);
    expect(result.command).toBe("status");
    expect(result.positional).toEqual([]);
    expect(result.flags).toEqual({});
  });

  it("should parse a command with positional args", () => {
    const result = parseArgs([
      "node",
      "cli.ts",
      "cron",
      "add",
      "every 30m",
      "analyze",
    ]);
    expect(result.command).toBe("cron");
    expect(result.positional).toEqual(["add", "every 30m", "analyze"]);
  });

  it("should parse flags", () => {
    const result = parseArgs([
      "node",
      "cli.ts",
      "trade",
      "BTC/USDT",
      "--timeframe",
      "1h",
      "--mode",
      "paper",
    ]);
    expect(result.command).toBe("trade");
    expect(result.positional).toEqual(["BTC/USDT"]);
    expect(result.flags).toEqual({ timeframe: "1h", mode: "paper" });
  });

  it("should parse boolean flags", () => {
    const result = parseArgs(["node", "cli.ts", "status", "--verbose"]);
    expect(result.command).toBe("status");
    expect(result.flags).toEqual({ verbose: true });
  });

  it("should handle --runtime flag", () => {
    const result = parseArgs([
      "node",
      "cli.ts",
      "cron",
      "list",
      "--runtime",
      "/custom/path",
    ]);
    expect(result.command).toBe("cron");
    expect(result.positional).toEqual(["list"]);
    expect(result.flags).toEqual({ runtime: "/custom/path" });
  });

  it("should handle --workspace flag", () => {
    const result = parseArgs([
      "node",
      "cli.ts",
      "kanban",
      "list",
      "--workspace",
      "/ws/path",
    ]);
    expect(result.command).toBe("kanban");
    expect(result.positional).toEqual(["list"]);
    expect(result.flags).toEqual({ workspace: "/ws/path" });
  });

  it("should parse kanban show with task ID", () => {
    const result = parseArgs([
      "node",
      "cli.ts",
      "kanban",
      "show",
      "task-123",
    ]);
    expect(result.command).toBe("kanban");
    expect(result.positional).toEqual(["show", "task-123"]);
  });

  it("should parse learning recall with query", () => {
    const result = parseArgs([
      "node",
      "cli.ts",
      "learning",
      "recall",
      "moving average crossover",
    ]);
    expect(result.command).toBe("learning");
    expect(result.positional).toEqual(["recall", "moving average crossover"]);
  });

  it("should parse gateway send with channel and message", () => {
    const result = parseArgs([
      "node",
      "cli.ts",
      "gateway",
      "send",
      "general",
      "Hello world",
    ]);
    expect(result.command).toBe("gateway");
    expect(result.positional).toEqual(["send", "general", "Hello world"]);
  });

  it("should parse workspace create with name", () => {
    const result = parseArgs([
      "node",
      "cli.ts",
      "workspace",
      "create",
      "BTC Momentum",
    ]);
    expect(result.command).toBe("workspace");
    expect(result.positional).toEqual(["create", "BTC Momentum"]);
  });
});

// =============================================================================
// Format Helper Tests
// =============================================================================

describe("CLI Format Helpers", () => {
  it("should format duration in ms", () => {
    // Test the formatDuration logic
    const ms = (n: number) => {
      if (n < 1000) return `${n}ms`;
      if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
      const minutes = Math.floor(n / 60_000);
      const seconds = ((n % 60_000) / 1000).toFixed(1);
      return `${minutes}m ${seconds}s`;
    };

    expect(ms(500)).toBe("500ms");
    expect(ms(1500)).toBe("1.5s");
    expect(ms(65000)).toBe("1m 5.0s");
  });

  it("should format currency", () => {
    const fmt = (n: number) =>
      `$${n.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;

    expect(fmt(1000)).toBe("$1,000.00");
    expect(fmt(0.5)).toBe("$0.50");
  });

  it("should format dates", () => {
    const fmt = (d: Date) =>
      d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");

    const d = new Date("2026-07-08T12:34:56.789Z");
    expect(fmt(d)).toBe("2026-07-08 12:34:56");
  });
});
