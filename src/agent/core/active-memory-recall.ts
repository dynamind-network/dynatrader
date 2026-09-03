/**
 * Active Memory Recall (OpenClaw-style pre-reply memory)
 *
 * Before the main model replies, a lightweight memory search runs in the
 * background and injects relevant context into the prompt. This ensures
 * the model has access to relevant memories BEFORE it generates a reply,
 * not after (which is too late to influence the response).
 *
 * Pattern: OpenClaw's active-memory plugin spawns a hidden sub-agent
 * that searches memory and returns compact context. We implement the
 * same concept inline without the sub-agent overhead.
 */

import type { MemoryStoreImpl } from "@dyna/memory-core";
import type { StateDb } from "../../state-db/state-db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActiveMemoryRecallConfig {
  /** Maximum characters to inject into the prompt */
  maxSummaryChars: number;
  /** Maximum number of memories to recall */
  topK: number;
  /** Minimum relevance score to include */
  minScore: number;
  /** Timeout in ms for the recall search */
  timeoutMs: number;
  /** Enable/disable active recall */
  enabled: boolean;
}

export interface RecallResult {
  /** Compact text to inject into the system prompt */
  context: string;
  /** Number of memories recalled */
  count: number;
  /** Search latency in ms */
  latencyMs: number;
  /** Whether the recall was successful (vs timed out or errored) */
  success: boolean;
}

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: ActiveMemoryRecallConfig = {
  maxSummaryChars: 600,
  topK: 5,
  minScore: 0.3,
  timeoutMs: 5000,
  enabled: true,
};

// ---------------------------------------------------------------------------
// ActiveMemoryRecall
// ---------------------------------------------------------------------------

export class ActiveMemoryRecall {
  private readonly memory: MemoryStoreImpl;
  private readonly stateDb: StateDb | null;
  private readonly config: ActiveMemoryRecallConfig;

  constructor(
    memory: MemoryStoreImpl,
    stateDb?: StateDb | null,
    config?: Partial<ActiveMemoryRecallConfig>,
  ) {
    this.memory = memory;
    this.stateDb = stateDb ?? null;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Run pre-reply memory recall. Called BEFORE the main model generates
   * a reply. Returns compact context to inject into the system prompt.
   *
   * This is the OpenClaw "active memory" pattern — search memory before
   * the model replies, not after.
   */
  async recallBeforeReply(userMessage: string): Promise<RecallResult> {
    if (!this.config.enabled) {
      return { context: "", count: 0, latencyMs: 0, success: true };
    }

    const startTime = Date.now();

    try {
      // Race the search against a timeout
      const searchPromise = this.searchMemory(userMessage);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("recall timeout")), this.config.timeoutMs),
      );

      const results = await Promise.race([searchPromise, timeoutPromise]);

      if (!results || results.length === 0) {
        return { context: "", count: 0, latencyMs: Date.now() - startTime, success: true };
      }

      // Format into compact context block
      const lines: string[] = [];
      let totalChars = 0;

      for (const result of results) {
        if (result.score < this.config.minScore) continue;

        const content = typeof result.content === "string"
          ? result.content
          : JSON.stringify(result.content);

        // Truncate individual entries to keep context compact
        const truncated = content.length > 200 ? content.slice(0, 197) + "..." : content;
        const line = `[memory ${result.scope ?? "unknown"}] ${truncated}`;

        if (totalChars + line.length > this.config.maxSummaryChars) break;

        lines.push(line);
        totalChars += line.length;
      }

      const context = lines.length > 0
        ? `\n\nRELEVANT MEMORIES (pre-recalled):\n${lines.join("\n")}`
        : "";

      return {
        context,
        count: lines.length,
        latencyMs: Date.now() - startTime,
        success: true,
      };
    } catch {
      // On timeout or error, return empty — don't block the reply
      return {
        context: "",
        count: 0,
        latencyMs: Date.now() - startTime,
        success: false,
      };
    }
  }

  /**
   * Search memory using both the MemoryStore and StateDb hybrid search.
   */
  private async searchMemory(
    query: string,
  ): Promise<Array<{ id: string; content: string; score: number; scope?: string }>> {
    const results: Array<{ id: string; content: string; score: number; scope?: string }> = [];

    // 1. Search MemoryStore (event-based memories)
    try {
      const memoryResults = await this.memory.search({
        scope: "agent_memory",
        text: query,
        topK: this.config.topK,
      });

      for (const r of memoryResults) {
        results.push({
          id: r.id,
          content: typeof r.payload === "string" ? r.payload : JSON.stringify(r.payload),
          score: r.score,
          scope: "agent_memory",
        });
      }
    } catch {
      // MemoryStore search failed, continue with StateDb results
    }

    // 2. Search StateDb (unified memories with FTS5 + optional vector)
    if (this.stateDb) {
      try {
        const stateDbResults = this.stateDb.searchMemories(query, this.config.topK);
        for (const r of stateDbResults) {
          // Deduplicate by ID
          if (!results.some((existing) => existing.id === r.id)) {
            results.push({
              id: r.id,
              content: r.content,
              score: r.score,
              scope: "state_db",
            });
          }
        }
      } catch {
        // StateDb search failed, continue with MemoryStore results
      }
    }

    // Sort by score, take top K
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, this.config.topK);
  }

  /**
   * Update config at runtime (for hot-apply).
   */
  updateConfig(patch: Partial<ActiveMemoryRecallConfig>): void {
    Object.assign(this.config, patch);
  }
}
