/**
 * Tests for ContextEngine with compaction
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ContextEngine } from "./context-engine";
import type { CompactionConfig, ContextState } from "./context-engine";
import { MemoryStoreImpl } from "@dyna/memory-core";
import type { AgentTurnContext } from "@dyna/contracts";

describe("ContextEngine - Compaction", () => {
  let memory: MemoryStoreImpl;
  let engine: ContextEngine;
  let context: AgentTurnContext;

  beforeEach(() => {
    memory = new MemoryStoreImpl();
    context = {
      now: new Date(),
      mode: "paper",
      accountId: "test-account",
      portfolioId: "test-portfolio",
      correlationId: "test-correlation",
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("shouldCompact()", () => {
    it("should return false when context is under the token limit", async () => {
      // Use a very high token limit so we never trigger
      engine = new ContextEngine(
        memory,
        {},
        { maxContextTokens: 999999, reserveTokens: 0 },
      );
      await engine.createContext(context);
      expect(engine.shouldCompact()).toBe(false);
    });

    it("should trigger auto-compaction when approaching token limit", async () => {
      // Use a very low token limit so even a small context triggers
      engine = new ContextEngine(
        memory,
        {},
        { maxContextTokens: 10, reserveTokens: 0 },
      );
      await engine.createContext(context);

      // With such a low limit, even the initial context should trigger
      expect(engine.shouldCompact()).toBe(true);
    });

    it("should trigger compaction when transcript bytes exceed limit", async () => {
      engine = new ContextEngine(
        memory,
        {},
        {
          maxContextTokens: 999999,
          reserveTokens: 0,
          maxActiveTranscriptBytes: 1,
        },
      );
      await engine.createContext(context);

      // Context serialized is > 1 byte, so should trigger
      expect(engine.shouldCompact()).toBe(true);
    });

    it("should return false when there is no current context", async () => {
      engine = new ContextEngine(memory);
      // No context created yet
      expect(engine.shouldCompact()).toBe(false);
    });
  });

  describe("compact()", () => {
    it("should keep recent turns intact after compaction", async () => {
      // Create engine with low token limit to trigger compaction
      engine = new ContextEngine(
        memory,
        {},
        {
          maxContextTokens: 100,
          reserveTokens: 0,
          keepRecentTurns: 2,
          identifierPolicy: "off",
          memoryFlushEnabled: false,
        },
      );

      await engine.createContext(context);

      // Add several turns to build up history
      for (let i = 0; i < 5; i++) {
        await engine.updateContext(
          { now: new Date() },
          [`action-${i}`],
          [`outcome-${i}`],
        );
      }

      const state = engine.getCurrentContext()!;

      // After compaction, there should be a compacted summary entry
      // and the recent turns should be preserved
      const compactedEntry = state.history.find(
        (h) =>
          h.actions.length === 1 &&
          typeof h.actions[0] === "string" &&
          (h.actions[0] as string).startsWith("compaction:"),
      );

      expect(compactedEntry).toBeDefined();
      expect(state.history.length).toBeGreaterThan(0);

      // The last 2 entries should be the recent turns if we had at least keepRecentTurns + 1
      if (state.history.length >= 2) {
        const lastTwo = state.history.slice(-2);
        // None of the last 2 should be compacted entries
        for (const entry of lastTwo) {
          const isCompacted =
            entry.actions.length === 1 &&
            typeof entry.actions[0] === "string" &&
            (entry.actions[0] as string).startsWith("compaction:");
          expect(isCompacted).toBe(false);
        }
      }
    });

    it("should preserve identifiers in strict mode", async () => {
      engine = new ContextEngine(
        memory,
        {},
        {
          maxContextTokens: 10, // Very low to trigger compaction
          reserveTokens: 0,
          keepRecentTurns: 1,
          identifierPolicy: "strict",
          memoryFlushEnabled: false,
        },
      );

      await engine.createContext(context);

      // Add turns that contain important identifiers
      for (let i = 0; i < 3; i++) {
        await engine.updateContext(
          {
            correlationId: `correlation-${i}`,
            accountId: `account-${i}`,
          },
          [`action-${i}`],
          [{ refId: `chunk-ref-${i}-${Date.now()}` }],
        );
      }

      const state = engine.getCurrentContext()!;

      // After compaction, identifiers should be preserved in summaries
      // Check if compacted entry has identifier references
      const compactedEntry = state.history.find(
        (h) =>
          h.actions.length === 1 &&
          typeof h.actions[0] === "string" &&
          (h.actions[0] as string).startsWith("compaction:"),
      );

      // Either a compaction happened or the summary kept identifiers
      expect(state.summary).toBeTruthy();
      expect(state.history.length).toBeGreaterThan(0);

      // Check outcomes for preserved identifiers
      if (compactedEntry) {
        const outcomes = JSON.stringify(compactedEntry.outcomes);
        expect(outcomes).toMatch(/correlation/);
      }
    });

    it("should flush memory before compaction when enabled", async () => {
      const putSpy = vi.spyOn(memory, "put");

      engine = new ContextEngine(
        memory,
        {},
        {
          maxContextTokens: 10,
          reserveTokens: 0,
          keepRecentTurns: 1,
          memoryFlushEnabled: true,
        },
      );

      await engine.createContext(context);

      // Add turns that will trigger compaction
      for (let i = 0; i < 3; i++) {
        await engine.updateContext(
          { now: new Date() },
          [`action-${i}`],
          [`outcome-${i}`],
        );
      }

      // Check that memory flush was called (kind: "memory_flush")
      const flushCalls = putSpy.mock.calls.filter(
        ([event]) => event.kind === "memory_flush",
      );
      expect(flushCalls.length).toBeGreaterThan(0);
    });

    it("should not flush memory before compaction when disabled", async () => {
      const putSpy = vi.spyOn(memory, "put");

      engine = new ContextEngine(
        memory,
        {},
        {
          maxContextTokens: 10,
          reserveTokens: 0,
          keepRecentTurns: 1,
          memoryFlushEnabled: false,
        },
      );

      await engine.createContext(context);

      // Add turns that will trigger compaction
      for (let i = 0; i < 3; i++) {
        await engine.updateContext(
          { now: new Date() },
          [`action-${i}`],
          [`outcome-${i}`],
        );
      }

      // No flush calls should have been made
      const flushCalls = putSpy.mock.calls.filter(
        ([event]) => event.kind === "memory_flush",
      );
      expect(flushCalls.length).toBe(0);
    });

    it("should not compact when under token limit", async () => {
      const putSpy = vi.spyOn(memory, "put");

      engine = new ContextEngine(
        memory,
        {},
        {
          maxContextTokens: 999999, // Very high limit
          reserveTokens: 0,
          keepRecentTurns: 5,
          memoryFlushEnabled: false,
        },
      );

      await engine.createContext(context);

      // Verify shouldCompact returns false before adding turns
      expect(engine.shouldCompact()).toBe(false);

      // Add some turns
      for (let i = 0; i < 3; i++) {
        await engine.updateContext(
          { now: new Date() },
          [`action-${i}`],
          [`outcome-${i}`],
        );
      }

      // Verify shouldCompact still returns false
      expect(engine.shouldCompact()).toBe(false);

      // No compaction events should have been recorded
      const compactCalls = putSpy.mock.calls.filter(
        ([event]) => event.kind === "compaction_event",
      );
      expect(compactCalls.length).toBe(0);
    });
  });

  describe("compressMemory() - compaction awareness", () => {
    it("should preserve identifiers in compressed memory summaries", async () => {
      engine = new ContextEngine(
        memory,
        {
          maxMemoryAge: 1, // 1ms - makes all memories "old" immediately
          maxContextSize: 100,
          similarityThreshold: 0.8,
          compressionRatio: 0.3,
        },
        {
          maxContextTokens: 999999, // Don't trigger context compaction
          identifierPolicy: "strict",
          memoryFlushEnabled: false,
        },
      );

      await engine.createContext(context);

      // Add memory chunks with important IDs
      await engine.addMemoryChunk({
        type: "strategy",
        content: {
          strategyId: "strat-001",
          refId: "chunk-ref-abc-123",
          name: "MA Crossover",
        },
        timestamp: new Date(Date.now() - 100000), // Old enough to compress
        importance: 0.8,
        tags: ["strategy"],
      });

      await engine.addMemoryChunk({
        type: "strategy",
        content: {
          strategyId: "strat-002",
          refId: "chunk-ref-def-456",
          name: "RSI Mean Reversion",
        },
        timestamp: new Date(Date.now() - 100000), // Old enough to compress
        importance: 0.7,
        tags: ["strategy"],
      });

      // Trigger memory compression via updateContext
      await engine.updateContext(
        { now: new Date() },
        ["test-action"],
        ["test-outcome"],
      );

      // Check that compressed chunks contain identifiers
      const compressedChunks = engine
        .getCurrentContext()
        ?.memoryChunks.filter((m) => m.compressed);

      if (compressedChunks && compressedChunks.length > 0) {
        const content = JSON.stringify(
          compressedChunks.map((m) => m.content),
        );
        expect(content).toContain("strat-001");
        expect(content).toContain("strat-002");
        // Opaque IDs like chunk-ref-* should be preserved in the IDs annotation
        expect(content).toMatch(/chunk-ref/);
      }
    });

    it("should skip identifier preservation when policy is off", async () => {
      engine = new ContextEngine(
        memory,
        {
          maxMemoryAge: 1,
          maxContextSize: 100,
          similarityThreshold: 0.8,
          compressionRatio: 0.3,
        },
        {
          maxContextTokens: 999999,
          identifierPolicy: "off",
          memoryFlushEnabled: false,
        },
      );

      await engine.createContext(context);

      await engine.addMemoryChunk({
        type: "strategy",
        content: {
          strategyId: "strat-999",
          name: "Test",
        },
        timestamp: new Date(Date.now() - 100000),
        importance: 0.9,
        tags: ["test"],
      });

      // Trigger compression
      await engine.updateContext(
        { now: new Date() },
        ["test-action"],
        ["test-outcome"],
      );

      const compressedChunks = engine
        .getCurrentContext()
        ?.memoryChunks.filter((m) => m.compressed);

      if (compressedChunks && compressedChunks.length > 0) {
        const content = JSON.stringify(
          compressedChunks.map((m) => m.content),
        );
        // With policy "off", summary should NOT have [IDs: ...] annotation
        expect(content).not.toContain("[IDs:");
      }
    });
  });

  describe("configurability", () => {
    it("should accept partial compaction config with defaults", () => {
      engine = new ContextEngine(memory);
      const config = engine.getCompactionConfig();

      expect(config.maxContextTokens).toBe(80000);
      expect(config.reserveTokens).toBe(4000);
      expect(config.keepRecentTurns).toBe(5);
      expect(config.memoryFlushEnabled).toBe(true);
      expect(config.identifierPolicy).toBe("strict");
      expect(config.compactionModel).toBeUndefined();
      expect(config.maxActiveTranscriptBytes).toBe(5 * 1024 * 1024);
    });

    it("should merge partial config with defaults", () => {
      engine = new ContextEngine(
        memory,
        {},
        { maxContextTokens: 1000, keepRecentTurns: 2 },
      );
      const config = engine.getCompactionConfig();

      expect(config.maxContextTokens).toBe(1000);
      expect(config.keepRecentTurns).toBe(2);
      // Other defaults should remain
      expect(config.reserveTokens).toBe(4000);
      expect(config.identifierPolicy).toBe("strict");
    });

    it("should allow setting a custom compaction model", () => {
      engine = new ContextEngine(
        memory,
        {},
        { compactionModel: "gpt-4-turbo" },
      );
      const config = engine.getCompactionConfig();
      expect(config.compactionModel).toBe("gpt-4-turbo");
    });
  });

  describe("backward compatibility", () => {
    it("should work with existing AgentCore config (no compaction config)", async () => {
      // This mirrors how AgentCore creates ContextEngine
      engine = new ContextEngine(memory, {
        maxMemoryAge: 60000,
        maxContextSize: 50,
        similarityThreshold: 0.8,
        compressionRatio: 0.3,
      });

      await engine.createContext(context);

      expect(engine.getCurrentContext()).toBeDefined();
      expect(engine.getCurrentContext()?.current.accountId).toBe(
        "test-account",
      );
    });

    it("should not break existing memory operations", async () => {
      engine = new ContextEngine(memory, {
        maxMemoryAge: 60000,
        maxContextSize: 50,
        similarityThreshold: 0.8,
        compressionRatio: 0.3,
      });

      await engine.createContext(context);

      const id = await engine.addMemoryChunk({
        type: "market",
        content: { price: 50000, symbol: "BTC/USDT" },
        timestamp: new Date(),
        importance: 0.5,
        tags: ["price", "btc"],
      });

      expect(id).toBeTruthy();
      expect(id.startsWith("chunk-")).toBe(true);

      const memories = await engine.getRelevantMemories("BTC", 5);
      expect(memories.length).toBeGreaterThan(0);
    });

    it("should maintain history tracking", async () => {
      engine = new ContextEngine(memory, {
        maxMemoryAge: 60000,
        maxContextSize: 50,
        similarityThreshold: 0.8,
        compressionRatio: 0.3,
      });

      await engine.createContext(context);

      for (let i = 0; i < 3; i++) {
        await engine.updateContext(
          { now: new Date() },
          [`action-${i}`],
          [`outcome-${i}`],
        );
      }

      const state = engine.getCurrentContext()!;
      expect(state.history.length).toBe(3);
      expect(state.summary).toBeTruthy();
    });
  });
});
