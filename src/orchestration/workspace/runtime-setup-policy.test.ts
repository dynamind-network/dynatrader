import { describe, it, expect, vi } from "vitest";
import type { RuntimeComponents } from "./runtime-setup";
import {
  buildCronToolPolicy,
  assertExplicitMarketContext,
  buildCloseOnlyOrderIntents,
  ensureTelegramCronPulseJob,
} from "./runtime-setup";

function makeComponents(toolNames: Array<{ name: string; permissionsRequired?: string[] }>): RuntimeComponents {
  const setToolPolicy = vi.fn();
  return {
    memoryStore: null,
    modelRouter: null,
    toolRegistry: {
      list: () =>
        toolNames.map((tool) => ({
          definition: {
            name: tool.name,
            description: tool.name,
            category: "session",
            inputSchema: {},
            outputSchema: {},
            permissionsRequired: tool.permissionsRequired ?? [],
            sideEffects: [],
            riskLevel: "low",
            timeoutMs: 1000,
          },
        })),
    } as any,
    pluginRuntime: null,

    agentCore: {
      setToolPolicy,
    } as any,
    loopSync: false,
    exchange: null,
    paperEngine: null,
    executionRouter: null,
    eventBus: null,
    auditTrail: null,
    pipeline: null,
    a2aRuntime: null,
    agentRegistry: null,
    subagentRuntime: null,
    cronEngine: {
      getJob: vi.fn(),
      createJob: vi.fn(),
      updateJob: vi.fn(),
    } as any,
    skillFactory: null,
    crossSessionRecall: null,
    skillLoader: null,
    dreamEngine: null,
    dreamScheduler: null,
    memoryBridge: null,
    compactionEngine: null,
    sessionManager: null,
    channelManager: null,
    walletManager: null,
    approvalManager: null,
    txPipeline: null,
    dexAdapters: null,
    runCardManager: null,
    mcpRuntime: null,
    toolResultCompressor: null,
    degraded: false,
  } as RuntimeComponents;
}

function makeJob(overrides: Record<string, unknown> = {}): any {
  return {
    id: "test-job",
    name: "Test Job",
    enabled: true,
    state: "scheduled",
    lastStatus: null,
    completedRuns: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    runCount: 0,
    tags: [],
    schedule: { kind: "interval", display: "every 10m", intervalMs: 600000 },
    ...overrides,
  };
}

describe("cron tool policy helpers", () => {
  it("buildCronToolPolicy returns all tools when no explicit scope is set", () => {
    const components = makeComponents([
      { name: "read_file" },
      { name: "cron" },
      { name: "inbox_deliver", permissionsRequired: ["inbox.write"] },
    ]);
    const logger = { info: vi.fn() } as any;
    const job = makeJob({ pipeline: "monitoring" });

    const policy = buildCronToolPolicy(components, job, logger);

    expect(policy.allowTools).toBe(true);
    expect(policy.allowed).toContain("read_file");
    expect(policy.allowed).toContain("cron");
    expect(policy.allowed).toContain("inbox_deliver");
    expect(policy.disallowed).toEqual([]);
  });

  it("buildCronToolPolicy ignores pipeline labels and keeps explicit scopes authoritative", () => {
    const components = makeComponents([
      { name: "read_file" },
      { name: "cron" },
      { name: "inbox_deliver", permissionsRequired: ["inbox.write"] },
      { name: "session_send", permissionsRequired: ["session.send"] },
    ]);
    const logger = { info: vi.fn() } as any;
    const job = makeJob({ pipeline: "execution" });

    const policy = buildCronToolPolicy(components, job, logger);

    expect(policy.allowTools).toBe(true);
    expect(policy.allowed).toContain("read_file");
    expect(policy.allowed).toContain("cron");
    expect(policy.allowed).toContain("inbox_deliver");
    expect(policy.allowed).toContain("session_send");
  });

  it("buildCronToolPolicy applies per-job allowedTools override", () => {
    const components = makeComponents([
      { name: "read_file" },
      { name: "glob" },
      { name: "cron" },
    ]);
    const logger = { info: vi.fn() } as any;
    const job = makeJob({ allowedTools: ["read_file", "cron"] });

    const policy = buildCronToolPolicy(components, job, logger);

    expect(policy.allowed).toEqual(["read_file", "cron"]);
  });

  it("buildCronToolPolicy applies per-job disallowedTools override", () => {
    const components = makeComponents([
      { name: "read_file" },
      { name: "glob" },
      { name: "cron" },
    ]);
    const logger = { info: vi.fn() } as any;
    const job = makeJob({ disallowedTools: ["glob"] });

    const policy = buildCronToolPolicy(components, job, logger);

    expect(policy.allowed).toContain("read_file");
    expect(policy.allowed).toContain("cron");
    expect(policy.disallowed).toContain("glob");
  });

  it("buildCronToolPolicy filters invalid tool names from allowedTools", () => {
    const components = makeComponents([
      { name: "read_file" },
      { name: "cron" },
    ]);
    const logger = { info: vi.fn() } as any;
    const job = makeJob({ allowedTools: ["read_file", "nonexistent_tool"] });

    const policy = buildCronToolPolicy(components, job, logger);

    expect(policy.allowed).toEqual(["read_file"]);
  });

  it("syncs the dedicated cron pulse delivery for Telegram", async () => {
    const components = makeComponents([{ name: "read_file" }]);
    const logger = { info: vi.fn() } as any;
    const cronEngine = components.cronEngine as any;
    cronEngine.getJob.mockResolvedValue({
      id: "telegram-cron-pulse",
      name: "Telegram Cron Pulse",
      prompt: "jobs.json prompt",
      schedule: { display: "every 5m" },
      deliver: { target: "none" },
      enabled: false,
    });

    await ensureTelegramCronPulseJob(components, "123456", logger);

    expect(cronEngine.updateJob).toHaveBeenCalledWith(
      "telegram-cron-pulse",
      {
        name: "Telegram Cron Pulse",
        deliver: { target: "telegram", chatId: "123456" },
        enabled: true,
      },
    );
  });

  it("defaults timeframe for opening trades while still requiring a symbol", () => {
    expect(
      assertExplicitMarketContext(
        { symbol: "BTC/USDT", venue: "binance", id: "strategy-1", executionMode: "paper", entry: {}, exits: {}, sizing: {}, risk: { maxPositionNotional: 1, maxDailyLoss: 1, maxOpenOrders: 1 } } as any,
        { symbol: "BTC/USDT" },
        "trade",
      ),
    ).toEqual({ symbol: "BTC/USDT", timeframe: "1h" });
  });

  it("builds close-only sell intents from open positions", () => {
    const paperEngine = {
      getPortfolio: () => ({
        positions: [
          { symbol: "BTC/USDT", quantity: 1.5 },
          { symbol: "ETH/USDT", quantity: 0 },
          { symbol: "SOL/USDT", quantity: 2 },
        ],
      }),
    } as any;

    const intents = buildCloseOnlyOrderIntents(paperEngine, {
      mode: "paper",
      venue: "binance",
      strategyId: "close-only-001",
    });

    expect(intents).toEqual([
      {
        venue: "binance",
        symbol: "BTC/USDT",
        side: "sell",
        type: "market",
        quantity: 1.5,
        strategyId: "close-only-001",
        mode: "paper",
      },
      {
        venue: "binance",
        symbol: "SOL/USDT",
        side: "sell",
        type: "market",
        quantity: 2,
        strategyId: "close-only-001",
        mode: "paper",
      },
    ]);
  });
});
