/**
 * CrossSessionRecall
 *
 * Provides FTS5-style text search across trading sessions using token
 * overlap scoring. Entries are persisted to the memory store for durability
 * across restarts.
 */

import type { MemoryStoreImpl } from "@dyna/memory-core";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RECALL_SCOPE = "cross_session_recall";
const TOP_RESULTS = 20;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IndexedEntry {
  sessionId: string;
  text: string;
  tokens: string[];
  timestamp: number;
}

// ---------------------------------------------------------------------------
// CrossSessionRecall
// ---------------------------------------------------------------------------

export class CrossSessionRecall {
  private memory: MemoryStoreImpl;
  private entries: IndexedEntry[] = [];
  private loadedFromMemory = false;

  constructor(memory: MemoryStoreImpl) {
    this.memory = memory;
  }

  /**
   * Index a text fragment from a session for future recall.
   * Persists the entry to the memory store for durability.
   */
  async index(sessionId: string, text: string): Promise<void> {
    if (!text.trim()) return;
    const tokens = this.tokenize(text);
    if (tokens.length === 0) return;
    const entry: IndexedEntry = {
      sessionId,
      text,
      tokens,
      timestamp: Date.now(),
    };

    this.entries.push(entry);

    await this.memory.put({
      scope: RECALL_SCOPE,
      kind: "recall_entry",
      payload: {
        sessionId,
        text,
        tokens,
        timestamp: entry.timestamp,
      },
      ts: new Date(entry.timestamp),
    });
  }

  /**
   * Search across all indexed sessions by relevance (token overlap scoring).
   * Returns results sorted by descending relevance score.
   */
  async search(
    query: string,
    excludeSessionId?: string,
  ): Promise<Array<{ sessionId: string; text: string; score: number }>> {
    await this.loadFromMemory();
    const queryTokens = this.tokenize(query);

    if (queryTokens.length === 0) {
      return [];
    }

    // Compute relevance scores
    const scored = this.entries
      .map((entry) => ({
        sessionId: entry.sessionId,
        text: entry.text,
        score: this.computeRelevance(queryTokens, entry.tokens),
      }))
      .filter((result) => result.score > 0 && result.sessionId !== excludeSessionId);

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, TOP_RESULTS);
  }

  /**
   * Load persisted entries from the memory store back into the local index.
   * Useful after restart to restore previously indexed sessions.
   */
  async loadFromMemory(): Promise<void> {
    if (this.loadedFromMemory) return;
    try {
      const results = await this.memory.search({
        scope: RECALL_SCOPE,
        text: "",
        topK: 500,
      });

      for (const result of results) {
        const payload = result.payload as Record<string, unknown>;
        if (
          payload &&
          typeof payload === "object" &&
          "sessionId" in payload &&
          "text" in payload &&
          "tokens" in payload &&
          "timestamp" in payload
        ) {
          // Avoid duplicates
          const alreadyExists = this.entries.some(
            (e) =>
              e.sessionId === payload.sessionId &&
              e.text === payload.text &&
              e.timestamp === payload.timestamp,
          );

          if (!alreadyExists) {
            this.entries.push({
              sessionId: payload.sessionId as string,
              text: payload.text as string,
              tokens: payload.tokens as string[],
              timestamp: payload.timestamp as number,
            });
          }
        }
      }
      this.loadedFromMemory = true;
    } catch {
      // Memory may not have entries yet; that's fine
    }
  }

  /**
   * Tokenize text: lowercase, remove non-alphanumeric, split on whitespace,
   * filter tokens <= 2 characters.
   */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2);
  }

  /**
   * Compute relevance as the ratio of overlapping tokens to the larger
   * token set size.
   *
   * score = |queryTokens ∩ docTokens| / max(|queryTokens|, |docTokens|)
   */
  private computeRelevance(queryTokens: string[], docTokens: string[]): number {
    const querySet = new Set(queryTokens);
    const docSet = new Set(docTokens);

    let intersection = 0;
    for (const token of querySet) {
      if (docSet.has(token)) {
        intersection++;
      }
    }

    const maxSetSize = Math.max(querySet.size, docSet.size);
    if (maxSetSize === 0) {
      return 0;
    }

    return intersection / maxSetSize;
  }
}
