/**
 * Context Engine
 *
 * Manages agent context, memory compression, and recall.
 * Supports compaction with automatic context limits,
 * identifier preservation, memory flush, and configurable behavior.
 */

import type { MemoryStore, AgentTurnContext } from "@dyna/contracts";

export interface ContextCompressionConfig {
  maxMemoryAge: number; // milliseconds
  maxContextSize: number;
  similarityThreshold: number;
  compressionRatio: number;
}

/**
 * Compaction configuration.
 * Controls when and how context compaction triggers, what gets preserved,
 * and how identifiers are handled in summaries.
 */
export interface CompactionConfig {
  /** Max estimated tokens before auto-compaction triggers (default 80000) */
  maxContextTokens: number;
  /** Keep this many tokens reserved for the response (default 4000) */
  reserveTokens: number;
  /** How many recent history turns to keep intact (default 5) */
  keepRecentTurns: number;
  /** Whether to save important notes to persistent memory before compaction (default true) */
  memoryFlushEnabled: boolean;
  /** Default instruction for what content to save during memory flush */
  memoryFlushPrompt: string;
  /** How to handle opaque identifiers in compaction summaries */
  identifierPolicy: "strict" | "off" | "custom";
  /** Optional separate model identifier to use for compaction (undefined = use primary) */
  compactionModel: string | undefined;
  /** Maximum active transcript bytes before triggering byte-guard logic (default 5MB) */
  maxActiveTranscriptBytes: number;
}

const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  maxContextTokens: 80000,
  reserveTokens: 4000,
  keepRecentTurns: 5,
  memoryFlushEnabled: true,
  memoryFlushPrompt:
    "Before compaction, save any important notes, decisions, and context identifiers to persistent memory.",
  identifierPolicy: "strict",
  compactionModel: undefined,
  maxActiveTranscriptBytes: 5 * 1024 * 1024, // 5MB
};

export interface MemoryChunk {
  id: string;
  type: "trade" | "strategy" | "risk" | "market" | "agent";
  content: unknown;
  timestamp: Date;
  importance: number;
  tags: string[];
  compressed?: boolean;
}

export interface ContextState {
  current: AgentTurnContext;
  history: Array<{
    context: AgentTurnContext;
    actions: unknown[];
    outcomes: unknown[];
  }>;
  memoryChunks: MemoryChunk[];
  summary: string;
}

// UUID pattern for identifier extraction
const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// Opaque ID patterns (chunk-xxx, iteration-xxx, event-xxx, id:xxx)
const OPAQUE_ID_PATTERN =
  /(?:chunk|iteration|event|memory|session|correlation|account|portfolio|approval|order)-[a-z0-9]+/gi;

export class ContextEngine {
  private memory: MemoryStore;
  private config: ContextCompressionConfig;
  private compactionConfig: CompactionConfig;
  private contextHistory: ContextState[] = [];
  private currentContext?: ContextState;

  constructor(
    memory: MemoryStore,
    config: Partial<ContextCompressionConfig> = {},
    compactionConfig?: Partial<CompactionConfig>,
  ) {
    this.memory = memory;
    this.config = {
      maxMemoryAge: 24 * 60 * 60 * 1000, // 24 hours
      maxContextSize: 100,
      similarityThreshold: 0.8,
      compressionRatio: 0.3,
      ...config,
    };
    this.compactionConfig = {
      ...DEFAULT_COMPACTION_CONFIG,
      ...compactionConfig,
    };
  }

  /**
   * Create new context state
   */
  async createContext(context: AgentTurnContext): Promise<ContextState> {
    const state: ContextState = {
      current: context,
      history: [],
      memoryChunks: [],
      summary: await this.generateInitialSummary(context),
    };

    this.currentContext = state;
    this.contextHistory.push(state);

    return state;
  }

  /**
   * Update context with new information.
   * Automatically triggers compaction if approaching token limit.
   */
  async updateContext(
    updates: Partial<AgentTurnContext>,
    actions: unknown[] = [],
    outcomes: unknown[] = [],
  ): Promise<ContextState> {
    if (!this.currentContext) {
      throw new Error("No current context to update");
    }

    // Update context
    this.currentContext.current = {
      ...this.currentContext.current,
      ...updates,
    };

    // Add to history
    this.currentContext.history.push({
      context: this.currentContext.current,
      actions,
      outcomes,
    });

    // Auto-compaction check before memory compression
    if (this.shouldCompact()) {
      await this.compact();
    }

    // Compress and update memory
    await this.compressMemory();

    // Update summary
    this.currentContext.summary = await this.generateUpdatedSummary();

    return this.currentContext;
  }

  /**
   * Check if the current context exceeds the token limit and needs compaction.
   * Estimates tokens from the serialized context size (chars / 4).
   * Also checks the active transcript byte guard.
   */
  shouldCompact(): boolean {
    if (!this.currentContext) return false;

    const estimatedTokens = this.estimateTokens();
    const transcriptBytes = this.estimateTranscriptBytes();

    // Check token limit (reserve response tokens)
    const effectiveLimit =
      this.compactionConfig.maxContextTokens - this.compactionConfig.reserveTokens;

    if (estimatedTokens >= effectiveLimit) {
      return true;
    }

    // Check active transcript byte guard
    if (transcriptBytes >= this.compactionConfig.maxActiveTranscriptBytes) {
      return true;
    }

    return false;
  }

  /**
   * Perform compaction on the current context.
   *
   * 1. Saves memory flush turn (important notes to disk)
   * 2. Identifies older turns to summarize
   * 3. Creates compaction summary preserving identifiers
   * 4. Keeps recent N turns intact
   * 5. Updates context state
   */
  async compact(): Promise<void> {
    if (!this.currentContext) return;
    if (this.currentContext.history.length <= this.compactionConfig.keepRecentTurns) {
      // Not enough history to compact meaningfully
      return;
    }

    // 1. Memory flush: save important notes before compaction
    if (this.compactionConfig.memoryFlushEnabled) {
      await this.performMemoryFlush();
    }

    // 2. Identify older turns to compact (everything except last N)
    const keepCount = this.compactionConfig.keepRecentTurns;
    const oldEntries = this.currentContext.history.slice(
      0,
      this.currentContext.history.length - keepCount,
    );
    const recentEntries = this.currentContext.history.slice(
      this.currentContext.history.length - keepCount,
    );

    // 3. Create compaction summary preserving identifiers
    const summary = this.createCompactionSummary(oldEntries);

    // 4. Build the compacted history entry
    const compactedEntry = {
      context: { ...this.currentContext.current },
      actions: ["compaction: summarized " + oldEntries.length + " turns"],
      outcomes: [{ compactionSummary: summary }],
    };

    // 5. Replace old entries with the single compaction entry, keeping recent ones
    this.currentContext.history = [compactedEntry, ...recentEntries];

    // Store compaction record in memory for traceability
    await this.memory.put({
      scope: "agent_memory",
      kind: "compaction_event",
      payload: {
        type: "compaction",
        oldEntriesCount: oldEntries.length,
        preservedIdentifiers: this.extractIdentifiers(
          oldEntries.map((e) => JSON.stringify(e)),
        ),
        summaryText: summary.substring(0, 500),
        timestamp: new Date().toISOString(),
      },
      ts: new Date(),
    });
  }

  /**
   * Add memory chunk
   */
  async addMemoryChunk(chunk: Omit<MemoryChunk, "id">): Promise<string> {
    if (!this.currentContext) {
      throw new Error("No current context to add memory to");
    }

    const memoryChunk: MemoryChunk = {
      ...chunk,
      id: `chunk-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    };

    this.currentContext.memoryChunks.push(memoryChunk);

    // Store in memory
    await this.memory.put({
      scope: "agent_memory",
      kind: "memory_chunk",
      payload: memoryChunk,
      ts: new Date(),
    });

    return memoryChunk.id;
  }

  /**
   * Get relevant memories for context
   */
  async getRelevantMemories(
    query: string,
    limit: number = 10,
  ): Promise<MemoryChunk[]> {
    const searchResults = await this.memory.search({
      scope: "agent_memory",
      text: query,
      topK: limit * 2, // Get more to allow for filtering
    });

    // Convert to MemoryChunk objects
    const memories: MemoryChunk[] = searchResults.map((result) => ({
      id: result.id,
      type: "agent" as const, // Default type
      content: result.payload,
      timestamp: result.timestamp ?? new Date(),
      importance: Math.max(0.1, Math.min(1, result.score)),
      tags: [] as string[],
    }));

    // Filter by age and importance
    const filtered = memories.filter((memory) => {
      const age = Date.now() - memory.timestamp.getTime();
      return age < this.config.maxMemoryAge;
    });

    // Sort by importance and timestamp
    return filtered
      .sort((a, b) => {
        // Primary sort by importance
        if (a.importance !== b.importance) {
          return b.importance - a.importance;
        }
        // Secondary sort by recency
        return b.timestamp.getTime() - a.timestamp.getTime();
      })
      .slice(0, limit);
  }

  /**
   * Compress old memories with compaction-aware logic.
   * Before grouping old memories, runs memory flush if enabled.
   * Preserves identifiers in compressed summaries.
   */
  private async compressMemory(): Promise<void> {
    if (!this.currentContext) return;

    const cutoffTime = new Date(Date.now() - this.config.maxMemoryAge);
    const oldMemories = this.currentContext.memoryChunks.filter(
      (chunk) => chunk.timestamp < cutoffTime,
    );

    if (oldMemories.length === 0) return;

    // Run memory flush for old memories being compressed away
    if (this.compactionConfig.memoryFlushEnabled) {
      await this.performMemoryFlush();
    }

    // Group similar memories
    const groups = this.groupSimilarMemories(oldMemories);

    // Create compressed summaries
    for (const group of groups) {
      const rawSummary = await this.summarizeMemoryGroup(group);
      const summary =
        this.compactionConfig.identifierPolicy !== "off"
          ? this.createIdentifierPreservingSummary(group, rawSummary)
          : rawSummary;

      // Add compressed memory chunk
      await this.addMemoryChunk({
        type: "agent",
        content: summary,
        timestamp: new Date(),
        importance:
          Math.max(...group.map((m) => m.importance)) * 0.7, // Slightly reduce importance
        tags: [...new Set(group.flatMap((m) => m.tags))].concat("compressed"),
        compressed: true,
      });
    }

    // Remove old uncompressed memories
    this.currentContext.memoryChunks = this.currentContext.memoryChunks.filter(
      (chunk) => chunk.timestamp >= cutoffTime || chunk.compressed,
    );

    // Limit total size
    if (
      this.currentContext.memoryChunks.length > this.config.maxContextSize
    ) {
      const toKeep = Math.floor(
        this.currentContext.memoryChunks.length * this.config.compressionRatio,
      );
      this.currentContext.memoryChunks = this.currentContext.memoryChunks
        .sort((a, b) => b.importance - a.importance)
        .slice(0, toKeep);
    }
  }

  /**
   * Generate initial context summary
   */
  private async generateInitialSummary(
    context: AgentTurnContext,
  ): Promise<string> {
    const memories = await this.getRelevantMemories(context.mode.toString());
    let summary = `Trading context initialized in ${context.mode} mode for account ${context.accountId}. Portfolio: ${context.portfolioId}. Correlation ID: ${context.correlationId}.`;

    if (memories.length > 0) {
      summary += ` Found ${memories.length} relevant memory chunks.`;
    }

    return summary;
  }

  /**
   * Generate updated context summary
   */
  private async generateUpdatedSummary(): Promise<string> {
    if (!this.currentContext) return "";

    const { current, history, memoryChunks } = this.currentContext;
    const recentHistory = history.slice(-5); // Last 5 actions
    const importantMemories = memoryChunks
      .filter((m) => m.importance > 0.7)
      .slice(0, 3);

    let summary = `Current mode: ${current.mode}. Account: ${current.accountId}. `;
    summary += `History actions: ${recentHistory.length}. `;
    summary += `Important memories: ${importantMemories.length}. `;

    if (importantMemories.length > 0) {
      summary += `Key memories: ${importantMemories.map((m) => m.type).join(", ")}.`;
    }

    return summary;
  }

  /**
   * Group similar memories
   */
  private groupSimilarMemories(memories: MemoryChunk[]): MemoryChunk[][] {
    const groups: MemoryChunk[][] = [];
    const used = new Set<string>();

    for (const memory of memories) {
      if (used.has(memory.id)) continue;

      const group = [memory];
      used.add(memory.id);

      // Find similar memories
      for (const other of memories) {
        if (used.has(other.id)) continue;

        if (
          this.calculateSimilarity(memory, other) >
          this.config.similarityThreshold
        ) {
          group.push(other);
          used.add(other.id);
        }
      }

      groups.push(group);
    }

    return groups;
  }

  /**
   * Calculate similarity between two memory chunks
   */
  private calculateSimilarity(a: MemoryChunk, b: MemoryChunk): number {
    // Simple similarity calculation based on type and tags
    let score = 0;

    // Type similarity
    if (a.type === b.type) score += 0.4;

    // Tag overlap
    const commonTags = a.tags.filter((tag) => b.tags.includes(tag));
    if (a.tags.length > 0 && b.tags.length > 0) {
      score +=
        (commonTags.length / Math.max(a.tags.length, b.tags.length)) * 0.4;
    }

    // Time proximity (recent memories are more similar)
    const timeDiff = Math.abs(
      a.timestamp.getTime() - b.timestamp.getTime(),
    );
    const timeScore = Math.max(
      0,
      1 - timeDiff / (24 * 60 * 60 * 1000),
    ); // Within 24 hours
    score += timeScore * 0.2;

    return score;
  }

  /**
   * Summarize a group of memories
   */
  private async summarizeMemoryGroup(group: MemoryChunk[]): Promise<string> {
    const content = group.map((m) => JSON.stringify(m.content)).join(", ");

    // In a real implementation, this would use an LLM to summarize
    return `Compressed memory group (${group.length} items): ${content.substring(0, 200)}...`;
  }

  /**
   * Get current context state
   */
  getCurrentContext(): ContextState | undefined {
    return this.currentContext;
  }

  /**
   * Get context history
   */
  getContextHistory(): ContextState[] {
    return [...this.contextHistory];
  }

  /**
   * Reset context
   */
  async resetContext(): Promise<void> {
    this.currentContext = undefined;
    this.contextHistory = [];
    await this.memory.compact({ scope: "agent_memory" });
  }

  /**
   * Get the current compaction configuration (for inspection/testing)
   */
  getCompactionConfig(): CompactionConfig {
    return { ...this.compactionConfig };
  }

  /**
   * Update the compaction window at runtime.
   */
  updateContextWindowTokens(maxContextTokens: number): void {
    if (!Number.isFinite(maxContextTokens) || maxContextTokens <= 0) {
      return;
    }
    this.compactionConfig.maxContextTokens = Math.floor(maxContextTokens);
  }

  // ---------------------------------------------------------------------------
  // Private: Compaction helpers
  // ---------------------------------------------------------------------------

  /**
   * Estimate the token count of the current context.
   * Uses a simple heuristic: characters / 4 (common approximation).
   */
  private estimateTokens(): number {
    if (!this.currentContext) return 0;

    const currentStr = JSON.stringify(this.currentContext.current);
    const historyStr = JSON.stringify(this.currentContext.history);
    const chunksStr = JSON.stringify(this.currentContext.memoryChunks);
    const summaryStr = this.currentContext.summary;

    const totalChars =
      currentStr.length +
      historyStr.length +
      chunksStr.length +
      summaryStr.length;

    return Math.ceil(totalChars / 4);
  }

  /**
   * Estimate the byte size of the active transcript (current context + history).
   */
  private estimateTranscriptBytes(): number {
    if (!this.currentContext) return 0;

    const currentStr = JSON.stringify(this.currentContext.current);
    const historyStr = JSON.stringify(this.currentContext.history);

    // Rough byte estimate (UTF-8: 1 byte per ASCII char, more for multi-byte)
    // Using Buffer.byteLength for accuracy would require Node/Bun Buffer import,
    // so we estimate with a 1:1 ratio for ASCII-heavy text
    return currentStr.length + historyStr.length;
  }

  /**
   * Create a compaction summary for old history entries.
   * Includes counts, types of actions, and preserved identifiers.
   */
  private createCompactionSummary(
    entries: Array<{
      context: AgentTurnContext;
      actions: unknown[];
      outcomes: unknown[];
    }>,
  ): string {
    if (entries.length === 0) return "";

    const actionCount = entries.reduce(
      (sum, e) => sum + e.actions.length,
      0,
    );
    const outcomeCount = entries.reduce(
      (sum, e) => sum + e.outcomes.length,
      0,
    );
    const actionTypes = [
      ...new Set(entries.flatMap((e) => e.actions.map((a) => typeof a === "string" ? a : "object"))),
    ];

    // Extract all identifiers from the entries
    const allTexts = entries.map((e) => JSON.stringify(e));
    const identifiers = this.extractIdentifiers(allTexts);

    let summary = `Compacted ${entries.length} turns (${actionCount} actions, ${outcomeCount} outcomes). `;
    summary += `Action types: ${actionTypes.join(", ")}. `;

    if (identifiers.length > 0 && this.compactionConfig.identifierPolicy !== "off") {
      summary += `Preserved IDs: ${identifiers.join(", ")}.`;
    }

    return summary;
  }

  /**
   * Extract opaque identifiers from an array of text strings.
   * Matches UUIDs and common opaque ID patterns.
   */
  private extractIdentifiers(texts: string[]): string[] {
    const ids = new Set<string>();
    const combined = texts.join(" ");

    // Extract UUIDs
    const uuidMatches = combined.match(UUID_PATTERN);
    if (uuidMatches) {
      uuidMatches.forEach((id) => ids.add(id));
    }

    // Extract opaque IDs (chunk-xxx, iteration-xxx, etc.)
    const opaqueMatches = combined.match(OPAQUE_ID_PATTERN);
    if (opaqueMatches) {
      opaqueMatches.forEach((id) => ids.add(id));
    }

    return Array.from(ids).slice(0, 20); // Limit to 20 identifiers
  }

  /**
   * Create a summary that preserves identifiers from the memory group.
   */
  private createIdentifierPreservingSummary(
    group: MemoryChunk[],
    summary: string,
  ): string {
    if (this.compactionConfig.identifierPolicy === "off") {
      return summary;
    }

    const texts = group.map((m) => JSON.stringify(m.content));
    const identifiers = this.extractIdentifiers(texts);

    if (identifiers.length === 0) return summary;

    return `${summary} [IDs: ${identifiers.join(", ")}]`;
  }

  /**
   * Save important notes to persistent memory before compaction.
   * Writes a summary of the current context state to the MemoryStore.
   */
  private async performMemoryFlush(): Promise<void> {
    if (!this.currentContext) return;

    const { current, history, memoryChunks, summary } = this.currentContext;

    // Collect important identifiers
    const allTexts = [
      JSON.stringify(current),
      JSON.stringify(history.slice(-5)), // Last 5 entries
      summary,
    ];
    const identifiers = this.extractIdentifiers(allTexts);

    // Build a snapshot of important context
    const flushPayload = {
      type: "memory_flush",
      summary,
      mode: current.mode,
      accountId: current.accountId,
      portfolioId: current.portfolioId,
      correlationId: current.correlationId,
      historyCount: history.length,
      importantChunks: memoryChunks
        .filter((m) => m.importance > 0.7)
        .map((m) => ({
          type: m.type,
          importance: m.importance,
          tags: m.tags,
          content: m.content,
        })),
      preservedIdentifiers: identifiers,
      flushTimestamp: new Date().toISOString(),
      compactionLimit: this.compactionConfig.maxContextTokens,
    };

    await this.memory.put({
      scope: "agent_memory",
      kind: "memory_flush",
      payload: flushPayload,
      ts: new Date(),
    });
  }
}
