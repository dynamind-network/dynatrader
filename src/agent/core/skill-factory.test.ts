/**
 * Tests for SkillFactory
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillFactory } from "./skill-factory";
import type { Learning, MarketConditions } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMarketConditions(overrides: Partial<MarketConditions> = {}): MarketConditions {
  return {
    regime: "trending",
    volatility: 0.03,
    trend: "bullish",
    volume: "normal",
    ...overrides,
  };
}

function makeLearning(overrides: Partial<Learning> = {}): Learning {
  return {
    id: `learning-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
    type: "pattern",
    content: "test learning content",
    confidence: 0.5,
    evidence: ["trade-001"],
    category: "entry",
    applicableSymbols: ["BTC/USDT"],
    applicableRegimes: ["trending"],
    createdAt: Date.now(),
    timesUsed: 0,
    successRate: 0,
    ...overrides,
  };
}

async function waitForFile(path: string, attempts = 20): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Unable to read ${path}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SkillFactory", () => {
  const factory = new SkillFactory({
    defaultVenue: "hyperliquid",
    defaultRisk: {
      maxPositionNotional: 5000,
      maxDailyLoss: 500,
      maxOpenOrders: 3,
    },
  });
  const conditions = makeMarketConditions();
  const symbol = "BTC/USDT";

  describe("createStrategy()", () => {
    it("returns null when no workspace venue is configured", () => {
      const noVenueFactory = new SkillFactory({
        defaultRisk: {
          maxPositionNotional: 5000,
          maxDailyLoss: 500,
          maxOpenOrders: 3,
        },
      });

      const strategy = noVenueFactory.createStrategy([
        makeLearning({
          category: "entry",
          confidence: 0.85,
          evidence: ["trade-1", "trade-2", "trade-3"],
        }),
        makeLearning({
          category: "exit",
          confidence: 0.85,
          evidence: ["trade-4", "trade-5", "trade-6"],
        }),
      ], conditions, symbol);

      expect(strategy).toBeNull();
    });

    it("should create a new SkillManifest from high-confidence learnings", () => {
      const learnings: Learning[] = [
        makeLearning({
          category: "entry",
          confidence: 0.85,
          content: "RSI below 30 signals good entry in trending markets",
          evidence: ["trade-1", "trade-2", "trade-3"],
        }),
        makeLearning({
          category: "exit",
          confidence: 0.85,
          content: "Take profit at 2:1 risk-reward ratio works well",
          evidence: ["trade-1", "trade-2", "trade-3"],
        }),
      ];

      const strategy = factory.createStrategy(learnings, conditions, symbol);

      expect(strategy).not.toBeNull();
      expect(strategy!.symbol).toBe("BTC/USDT");
      expect(strategy!.venue).toBe("hyperliquid");
      expect(strategy!.executionMode).toBe("paper");
      expect(strategy!.id).toMatch(/^skill-/);
      expect(strategy!.entry).toBeDefined();
      expect(strategy!.exits).toBeDefined();
      expect(strategy!.sizing).toBeDefined();
      expect(strategy!.risk).toBeDefined();
      expect(strategy!.timeframe).toBeUndefined();
    });

    it("should return null when confidence is below threshold", () => {
      const learnings: Learning[] = [
        makeLearning({
          category: "entry",
          confidence: 0.15,
          evidence: ["trade-1"],
        }),
      ];

      const strategy = factory.createStrategy(learnings, conditions, symbol);

      expect(strategy).toBeNull();
    });

    it("should return null when fewer than MIN_EVIDENCE_FOR_CREATION relevant learnings", () => {
      const learnings: Learning[] = [
        makeLearning({
          category: "entry",
          confidence: 0.85,
          evidence: ["trade-1"], // only 1 evidence piece
        }),
      ];

      const strategy = factory.createStrategy(learnings, conditions, symbol);

      expect(strategy).toBeNull();
    });

    it("should merge multiple learnings into a coherent strategy", () => {
      const learnings: Learning[] = [
        makeLearning({
          category: "entry",
          confidence: 0.85,
          content: "RSI below 30 signals good entry in trending markets",
          evidence: ["trade-1", "trade-2", "trade-3"],
        }),
        makeLearning({
          category: "exit",
          confidence: 0.8,
          content: "Risk-reward ratio of 2:1 is optimal for exits",
          evidence: ["trade-4", "trade-5", "trade-6"],
        }),
      ];

      const strategy = factory.createStrategy(learnings, conditions, symbol);

      expect(strategy).not.toBeNull();

      // Entry config should contain RSI threshold from entry learning
      const entry = strategy!.entry as Record<string, unknown>;
      expect(entry.rsiThreshold).toBeDefined();

      // Exit config should contain risk-reward from exit learning
      const exits = strategy!.exits as Record<string, unknown>;
      expect(exits.riskReward).toBeDefined();
    });

    it("should filter learnings by symbol match", () => {
      const learnings: Learning[] = [
        makeLearning({
          category: "entry",
          confidence: 0.85,
          applicableSymbols: ["ETH/USDT"],
          evidence: ["trade-1", "trade-2", "trade-3"],
        }),
      ];

      const strategy = factory.createStrategy(learnings, conditions, symbol);

      // No learnings match BTC/USDT, so should return null
      expect(strategy).toBeNull();
    });

    it("should filter learnings by regime match", () => {
      const learnings: Learning[] = [
        makeLearning({
          category: "entry",
          confidence: 0.85,
          applicableRegimes: ["volatile"],
          evidence: ["trade-1", "trade-2", "trade-3"],
        }),
      ];

      const strategy = factory.createStrategy(learnings, conditions, symbol);

      // No learnings match trending regime, so should return null
      expect(strategy).toBeNull();
    });

    it("should build risk config from risk learnings", () => {
      const learnings: Learning[] = [
        makeLearning({
          category: "risk",
          confidence: 0.85,
          content: "Maximum position size of 5% of capital is safe",
          evidence: ["trade-1", "trade-2", "trade-3"],
        }),
        makeLearning({
          category: "entry",
          confidence: 0.85,
          content: "Entry on pullback to support works well",
          evidence: ["trade-4", "trade-5", "trade-6"],
        }),
      ];

      const strategy = factory.createStrategy(learnings, conditions, symbol);

      expect(strategy).not.toBeNull();
      expect(strategy!.risk.maxPositionNotional).toBeGreaterThan(0);
      expect(strategy!.risk.maxDailyLoss).toBeGreaterThan(0);
      expect(strategy!.risk.maxOpenOrders).toBeGreaterThan(0);
    });

    it("should ignore timing learnings when building reusable skills", () => {
      const learnings: Learning[] = [
        makeLearning({
          category: "timing",
          confidence: 0.85,
          content: "Best entries occur during first hour of trading session",
          evidence: ["trade-1", "trade-2", "trade-3"],
        }),
        makeLearning({
          category: "entry",
          confidence: 0.85,
          content: "Entry on pullback to support works well",
          evidence: ["trade-4", "trade-5", "trade-6"],
        }),
      ];

      const strategy = factory.createStrategy(learnings, conditions, symbol);

      expect(strategy).not.toBeNull();
      expect(strategy!.timeframe).toBeUndefined();
    });

    it("writes a reusable strategy skill directly under skills", async () => {
      const workspace = await mkdtemp(join(tmpdir(), "dyna-strategy-"));
      try {
        const persistentFactory = new SkillFactory({
          workspacePath: workspace,
          defaultVenue: "hyperliquid",
          defaultRisk: {
            maxPositionNotional: 5000,
            maxDailyLoss: 500,
            maxOpenOrders: 3,
          },
        });

        const strategy = persistentFactory.createStrategy(
          [
            makeLearning({
              category: "entry",
              confidence: 0.9,
              content: "RSI below 30 signals good entry in trending markets",
              evidence: ["trade-1", "trade-2", "trade-3"],
            }),
            makeLearning({
              category: "exit",
              confidence: 0.9,
              content: "Take profit at 2:1 risk-reward ratio works well",
              evidence: ["trade-4", "trade-5", "trade-6"],
            }),
          ],
          conditions,
          symbol,
        );

        expect(strategy).not.toBeNull();

        const proposal = await persistentFactory.proposeStrategy(
          strategy!,
          [
            makeLearning({
              category: "entry",
              confidence: 0.9,
              content: "RSI below 30 signals good entry in trending markets",
              evidence: ["trade-1", "trade-2", "trade-3"],
            }),
            makeLearning({
              category: "exit",
              confidence: 0.9,
              content: "Take profit at 2:1 risk-reward ratio works well",
              evidence: ["trade-4", "trade-5", "trade-6"],
            }),
          ],
          conditions,
        );

        expect(proposal).not.toBeNull();

        const skillName = "strategy-btc-usdt-hyperliquid-trending";
        const proposalJsonPath = join(workspace, "skills", skillName, "skill.json");
        const proposalMarkdownPath = join(workspace, "skills", skillName, "SKILL.md");
        const proposalJson = JSON.parse(await waitForFile(proposalJsonPath)) as { sourceKind?: string; approvalState?: string; strategy?: { symbol?: string; timeframe?: string } };
        const proposalMarkdown = await waitForFile(proposalMarkdownPath);

        expect(proposalJson.sourceKind).toBe("strategy");
        expect(proposalJson.approvalState).toBe("approved");
        expect(proposalJson.strategy?.symbol).toBe("BTC/USDT");
        expect(proposalJson.strategy?.timeframe).toBeUndefined();
        expect(proposalMarkdown).toContain("## Strategy");
        expect(proposalMarkdown).toContain("BTC/USDT");

        const approved = await persistentFactory.approveStrategySkill(skillName);
        expect(approved).not.toBeNull();
        const activeJson = JSON.parse(await waitForFile(proposalJsonPath)) as { approvalState?: string; sourceKind?: string };
        expect(activeJson.sourceKind).toBe("strategy");
        expect(activeJson.approvalState).toBe("approved");
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
  });

  describe("createSkillFromTask()", () => {
    it("persists a general reusable skill", async () => {
      const workspace = await mkdtemp(join(tmpdir(), "dyna-skill-"));
      try {
        const persistentFactory = new SkillFactory({
          workspacePath: workspace,
          defaultVenue: "hyperliquid",
          defaultRisk: {
            maxPositionNotional: 5000,
            maxDailyLoss: 500,
            maxOpenOrders: 3,
          },
        });
        const skill = await persistentFactory.createSkillFromTask({
          title: "Repair flaky API tests",
          outcome: "Stabilize clocks before asserting retries",
          steps: ["Inject a clock", "Advance it deterministically", "Assert retry state"],
          tags: ["testing", "api"],
          successful: true,
        });
        expect(skill?.name).toBe("repair-flaky-api-tests");
        expect(await persistentFactory.findSkills("testing")).toHaveLength(1);
        const markdown = await readFile(join(workspace, "skills", skill!.name, "SKILL.md"), "utf8");
        expect(markdown).toContain("Inject a clock");
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
  });
});
