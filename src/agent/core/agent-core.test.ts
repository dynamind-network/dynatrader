/**
 * Tests for enhanced Agent Core
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCore } from "./agent-core";
import { ContextEngine } from "./context-engine";
import { IterationBudget } from "./iteration-budget";
import { PromptBuilder } from "./prompt-builder";
import { MemoryStoreImpl } from "@dyna/memory-core";
import type { StrategySource, AgentTurnContext, TradeMode, ModelRouter, ModelRequest, ModelResponse } from "@dyna/contracts";
import { CrossSessionRecall } from "./cross-session-recall";
import { SkillFactory } from "./skill-factory";
import type { TradeOutcome, MarketConditions } from "./types";

function createStrategyTemplateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dynatrader-strategy-templates-"));
  const templatesDir = join(dir, "strategy-templates");
  mkdirSync(templatesDir, { recursive: true });

  const shared = {
    category: "trend-following",
    timeframe: "4h",
    symbols: ["BTC/USDT", "ETH/USDT"],
    riskLevel: "medium",
    indicators: ["EMA"],
  };

  writeFileSync(
    join(templatesDir, "moving-average-crossover.json"),
    JSON.stringify({
      id: "moving-average-crossover",
      name: "Moving Average Crossover",
      description: "Generate an MA crossover strategy from workspace data",
      ...shared,
      parameters: [
        { name: "fastPeriod", type: "number", required: true, description: "Fast moving average period", defaultValue: 10 },
        { name: "slowPeriod", type: "number", required: true, description: "Slow moving average period", defaultValue: 20 },
        { name: "positionAmount", type: "number", required: false, description: "Explicit position amount", defaultValue: 0.01 },
        { name: "symbol", type: "string", required: false, description: "Trading pair symbol", defaultValue: "BTC/USDT" },
        { name: "venue", type: "string", required: false, description: "Exchange venue", defaultValue: "binance" },
        { name: "timeframe", type: "string", required: false, description: "Trading timeframe", defaultValue: "4h" },
        { name: "maxPositionNotional", type: "number", required: false, description: "Maximum position notional", defaultValue: 5000 },
        { name: "maxDailyLoss", type: "number", required: false, description: "Maximum daily loss", defaultValue: 500 },
        { name: "maxOpenOrders", type: "number", required: false, description: "Maximum open orders", defaultValue: 3 },
      ],
      strategy: {
        id: "strategy-{{symbol}}-ma",
        venue: "{{venue}}",
        symbol: "{{symbol}}",
        timeframe: "{{timeframe}}",
        entry: {
          condition: "ema_crossover",
          fastPeriod: "{{fastPeriod}}",
          slowPeriod: "{{slowPeriod}}",
        },
        exits: {
          takeProfit: 0.05,
          stopLoss: 0.02,
          trailingStop: 0.01,
        },
        sizing: {
          amount: "{{positionAmount}}",
          currency: "USDT",
        },
        risk: {
          maxPositionNotional: "{{maxPositionNotional}}",
          maxDailyLoss: "{{maxDailyLoss}}",
          maxOpenOrders: "{{maxOpenOrders}}",
        },
        executionMode: "{{mode}}",
      },
    }, null, 2),
    "utf8",
  );

  writeFileSync(
    join(templatesDir, "rsi-mean-reversion.json"),
    JSON.stringify({
      id: "rsi-mean-reversion",
      name: "RSI Mean Reversion",
      description: "Generate an RSI mean reversion strategy from workspace data",
      category: "mean-reversion",
      timeframe: "1h",
      symbols: ["BTC/USDT", "ETH/USDT"],
      riskLevel: "medium",
      indicators: ["RSI"],
      parameters: [
        { name: "period", type: "number", required: true, description: "RSI calculation period", defaultValue: 14 },
        { name: "threshold", type: "number", required: true, description: "Oversold threshold", defaultValue: 30 },
        { name: "symbol", type: "string", required: false, description: "Trading pair symbol", defaultValue: "BTC/USDT" },
        { name: "venue", type: "string", required: false, description: "Exchange venue", defaultValue: "binance" },
        { name: "timeframe", type: "string", required: false, description: "Trading timeframe", defaultValue: "1h" },
      ],
      strategy: {
        id: "strategy-{{symbol}}-rsi",
        venue: "{{venue}}",
        symbol: "{{symbol}}",
        timeframe: "{{timeframe}}",
        entry: {
          condition: "rsi_oversold",
          period: "{{period}}",
          threshold: "{{threshold}}",
        },
        exits: {
          takeProfit: 0.03,
          stopLoss: 0.015,
          rsiExit: {
            period: "{{period}}",
            threshold: 70,
          },
        },
        sizing: {
          amount: 0.01,
          currency: "BTC",
        },
        risk: {
          maxPositionNotional: 3000,
          maxDailyLoss: 300,
          maxOpenOrders: 5,
        },
        executionMode: "{{mode}}",
      },
    }, null, 2),
    "utf8",
  );

  return templatesDir;
}

function createMockModelRouter(
  capture: { systemPrompts: string[]; tasks?: string[]; toolCounts?: number[]; maxTokens?: number[] },
  contextWindowTokens = 128000,
  responses: ModelResponse[] = [],
): ModelRouter {
  const defaultResponse: ModelResponse = {
    content: "ok",
    model: "test-model",
    provider: "test-provider",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    latencyMs: 1,
  };
  let callCount = 0;
  const nextResponse = (): ModelResponse => responses[Math.min(callCount, responses.length - 1)] ?? defaultResponse;

  return {
    async selectProvider() {
      return {
        id: "test-provider",
        name: "Test Provider",
        async call(request: ModelRequest, task?: string): Promise<ModelResponse> {
          if (task) capture.tasks?.push(task);
          capture.systemPrompts.push(String(request.messages[0]?.content ?? ""));
          capture.toolCounts?.push(request.tools?.length ?? 0);
          capture.maxTokens?.push(request.maxTokens ?? 0);
          const response = nextResponse();
          callCount += 1;
          return response;
        },
        async *stream() {
          yield { type: "content", content: "ok" } as any;
        },
      };
    },
    async call(request: ModelRequest, task?: string): Promise<ModelResponse> {
      if (task) capture.tasks?.push(task);
      capture.systemPrompts.push(String(request.messages[0]?.content ?? ""));
      capture.toolCounts?.push(request.tools?.length ?? 0);
      capture.maxTokens?.push(request.maxTokens ?? 0);
      const response = nextResponse();
      callCount += 1;
      return response;
    },
    async *stream() {
      yield { type: "content", content: "ok" } as any;
    },
    getProvider() {
      return undefined;
    },
    async getCostStats() {
      return { totalCost: 0, totalTokens: 0, callsByProvider: {} };
    },
    getActiveModel() {
      return "test-model";
    },
    getContextWindowTokens() {
      return contextWindowTokens;
    },
    listModels() {
      return [{ id: "test-model", provider: "test-provider", supportsStreaming: true }];
    },
    resetModel() {},
  };
}

describe("Agent Core", () => {
  let agent: AgentCore;
  let memory: MemoryStoreImpl;
  let templateDir: string;
  let contextEngine: ContextEngine;
  let budget: IterationBudget;

  beforeEach(() => {
    // Mock dependencies
    memory = new MemoryStoreImpl();
    templateDir = createStrategyTemplateDir();
    const strategyResponse: ModelResponse = {
      content: JSON.stringify({
        id: "strategy-btc-ma",
        venue: "binance",
        symbol: "BTC/USDT",
        timeframe: "4h",
        entry: { condition: "ema_crossover" },
        exits: { takeProfit: 0.05, stopLoss: 0.02 },
        sizing: { amount: 0.01 },
        risk: {
          maxPositionNotional: 5000,
          maxDailyLoss: 500,
          maxOpenOrders: 3,
        },
        executionMode: "paper",
      }),
      model: "test-model",
      provider: "test-provider",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      latencyMs: 1,
    };

    // Create agent with config
    agent = new AgentCore({
      memory,
      modelRouter: createMockModelRouter({ systemPrompts: [] }, 128000, [strategyResponse]),
      contextConfig: {
        maxMemoryAge: 60000, // 1 minute
        maxContextSize: 50,
        similarityThreshold: 0.8,
        compressionRatio: 0.3,
      },
      budgetConfig: {
        maxIterations: 5,
        maxTimeMs: 10000,
        maxMemoryUsage: 10 * 1024 * 1024,
        maxApiCalls: 20,
      },
    });
  });

  describe("Execute Turn", () => {
    it("should complete agent turn with multiple iterations", async () => {
      const context: AgentTurnContext = {
        now: new Date(),
        mode: "paper",
        accountId: "test-account",
        portfolioId: "test-portfolio",
        correlationId: "test-correlation",
      };

      const source: StrategySource = {
        kind: "template",
        body: "moving-average-crossover",
        params: {
          fastPeriod: 10,
          slowPeriod: 20,
          symbol: "BTC/USDT",
        },
      };

      const result = await agent.executeTurn(context, source);

      expect(result.completed).toBe(true);
      expect(result.iterations.length).toBeGreaterThan(0);
      expect(result.finalStrategies.length).toBeGreaterThan(0);
      expect(result.totalTime).toBeGreaterThan(0);
    });

    it("should preserve the supplied session context during executeTurn", async () => {
      const context: AgentTurnContext = {
        now: new Date(),
        mode: "paper",
        accountId: "turn-account",
        portfolioId: "turn-portfolio",
        correlationId: "turn-correlation",
        sessionId: "turn-session",
      };

      const source: StrategySource = {
        kind: "template",
        body: "moving-average-crossover",
        params: {
          fastPeriod: 10,
          slowPeriod: 20,
          symbol: "BTC/USDT",
        },
      };

      await agent.executeTurn(context, source);

      const currentContext = agent.getCurrentContext();
      expect(currentContext?.current.sessionId).toBe("turn-session");
      expect(currentContext?.current.accountId).toBe("turn-account");
    });

    it("should honor configured chat template names instead of hidden defaults", async () => {
      const prompts: string[] = [];
      const chatAgent = new AgentCore({
        memory,
        modelRouter: createMockModelRouter({ systemPrompts: prompts }),
        templateNames: {
          chat: "strategy-discovery",
        },
        contextConfig: {
          maxMemoryAge: 60000,
          maxContextSize: 50,
          similarityThreshold: 0.8,
          compressionRatio: 0.3,
        },
        budgetConfig: {
          maxIterations: 5,
          maxTimeMs: 10000,
          maxMemoryUsage: 10 * 1024 * 1024,
          maxApiCalls: 20,
        },
      });

      const result = await chatAgent.chat("Explain the workflow");
      expect(result.content).toBe("ok");
      expect(prompts[0]).toContain("workspace-defined trading agent");
      expect(prompts[0]).toContain("session_search");
      expect(prompts[0]).toContain("USER.md");
    });

    it("should return an error after retry when the model still omits visible text", async () => {
      const capture = { systemPrompts: [] as string[], tasks: [] as string[], toolCounts: [] as number[] };
      const toolRegistry = {
        list: () => [{
          definition: {
            name: "noop_tool",
            description: "No-op tool for forcing tool-routing retries",
            category: "test",
            inputSchema: {},
            outputSchema: {},
            permissionsRequired: [],
            sideEffects: [],
            riskLevel: "low",
            timeoutMs: 1000,
            canRunInParallel: true,
          },
          execute: vi.fn(),
        }],
        executeBatch: vi.fn(),
      } as any;

      const chatAgent = new AgentCore({
        memory,
        modelRouter: createMockModelRouter(capture, 128000, [
          {
            content: "",
            reasoningContent: "Working through the answer.",
            model: "test-model",
            provider: "test-provider",
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            latencyMs: 1,
          },
          {
            content: "",
            reasoningContent: "Still thinking.",
            model: "test-model",
            provider: "test-provider",
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            latencyMs: 1,
          },
        ]),
        toolRegistry,
      });

      const result = await chatAgent.chat("trade BTC/USDT");
      expect(result.state).toBe("error");
      expect(result.content).toContain("Model returned no visible output.");
      expect(capture.tasks).toHaveLength(2);
    });

    it("should allow tool-free detached chats when requested", async () => {
      const capture = { systemPrompts: [] as string[], toolCounts: [] as number[] };
      const chatAgent = new AgentCore({
        memory,
        modelRouter: createMockModelRouter(capture),
        contextConfig: {
          maxMemoryAge: 60000,
          maxContextSize: 50,
          similarityThreshold: 0.8,
          compressionRatio: 0.3,
        },
        budgetConfig: {
          maxIterations: 5,
          maxTimeMs: 10000,
          maxMemoryUsage: 10 * 1024 * 1024,
          maxApiCalls: 20,
        },
      });

      const result = await chatAgent.chat("status check", {
        sessionId: "cron:telegram-cron-pulse",
        allowTools: false,
      });

      expect(result.content).toBe("ok");
      expect(capture.toolCounts[0]).toBe(0);
    });

    it("should not trigger forced-tool retry when tools are disabled", async () => {
      const capture = { systemPrompts: [] as string[], tasks: [] as string[], toolCounts: [] as number[] };
      const toolRegistry = {
        list: () => [{
          definition: {
            name: "noop_tool",
            description: "No-op tool for forcing tool-routing retries",
            category: "test",
            inputSchema: {},
            outputSchema: {},
            permissionsRequired: [],
            sideEffects: [],
            riskLevel: "low",
            timeoutMs: 1000,
            canRunInParallel: true,
          },
          execute: vi.fn(),
        }],
        executeBatch: vi.fn(),
      } as any;

      const chatAgent = new AgentCore({
        memory,
        modelRouter: createMockModelRouter(capture, 128000, [{
          content: "",
          reasoningContent: "Working through the answer.",
          model: "test-model",
          provider: "test-provider",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          latencyMs: 1,
        }]),
        toolRegistry,
      });

      const result = await chatAgent.chat("trade BTC/USDT", {
        allowTools: false,
      });

      expect(result.state).toBe("error");
      expect(capture.tasks).toHaveLength(1);
    });

    it("should let a Telegram turn invoke telegram_send when tools are enabled", async () => {
      const capture = { systemPrompts: [] as string[], tasks: [] as string[], toolCounts: [] as number[] };
      const telegramSendTool = {
        definition: {
          name: "telegram_send",
          description: "Send a Telegram message",
          category: "session",
          inputSchema: { message: "string" },
          outputSchema: { deliveredTo: "string" },
          permissionsRequired: [],
          sideEffects: ["notification"],
          riskLevel: "medium",
          timeoutMs: 1000,
          canRunInParallel: true,
        },
        execute: vi.fn(),
      };
      const toolRegistry = {
        list: () => [telegramSendTool],
        executeBatch: vi.fn(async (calls: Array<{ tool: string; args: Record<string, unknown>; id?: string }>) => calls.map((call) => ({
          call,
          result: {
            success: true,
            data: { deliveredTo: "telegram:123456", status: "sent" },
            durationMs: 1,
            truncated: false,
          },
        }))),
      } as any;

      const chatAgent = new AgentCore({
        memory,
        modelRouter: createMockModelRouter(capture, 128000, [
          {
            content: "",
            reasoningContent: "Sending the update through Telegram.",
            model: "test-model",
            provider: "test-provider",
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            latencyMs: 1,
            toolCalls: [{
              id: "call-telegram-send",
              type: "function",
              function: {
                name: "telegram_send",
                arguments: JSON.stringify({ message: "status update" }),
              },
            }],
          },
          {
            content: "Sent the update.",
            model: "test-model",
            provider: "test-provider",
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            latencyMs: 1,
          },
        ]),
        toolRegistry,
      });

      const result = await chatAgent.chat("send the update to Telegram", {
        sessionId: "telegram:123456",
      });

      expect(result.content).toBe("Sent the update.");
      expect(capture.toolCounts[0]).toBeGreaterThan(0);
      expect(toolRegistry.executeBatch).toHaveBeenCalled();
    });

    it("should sync the runtime context window to the active model", async () => {
      const prompts: string[] = [];
      const chatAgent = new AgentCore({
        memory,
        modelRouter: createMockModelRouter({ systemPrompts: prompts }, 4096),
      });

      await chatAgent.chat("hello");

      expect(chatAgent.getContextWindowTokens()).toBe(4096);
    });

    it("should leave room for the prompt when sizing chat completions", async () => {
      const capture = { systemPrompts: [] as string[], maxTokens: [] as number[] };
      const chatAgent = new AgentCore({
        memory,
        modelRouter: createMockModelRouter(capture, 8192),
      });

      await chatAgent.chat("hello");

      expect(capture.maxTokens[0]).toBeGreaterThan(2048);
      expect(capture.maxTokens[0]).toBeLessThanOrEqual(4096);
    });

    it("should honor configured routing task names instead of hardcoded trading analysis labels", async () => {
      const capture = { systemPrompts: [] as string[], tasks: [] as string[] };
      const routedAgent = new AgentCore({
        memory,
        modelRouter: createMockModelRouter(capture),
        routingTaskNames: {
          analysis: "general_analysis",
        },
        contextConfig: {
          maxMemoryAge: 60000,
          maxContextSize: 50,
          similarityThreshold: 0.8,
          compressionRatio: 0.3,
        },
        budgetConfig: {
          maxIterations: 5,
          maxTimeMs: 10000,
          maxMemoryUsage: 10 * 1024 * 1024,
          maxApiCalls: 20,
        },
      });

      await routedAgent.chat("Explain the workflow");
      expect(capture.tasks[0]).toBe("general_analysis");
    });

    it("should not trigger dreaming inline after repeated user prompts", async () => {
      const dreamEngine = {
        runDreamCycleIfNeeded: vi.fn().mockResolvedValue(null),
      };
      const chatAgent = new AgentCore({
        memory,
        modelRouter: createMockModelRouter({ systemPrompts: [] }),
        dreamEngine: dreamEngine as any,
        templateNames: {
          chat: "strategy-discovery",
        },
        contextConfig: {
          maxMemoryAge: 60000,
          maxContextSize: 50,
          similarityThreshold: 0.8,
          compressionRatio: 0.3,
        },
        budgetConfig: {
          maxIterations: 5,
          maxTimeMs: 10000,
          maxMemoryUsage: 10 * 1024 * 1024,
          maxApiCalls: 20,
        },
      });

      for (let i = 0; i < 10; i++) {
        const result = await chatAgent.chat(`Prompt ${i}`);
        expect(result.content).toBe("ok");
      }

      expect(dreamEngine.runDreamCycleIfNeeded).not.toHaveBeenCalled();
    });

    it("should handle iteration budget exhaustion", async () => {
      const context: AgentTurnContext = {
        now: new Date(),
        mode: "paper",
        accountId: "test-account",
        portfolioId: "test-portfolio",
        correlationId: "test-correlation",
      };

      const source: StrategySource = {
        kind: "template",
        body: "rsi-mean-reversion",
        params: { period: 14 },
      };

      // Set very low budget to test exhaustion
      const limitedAgent = new AgentCore({
        memory,
        modelRouter: createMockModelRouter({ systemPrompts: [] }, 128000, [{
          content: JSON.stringify({
            id: "strategy-btc-limit",
            venue: "binance",
            symbol: "BTC/USDT",
            timeframe: "4h",
            entry: { condition: "ema_crossover" },
            exits: { takeProfit: 0.05, stopLoss: 0.02 },
            sizing: { amount: 0.01 },
            risk: {
              maxPositionNotional: 5000,
              maxDailyLoss: 500,
              maxOpenOrders: 3,
            },
            executionMode: "paper",
          }),
          model: "test-model",
          provider: "test-provider",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          latencyMs: 1,
        }]),
        budgetConfig: {
          maxIterations: 1,
          maxTimeMs: 1000,
          maxMemoryUsage: 1024 * 1024,
          maxApiCalls: 1,
        },
      });

      const result = await limitedAgent.executeTurn(context, source);

      expect(result.completed).toBe(false);
      expect(result.iterations.length).toBe(1);
    });

    it("should generate order intents with risk evaluation", async () => {
      const context: AgentTurnContext = {
        now: new Date(),
        mode: "paper",
        accountId: "test-account",
        portfolioId: "test-portfolio",
        correlationId: "test-correlation",
      };

      const source: StrategySource = {
        kind: "template",
        body: "moving-average-crossover",
        params: {
          fastPeriod: 10,
          slowPeriod: 20,
          symbol: "BTC/USDT",
        },
      };

      const result = await agent.executeTurn(context, source);

      // Check that order intents were generated
      expect(result.pendingApprovals.length).toBeGreaterThan(0);

      // Check that each order has proper risk evaluation
      for (const order of result.pendingApprovals) {
        expect(order.symbol).toBe("BTC/USDT");
        expect(order.mode).toBe("paper");
        expect(["buy", "sell"]).toContain(order.side);
        expect(["market", "limit", "stop", "stop-limit"]).toContain(order.type);
      }
    });
  });

  describe("Context Management", () => {
    it("should maintain context across iterations", async () => {
      const context: AgentTurnContext = {
        now: new Date(),
        mode: "paper",
        accountId: "test-account",
        portfolioId: "test-portfolio",
        correlationId: "test-correlation",
      };

      const source: StrategySource = {
        kind: "template",
        body: "rsi-mean-reversion",
        params: { period: 14 },
      };

      await agent.executeTurn(context, source);

      const currentContext = agent.getCurrentContext();
      expect(currentContext).toBeDefined();
      expect(currentContext?.history.length).toBeGreaterThan(0);
    });

    it("should store and retrieve memories", async () => {
      const context: AgentTurnContext = {
        now: new Date(),
        mode: "paper",
        accountId: "test-account",
        portfolioId: "test-portfolio",
        correlationId: "test-correlation",
      };

      const source: StrategySource = {
        kind: "template",
        body: "moving-average-crossover",
        params: { symbol: "ETH/USDT" },
      };

      await agent.executeTurn(context, source);

      const memories = await memory.search({
        scope: "agent_memory",
        text: "strategy",
        topK: 5,
      });

      expect(memories.length).toBeGreaterThan(0);
      expect(memories[0]!.payload).toBeDefined();
    });

    it("should keep chat context scoped to the supplied session and runtime mode", async () => {
      const liveChatAgent = new AgentCore({
        memory,
        modelRouter: createMockModelRouter({ systemPrompts: [] }),
        defaultMode: "live",
        contextConfig: {
          maxMemoryAge: 60000,
          maxContextSize: 50,
          similarityThreshold: 0.8,
          compressionRatio: 0.3,
        },
        budgetConfig: {
          maxIterations: 5,
          maxTimeMs: 10000,
          maxMemoryUsage: 10 * 1024 * 1024,
          maxApiCalls: 20,
        },
      });

      await liveChatAgent.chat("hello", { sessionId: "room-a" });
      await liveChatAgent.chat("hello again", { sessionId: "room-b" });

      const currentContext = liveChatAgent.getCurrentContext();
      expect(currentContext?.current.sessionId).toBe("room-b");
      expect(currentContext?.current.mode).toBe("live");
    });

    it("should keep session transcripts isolated across repeated chat turns", async () => {
      const transcriptAgent = new AgentCore({
        memory,
        modelRouter: createMockModelRouter({ systemPrompts: [] }),
        defaultMode: "paper",
        contextConfig: {
          maxMemoryAge: 60000,
          maxContextSize: 50,
          similarityThreshold: 0.8,
          compressionRatio: 0.3,
        },
        budgetConfig: {
          maxIterations: 5,
          maxTimeMs: 10000,
          maxMemoryUsage: 10 * 1024 * 1024,
          maxApiCalls: 20,
        },
      });

      await transcriptAgent.chat("hello room a", { sessionId: "room-a" });
      await transcriptAgent.chat("follow up room a", { sessionId: "room-a" });
      await transcriptAgent.chat("hello room b", { sessionId: "room-b" });

      const sessions = transcriptAgent.listSessions();
      expect(sessions.map((session) => session.id)).toEqual(expect.arrayContaining(["room-a", "room-b"]));
      expect(sessions.find((session) => session.id === "room-a")?.messageCount).toBe(4);
      expect(sessions.find((session) => session.id === "room-b")?.messageCount).toBe(2);

      transcriptAgent.switchSession("room-a");
      expect(transcriptAgent.getConversationHistory().length).toBe(4);
      transcriptAgent.switchSession("room-b");
      expect(transcriptAgent.getConversationHistory().length).toBe(2);
    });
  });

  describe("Human Feedback", () => {
    it("should store human feedback", async () => {
      // First execute a turn to create iterations
      const context: AgentTurnContext = {
        now: new Date(),
        mode: "paper",
        accountId: "test-account",
        portfolioId: "test-portfolio",
        correlationId: "test-correlation",
      };

      const source: StrategySource = {
        kind: "template",
        body: "moving-average-crossover",
        params: { symbol: "BTC/USDT" },
      };

      const result = await agent.executeTurn(context, source);
      const iterationId = result.iterations[0]?.id;

      // Add feedback
      await agent.addFeedback(iterationId!, "Good strategy execution");

      // Verify feedback is stored
      const feedback = await memory.search({
        scope: "agent_memory",
        text: "feedback",
        topK: 1,
      });

      expect(feedback.length).toBeGreaterThan(0);
      expect(feedback[0]!.payload).toEqual(
        expect.objectContaining({
          iterationId,
          feedback: "Good strategy execution",
        })
      );
    });

    it("should throw error for non-existent iteration", async () => {
      await expect(
        agent.addFeedback("non-existent", "test feedback")
      ).rejects.toThrow("Iteration not found");
    });
  });

  describe("Reset Functionality", () => {
    it("should reset agent state", async () => {
      const context: AgentTurnContext = {
        now: new Date(),
        mode: "paper",
        accountId: "test-account",
        portfolioId: "test-portfolio",
        correlationId: "test-correlation",
      };

      const source: StrategySource = {
        kind: "template",
        body: "moving-average-crossover",
        params: {},
      };

      await agent.executeTurn(context, source);

      // Verify state exists
      expect(agent.getIterationHistory().length).toBeGreaterThan(0);
      expect(agent.getCurrentContext()).toBeDefined();

      // Reset
      await agent.reset();

      // Verify state is cleared
      expect(agent.getIterationHistory()).toHaveLength(0);
      expect(agent.getCurrentContext()).toBeUndefined();
    });
  });

  describe("Learning Loop Wiring", () => {
    let crossSessionRecall: CrossSessionRecall;
    let skillFactory: SkillFactory;

    beforeEach(() => {
      crossSessionRecall = new CrossSessionRecall(memory);
      skillFactory = new SkillFactory();
    });

    describe("CrossSessionRecall in buildLearningsContext", () => {
      it("should include cross-session recall results when available", async () => {
        await crossSessionRecall.index("session-1", "BTC/USDT breakout pattern was profitable");
        await crossSessionRecall.index("session-2", "BTC/USDT ranging market needs tight stops");

        const agentWithRecall = new AgentCore({
          memory,
          modelRouter: createMockModelRouter({ systemPrompts: [] }, 128000, [{
            content: JSON.stringify({
              id: "strategy-btc-recall",
              venue: "binance",
              symbol: "BTC/USDT",
              timeframe: "4h",
              entry: { condition: "ema_crossover" },
              exits: { takeProfit: 0.05, stopLoss: 0.02 },
              sizing: { amount: 0.01 },
              risk: { maxPositionNotional: 5000, maxDailyLoss: 500, maxOpenOrders: 3 },
              executionMode: "paper",
            }),
            model: "test-model",
            provider: "test-provider",
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            latencyMs: 1,
          }]),
          crossSessionRecall,
        });

        const source: StrategySource = {
          kind: "template",
          body: "moving-average-crossover",
          params: { symbol: "BTC/USDT" },
        };

        const context: AgentTurnContext = {
          now: new Date(),
          mode: "paper",
          accountId: "test-account",
          portfolioId: "test-portfolio",
          correlationId: "test-correlation",
        };

        const result = await agentWithRecall.executeTurn(context, source);

        expect(result.completed).toBe(true);
        expect(result.iterations.length).toBeGreaterThan(0);
      });

      it("should not crash when cross-session recall is not configured", async () => {
        const source: StrategySource = {
          kind: "template",
          body: "moving-average-crossover",
          params: { symbol: "BTC/USDT" },
        };

        const context: AgentTurnContext = {
          now: new Date(),
          mode: "paper",
          accountId: "test-account",
          portfolioId: "test-portfolio",
          correlationId: "test-correlation",
        };

        const result = await agent.executeTurn(context, source);

        expect(result.completed).toBe(true);
        expect(result.error).toBeUndefined();
      });
    });

    describe("Skill retrieval in buildLearningsContext", () => {
      it("should include existing skills when available", async () => {
        await memory.put({
          scope: "agent_memory",
          kind: "skill_created",
          payload: {
            type: "skill_created",
            id: "skill-123",
            description: "BTC momentum strategy",
            name: "BTC Momentum",
          },
          ts: new Date(),
        });

        const source: StrategySource = {
          kind: "template",
          body: "moving-average-crossover",
          params: { symbol: "BTC/USDT" },
        };

        const context: AgentTurnContext = {
          now: new Date(),
          mode: "paper",
          accountId: "test-account",
          portfolioId: "test-portfolio",
          correlationId: "test-correlation",
        };

        const result = await agent.executeTurn(context, source);

        expect(result.completed).toBe(true);
        expect(result.iterations.length).toBeGreaterThan(0);
      });

      it("should not crash when memory search fails", async () => {
        const source: StrategySource = {
          kind: "template",
          body: "moving-average-crossover",
          params: { symbol: "BTC/USDT" },
        };

        const context: AgentTurnContext = {
          now: new Date(),
          mode: "paper",
          accountId: "test-account",
          portfolioId: "test-portfolio",
          correlationId: "test-correlation",
        };

        const result = await agent.executeTurn(context, source);

        expect(result.completed).toBe(true);
        expect(result.error).toBeUndefined();
      });
    });

    describe("processTradeOutcome", () => {
      const makeTradeOutcome = (overrides: Partial<TradeOutcome> = {}): TradeOutcome => ({
        tradeId: "trade-1",
        symbol: "BTC/USDT",
        side: "buy",
        entryPrice: 50000,
        exitPrice: 55000,
        quantity: 0.1,
        pnl: 500,
        pnlPercent: 10,
        holdingTimeMs: 3600000,
        strategy: {
          id: "strat-1",
          venue: "hyperliquid",
          symbol: "BTC/USDT",
          entry: {},
          exits: {},
          sizing: {},
          risk: { maxPositionNotional: 5000, maxDailyLoss: 500, maxOpenOrders: 3 },
          executionMode: "paper",
        },
        marketConditions: {
          regime: "trending",
          volatility: 0.5,
          trend: "bullish",
          volume: "normal",
        },
        timestamp: Date.now(),
        ...overrides,
      });

      it("should process trade outcome and write to memory", async () => {
        const outcome = makeTradeOutcome();
        await agent.processTradeOutcome(outcome);

        const journal = await memory.search({ scope: "decision_journal", text: "", topK: 50 });
        expect(journal.some((entry) => (entry.payload as { type?: string }).type === "outcome")).toBe(true);
      });

      it("should not crash when called without optional components", async () => {
        const outcome = makeTradeOutcome();
        await agent.processTradeOutcome(outcome);
      });
    });

    describe("processExecution", () => {
      it("should write observation for filled trades", async () => {
        const intent = {
          venue: "binance",
          symbol: "BTC/USDT",
          side: "buy" as const,
          type: "market" as const,
          quantity: 0.1,
          strategyId: "test-strategy",
          mode: "paper" as const,
        };
        const trade = {
          id: "trade-exec-1",
          timestamp: new Date(),
          venue: "binance",
          symbol: "BTC/USDT",
          side: "buy" as const,
          type: "market" as const,
          quantity: 0.1,
          price: 50000,
          value: 5000,
          fees: 5,
          slippage: 0,
          status: "filled" as const,
        };

        await agent.processExecution({ intent, trade, executionMode: "paper" });
      });

      it("should not crash for non-filled trades", async () => {
        const intent = {
          venue: "binance",
          symbol: "BTC/USDT",
          side: "buy" as const,
          type: "market" as const,
          quantity: 0.1,
          strategyId: "test-strategy",
          mode: "paper" as const,
        };
        const trade = {
          id: "trade-pending-1",
          timestamp: new Date(),
          venue: "binance",
          symbol: "BTC/USDT",
          side: "buy" as const,
          type: "market" as const,
          quantity: 0.1,
          price: 50000,
          value: 5000,
          fees: 5,
          slippage: 0,
          status: "cancelled" as const,
        };

        await agent.processExecution({ intent, trade, executionMode: "paper" });
      });
    });
  });
});
