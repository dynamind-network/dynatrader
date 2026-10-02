/**
 * Tests for CrossSessionRecall — FTS5-style text search across trading sessions.
 */

import { MemoryStoreImpl } from "@dyna/memory-core";
import { beforeEach, describe, expect, it } from "vitest";
import { CrossSessionRecall } from "./cross-session-recall";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CrossSessionRecall", () => {
  let memory: MemoryStoreImpl;
  let recall: CrossSessionRecall;

  beforeEach(() => {
    memory = new MemoryStoreImpl();
    recall = new CrossSessionRecall(memory);
  });

  describe("index and search", () => {
    it("should index and search across sessions", async () => {
      await recall.index("session-1", "Bitcoin price action shows strong upward momentum");
      await recall.index("session-2", "Ethereum gas fees are increasing on Layer 2");

      const results = await recall.search("Bitcoin momentum");

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.sessionId).toBe("session-1");
      expect(results[0]!.text).toContain("Bitcoin");
      expect(results[0]!.score).toBeGreaterThan(0);
    });

    it("should rank results by relevance", async () => {
      // Session 1: closely matching — mentions both "trend" and "reversal"
      await recall.index("session-1", "The market trend suggests a reversal pattern forming on daily chart");
      // Session 2: partial match — mentions "trend" but not "reversal"
      await recall.index("session-2", "Trend following strategy is working well on shorter timeframes");
      // Session 3: no match — completely unrelated
      await recall.index("session-3", "Risk management requires strict position sizing limits");

      const results = await recall.search("trend reversal");

      expect(results.length).toBeGreaterThanOrEqual(2);
      // Session 1 matches both terms, should be top result
      expect(results[0]!.sessionId).toBe("session-1");
      // Session 1 should have the highest score
      const session1Score = results.find((r) => r.sessionId === "session-1")!.score;
      const session2Score = results.find((r) => r.sessionId === "session-2")!.score;
      expect(session1Score).toBeGreaterThan(session2Score);
    });

    it("should return empty for unmatched queries", async () => {
      await recall.index("session-1", "Bitcoin price action shows strong upward momentum");

      const results = await recall.search("completely unrelated quantum computing");

      expect(results).toHaveLength(0);
    });

    it("excludes the active session from prior-session results", async () => {
      await recall.index("active", "Bitcoin momentum setup from this conversation");
      await recall.index("prior", "Bitcoin momentum setup from a prior conversation");

      const results = await recall.search("Bitcoin momentum setup", "active");

      expect(results.map((result) => result.sessionId)).toEqual(["prior"]);
    });

    it("restores indexed prompts from persistent memory on first search", async () => {
      await recall.index("session-1", "Bitcoin breakout with rising volume");
      const restored = new CrossSessionRecall(memory);

      const results = await restored.search("Bitcoin breakout");

      expect(results[0]).toMatchObject({
        sessionId: "session-1",
        text: "Bitcoin breakout with rising volume",
      });
    });
  });
});
