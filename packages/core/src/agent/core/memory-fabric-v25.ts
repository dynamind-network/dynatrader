/**
 * Memory Fabric v2.5 — Unified Memory Interface
 *
 * Combines:
 * - Phase A: Heuristic-gated query rewriter (short referential follow-ups)
 * - Phase B: Sliding-window reflection segmentation (via ReflectionRunner)
 * - Phase C: Typed NOTE extraction (via ReflectionRunner)
 *
 * This module wraps the query rewriter and provides a clean interface
 * for the agent to search and write memories.
 */

import { QueryRewriter, type RewriteResult, type MessageHistoryEntry } from "./query-rewriter";
import type { MemoryStoreImpl } from "@dyna/memory-core";

export interface MemoryFabricConfig {
  /** Query rewriter config */
  rewriter?: QueryRewriterConfig;
  /** Memory store for persistence */
  memory: MemoryStoreImpl;
}

export type QueryRewriterConfig = import("./query-rewriter").QueryRewriterConfig;

export interface SearchContext {
  /** Original user query */
  originalQuery: string;
  /** Rewritten query (if rewritten) */
  rewrittenQuery: string;
  /** Whether rewriting occurred */
  wasRewritten: boolean;
  /** Recent conversation context used for rewriting */
  contextSource: string;
}

export interface MemorySearchResult {
  id: string;
  score: number;
  payload: {
    content?: string;
    kind?: string;
    [key: string]: unknown;
  };
  timestamp: Date;
}

/**
 * Unified memory interface with query rewriting and typed note support.
 */
export class MemoryFabric {
  private readonly queryRewriter: QueryRewriter;
  private readonly memory: MemoryStoreImpl;

  constructor(config: MemoryFabricConfig) {
    this.queryRewriter = new QueryRewriter(config.rewriter);
    this.memory = config.memory;
  }

  /**
   * Search memories with automatic query rewriting.
   * Short referential queries get expanded with context.
   */
  async search(query: string): Promise<MemorySearchResult[]> {
    const rewriteResult = this.queryRewriter.rewrite(query);

    const searchQuery = rewriteResult.rewritten;
    const results = await this.memory.search({ scope: "memory_fabric", text: searchQuery });

    return results.map((r) => ({
      ...r,
      score: r.score ?? 0,
      payload: r.payload as Record<string, unknown>,
    }));
  }

  /**
   * Get search context for debugging/logging.
   */
  getSearchContext(query: string): SearchContext {
    const rewriteResult = this.queryRewriter.rewrite(query);
    return {
      originalQuery: query,
      rewrittenQuery: rewriteResult.rewritten,
      wasRewritten: rewriteResult.wasRewritten,
      contextSource: rewriteResult.contextSource,
    };
  }

  /**
   * Record a message in the query rewriter's context window.
   */
  recordMessage(role: "user" | "assistant", content: string): void {
    this.queryRewriter.addMessage(role, content);
  }

  /**
   * Write a typed note to memory.
   * Typed notes are stored with metadata for filtering.
   */
  async writeNote(
    type: "event" | "behavior" | "knowledge" | "skill",
    content: string,
    options?: {
      confidence?: number;
      tags?: string[];
      turnNumber?: number;
    },
  ): Promise<void> {
    await this.memory.put({
      scope: "memory_fabric",
      kind: type,
      payload: {
        content,
        confidence: options?.confidence ?? 0.5,
        tags: options?.tags ?? [],
        turnNumber: options?.turnNumber,
      },
      ts: new Date(),
    });
  }

  /**
   * Search for specific note types.
   */
  async searchByType(
    type: "event" | "behavior" | "knowledge" | "skill",
    limit?: number,
  ): Promise<MemorySearchResult[]> {
    const results = await this.memory.search({ scope: "memory_fabric", text: `type:${type}` });
    return results.slice(0, limit ?? 10).map((r) => ({
      ...r,
      score: r.score ?? 0,
      payload: r.payload as Record<string, unknown>,
    }));
  }

  /**
   * Reset query rewriter context (on new session).
   */
  reset(): void {
    this.queryRewriter.reset();
  }
}
