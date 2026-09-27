/**
 * Context Compaction Engine
 *
 * Manages context window compression with two modes:
 * 1. Auto-compact: Triggers at 75% of context window capacity
 * 2. Dynamic compact: Hybrid scoring (keep recent + importance-based)
 *
 * Features:
 * - Pre-compaction memory flush to MEMORY.md
 * - Tool call pairing protection (tool_call + tool_result kept together)
 * - Recent tail budget (keeps N tokens intact)
 * - Manual compact via CLI
 * - Compaction history tracking
 */

import type { CompactionSink } from './types';
import type { StateDb } from '../state-db/state-db';
import { TokenCounter } from './token-counter';
import { MemoryScorer } from '../memory/memory-scorer';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompactionEngineConfig {
  /** Maximum context window size in tokens (default: 80000) */
  maxContextTokens: number;
  /** Percentage threshold to trigger auto-compact (default: 0.75 = 75%) */
  autoCompactThreshold: number;
  /** Tokens reserved for response (default: 4000) */
  reserveTokens: number;
  /** Number of recent messages to always keep intact (default: 10) */
  keepRecentMessages: number;
  /** Tokens to keep in the recent tail (default: 20000) */
  recentTailTokens: number;
  /** Whether to flush memory to MEMORY.md before compacting (default: true) */
  preCompactionFlush: boolean;
  /** Whether to protect tool call pairs (default: true) */
  protectToolPairs: boolean;
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

export interface CompactionResult {
  compressed: Message[];
  originalTokens: number;
  compressedTokens: number;
  tokensSaved: number;
  compressionRatio: number;
  messagesRemoved: number;
  summary: string;
  timestamp: Date;
  toolPairsProtected: number;
  recentMessagesKept: number;
}

export interface CompactionStats {
  totalCompactions: number;
  totalTokensSaved: number;
  averageCompressionRatio: number;
  lastCompactionAt: Date | null;
  autoCompactions: number;
  manualCompactions: number;
}

// ---------------------------------------------------------------------------
// Message Importance Scoring
// ---------------------------------------------------------------------------

interface ScoredMessage {
  message: Message;
  index: number;
  score: number;
  tokens: number;
  isToolPair: boolean;
  isRecent: boolean;
}

/**
 * ContextCompactionEngine manages context window compression.
 *
 * It monitors token usage and automatically compacts when approaching
 * the context limit, using hybrid scoring to preserve important messages.
 */
export class ContextCompactionEngine {
  private config: Required<CompactionEngineConfig>;
  private tokenCounter: TokenCounter;
  private stats: CompactionStats;
  private compactionHistory: CompactionResult[] = [];
  private maxHistorySize = 50;
  private db: StateDb | null;
  private sessionId: string | null;

  constructor(
    private sink: CompactionSink | null,
    config?: Partial<CompactionEngineConfig>,
    db?: StateDb,
    sessionId?: string,
  ) {
    this.config = {
      maxContextTokens: 80000,
      autoCompactThreshold: 0.75,
      reserveTokens: 4000,
      keepRecentMessages: 10,
      recentTailTokens: 20000,
      preCompactionFlush: true,
      protectToolPairs: true,
      ...config,
    };

    this.tokenCounter = new TokenCounter();
    this.db = db ?? null;
    this.sessionId = sessionId ?? null;
    this.stats = {
      totalCompactions: 0,
      totalTokensSaved: 0,
      averageCompressionRatio: 1,
      lastCompactionAt: null,
      autoCompactions: 0,
      manualCompactions: 0,
    };
    if (this.db) this.loadStatsFromDb();
  }

  private loadStatsFromDb(): void {
    if (!this.db) return;
    const rows = this.db.listCompactionRecords(this.sessionId ?? undefined, 50);
    for (const row of rows) {
      this.stats.totalCompactions++;
      this.stats.totalTokensSaved += row.tokens_before - row.tokens_after;
      if (row.tokens_before > 0) {
        const ratio = row.tokens_after / row.tokens_before;
        this.stats.averageCompressionRatio =
          (this.stats.averageCompressionRatio * (this.stats.totalCompactions - 1) + ratio) /
          this.stats.totalCompactions;
      }
      if (row.trigger_type === 'auto') this.stats.autoCompactions++;
      else this.stats.manualCompactions++;
    }
    if (rows.length > 0) {
      this.stats.lastCompactionAt = new Date(rows[0].created_at);
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Check if auto-compaction should trigger.
   */
  shouldAutoCompact(messages: Message[]): boolean {
    const totalTokens = this.tokenCounter.countMessages(
      messages.map((m) => ({ role: m.role, content: m.content })),
    );

    const effectiveLimit =
      this.config.maxContextTokens * this.config.autoCompactThreshold;

    return totalTokens >= effectiveLimit;
  }

  /**
   * Get current token usage for a message array.
   */
  getTokenUsage(messages: Message[]): {
    totalTokens: number;
    maxTokens: number;
    usagePercent: number;
    shouldCompact: boolean;
  } {
    const totalTokens = this.tokenCounter.countMessages(
      messages.map((m) => ({ role: m.role, content: m.content })),
    );

    const maxTokens = this.config.maxContextTokens;
    const usagePercent = totalTokens / maxTokens;
    const shouldCompact = this.shouldAutoCompact(messages);

    return { totalTokens, maxTokens, usagePercent, shouldCompact };
  }

  /**
   * Perform auto-compaction on messages.
   * Uses hybrid scoring: keeps recent messages + scores rest by importance.
   */
  async autoCompact(messages: Message[]): Promise<CompactionResult> {
    return this.compact(messages, 'auto');
  }

  /**
   * Perform manual compaction on messages.
   * Same logic as auto but tracked separately in stats.
   */
  async manualCompact(messages: Message[]): Promise<CompactionResult> {
    return this.compact(messages, 'manual');
  }

  /**
   * Core compaction logic.
   */
  private async compact(
    messages: Message[],
    trigger: 'auto' | 'manual',
  ): Promise<CompactionResult> {
    const startTime = Date.now();

    // 1. Pre-compaction memory flush
    if (this.config.preCompactionFlush) {
      await this.performMemoryFlush(messages);
    }

    // 2. Score all messages
    const scored = this.scoreMessages(messages);

    // 3. Identify tool call pairs to protect
    const protectedPairs = this.config.protectToolPairs
      ? this.findToolPairs(messages)
      : new Set<number>();

    // 4. Determine messages to keep vs compress
    const keepIndices = new Set<number>();

    // Always keep recent messages
    const recentStart = Math.max(0, messages.length - this.config.keepRecentMessages);
    for (let i = recentStart; i < messages.length; i++) {
      keepIndices.add(i);
    }

    // Always keep system messages
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'system') {
        keepIndices.add(i);
      }
    }

    // Preserve the latest user request even when a long tool/assistant tail pushes it
    // outside the recent-message window.
    let latestUserIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        latestUserIndex = i;
        break;
      }
    }
    if (latestUserIndex >= 0) {
      keepIndices.add(latestUserIndex);
    }

    // Keep protected tool pairs
    for (const idx of protectedPairs) {
      keepIndices.add(idx);
    }

    // 5. Calculate token budget for recent tail
    let recentTailTokenCount = 0;
    const recentTailIndices = new Set<number>();
    for (let i = messages.length - 1; i >= 0; i--) {
      const msgTokens = this.tokenCounter.count(
        JSON.stringify(messages[i]),
      );
      if (recentTailTokenCount + msgTokens > this.config.recentTailTokens) {
        break;
      }
      recentTailTokenCount += msgTokens;
      recentTailIndices.add(i);
    }

    // Merge recent tail into keep set
    for (const idx of recentTailIndices) {
      keepIndices.add(idx);
    }

    // 6. Score remaining messages and select for compression
    const toCompress: ScoredMessage[] = [];
    for (const s of scored) {
      if (!keepIndices.has(s.index)) {
        toCompress.push(s);
      }
    }

    // Sort by score (lowest first = compress first)
    toCompress.sort((a, b) => a.score - b.score);

    // 7. Build compressed result
    const compressed: Message[] = [];
    const keptMessages: Message[] = [];
    const compressedMessages: Message[] = [];

    for (let i = 0; i < messages.length; i++) {
      if (keepIndices.has(i)) {
        compressed.push(messages[i]);
        keptMessages.push(messages[i]);
      } else {
        compressedMessages.push(messages[i]);
      }
    }

    // 8. Create summary of compressed content
    const summary = this.createCompactionSummary(compressedMessages);

    // 9. Insert summary as system message if we compressed anything
    if (compressedMessages.length > 0) {
      const summaryMessage: Message = {
        role: 'system',
        content: `[Context Compaction] ${compressedMessages.length} messages summarized.\n\n${summary}`,
      };
      // Insert summary before the recent messages
      const insertIndex = Math.max(0, compressed.length - this.config.keepRecentMessages);
      compressed.splice(insertIndex, 0, summaryMessage);
    }

    // 10. Calculate metrics
    const originalTokens = this.tokenCounter.countMessages(
      messages.map((m) => ({ role: m.role, content: m.content })),
    );
    const compressedTokens = this.tokenCounter.countMessages(
      compressed.map((m) => ({ role: m.role, content: m.content })),
    );
    const tokensSaved = originalTokens - compressedTokens;
    const compressionRatio = compressedTokens / originalTokens;

    const result: CompactionResult = {
      compressed,
      originalTokens,
      compressedTokens,
      tokensSaved,
      compressionRatio,
      messagesRemoved: compressedMessages.length,
      summary,
      timestamp: new Date(),
      toolPairsProtected: protectedPairs.size,
      recentMessagesKept: recentTailIndices.size,
    };

    // 11. Update stats
    this.stats.totalCompactions++;
    this.stats.totalTokensSaved += tokensSaved;
    this.stats.averageCompressionRatio =
      (this.stats.averageCompressionRatio * (this.stats.totalCompactions - 1) +
        compressionRatio) /
      this.stats.totalCompactions;
    this.stats.lastCompactionAt = new Date();

    if (trigger === 'auto') {
      this.stats.autoCompactions++;
    } else {
      this.stats.manualCompactions++;
    }

    // 12. Store compaction record in memory
    await this.storeCompactionRecord(result);

    // 13. Add to history
    this.compactionHistory.push(result);
    if (this.compactionHistory.length > this.maxHistorySize) {
      this.compactionHistory.shift();
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Message Scoring (Hybrid: recency + importance)
  // ---------------------------------------------------------------------------

  /**
   * Score messages using hybrid scoring:
   * - Recency: newer messages get higher scores
   * - Importance: content-based importance detection
   * - Type: tool results scored differently than user messages
   */
  private scoreMessages(messages: Message[]): ScoredMessage[] {
    const scored: ScoredMessage[] = [];
    const totalTokens = this.tokenCounter.countMessages(
      messages.map((m) => ({ role: m.role, content: m.content })),
    );

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const msgTokens = this.tokenCounter.count(
        JSON.stringify(msg),
      );

      // Recency score (0-1, newer = higher)
      const recencyScore = i / messages.length;

      // Importance score based on content
      const importanceScore = this.calculateImportanceScore(msg);

      // Type score (system messages more important, tool results less)
      const typeScore = this.calculateTypeScore(msg);

      // Hybrid score (weighted combination)
      const score =
        recencyScore * 0.3 +
        importanceScore * 0.5 +
        typeScore * 0.2;

      scored.push({
        message: msg,
        index: i,
        score,
        tokens: msgTokens,
        isToolPair: false,
        isRecent: i >= messages.length - this.config.keepRecentMessages,
      });
    }

    return scored;
  }

  /**
   * Calculate importance score for a message based on content.
   */
  private calculateImportanceScore(msg: Message): number {
    return MemoryScorer.scoreContentImportance(msg.content);
  }

  /**
   * Calculate score based on message type.
   */
  private calculateTypeScore(msg: Message): number {
    switch (msg.role) {
      case 'system':
        return 0.9; // System messages are critical
      case 'user':
        return 0.7; // User messages are important
      case 'assistant':
        return 0.6; // Assistant messages moderate
      case 'tool':
        return 0.4; // Tool results often compressible
      default:
        return 0.5;
    }
  }

  // ---------------------------------------------------------------------------
  // Tool Call Pair Protection
  // ---------------------------------------------------------------------------

  /**
   * Find tool call/result pairs that should be kept together.
   * Returns set of indices that are part of a tool pair.
   */
  private findToolPairs(messages: Message[]): Set<number> {
    const protectedIndices = new Set<number>();

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      // If this is an assistant message with tool_calls
      if (msg.role === 'assistant' && msg.tool_calls?.length) {
        const toolCallIds = new Set(msg.tool_calls.map((tc) => tc.id));

        // Mark this message as protected
        protectedIndices.add(i);

        // Find and protect the corresponding tool result messages
        for (let j = i + 1; j < messages.length; j++) {
          const nextMsg = messages[j];
          if (
            nextMsg.role === 'tool' &&
            nextMsg.tool_call_id &&
            toolCallIds.has(nextMsg.tool_call_id)
          ) {
            protectedIndices.add(j);
          }
        }
      }
    }

    return protectedIndices;
  }

  // ---------------------------------------------------------------------------
  // Pre-Compaction Memory Flush
  // ---------------------------------------------------------------------------

  /**
   * Flush important context to the persistence sink before compaction.
   * This ensures critical information survives the compaction.
   */
  private async performMemoryFlush(messages: Message[]): Promise<void> {
    try {
      if (!this.sink) return;

      // Extract important messages from the context
      const importantMessages = this.extractImportantMessages(messages);

      if (importantMessages.length === 0) return;

      // Build flush content
      const flushContent = this.buildFlushContent(importantMessages);

      await this.sink.write({
        scope: 'context_compaction',
        kind: 'memory_flush',
        payload: {
          type: 'pre_compaction_flush',
          messageCount: importantMessages.length,
          content: flushContent,
          timestamp: new Date().toISOString(),
        },
        timestamp: new Date(),
      });
    } catch (err) {
      // Log error but don't fail compaction
      console.error('Memory flush failed:', err);
    }
  }

  /**
   * Extract important messages that should be preserved.
   */
  private extractImportantMessages(messages: Message[]): Message[] {
    const important: Message[] = [];

    for (const msg of messages) {
      const score = this.calculateImportanceScore(msg);
      if (score > 0.7) {
        important.push(msg);
      }
    }

    return important.slice(0, 20); // Limit to 20 most important
  }

  /**
   * Build content for memory flush.
   */
  private buildFlushContent(messages: Message[]): string {
    const lines: string[] = ['## Pre-Compaction Memory Flush', ''];

    for (const msg of messages) {
      const content = msg.content.substring(0, 500); // Truncate long messages
      lines.push(`### ${msg.role.toUpperCase()}`);
      lines.push(content);
      lines.push('');
    }

    return lines.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Compaction Summary
  // ---------------------------------------------------------------------------

  /**
   * Create a summary of messages being compressed.
   */
  private createCompactionSummary(messages: Message[]): string {
    if (messages.length === 0) return 'No messages compressed.';

    const lines: string[] = [];
    lines.push(`Compressed ${messages.length} messages:`);

    // Count by role
    const roleCounts = new Map<string, number>();
    for (const msg of messages) {
      roleCounts.set(msg.role, (roleCounts.get(msg.role) || 0) + 1);
    }

    for (const [role, count] of roleCounts) {
      lines.push(`- ${role}: ${count} messages`);
    }

    // Extract key topics
    const topics = this.extractTopics(messages);
    if (topics.length > 0) {
      lines.push('');
      lines.push('Key topics preserved:');
      for (const topic of topics.slice(0, 5)) {
        lines.push(`- ${topic}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Extract key topics from messages.
   */
  private extractTopics(messages: Message[]): string[] {
    const topics = new Map<string, number>();

    for (const msg of messages) {
      const content = msg.content.toLowerCase();

      // Detect common trading topics
      if (content.includes('bitcoin') || content.includes('btc')) {
        topics.set('Bitcoin/BTC', (topics.get('Bitcoin/BTC') || 0) + 1);
      }
      if (content.includes('ethereum') || content.includes('eth')) {
        topics.set('Ethereum/ETH', (topics.get('Ethereum/ETH') || 0) + 1);
      }
      if (content.includes('strategy')) {
        topics.set('Strategy', (topics.get('Strategy') || 0) + 1);
      }
      if (content.includes('risk')) {
        topics.set('Risk', (topics.get('Risk') || 0) + 1);
      }
      if (content.includes('market')) {
        topics.set('Market', (topics.get('Market') || 0) + 1);
      }
    }

    // Sort by frequency
    return Array.from(topics.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([topic]) => topic);
  }

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------

  /**
   * Store compaction record via the persistence sink.
   */
  private async storeCompactionRecord(result: CompactionResult): Promise<void> {
    try {
      if (this.sink) {
        await this.sink.write({
          scope: 'context_compaction',
          kind: 'compaction_record',
          payload: {
            originalTokens: result.originalTokens,
            compressedTokens: result.compressedTokens,
            tokensSaved: result.tokensSaved,
            compressionRatio: result.compressionRatio,
            messagesRemoved: result.messagesRemoved,
            toolPairsProtected: result.toolPairsProtected,
            recentMessagesKept: result.recentMessagesKept,
          },
          timestamp: new Date(),
        });
      }

      if (this.db) {
        this.db.saveCompactionRecord({
          id: `comp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          session_id: this.sessionId,
          trigger_type: result.messagesRemoved > 0 ? 'auto' : 'manual',
          tokens_before: result.originalTokens,
          tokens_after: result.compressedTokens,
          summary: JSON.stringify({
            goal: 'context compaction',
            instructions: result.summary,
            discoveries: [],
            accomplished: [`${result.messagesRemoved} messages compressed, ${result.tokensSaved} tokens saved`],
            relevantFiles: [],
          }),
          created_at: Date.now(),
        });
      }
    } catch (err) {
      console.error('Failed to store compaction record:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Getters
  // ---------------------------------------------------------------------------

  /**
   * Get compaction statistics.
   */
  getStats(): CompactionStats {
    return { ...this.stats };
  }

  /**
   * Get compaction history.
   */
  getHistory(): CompactionResult[] {
    return [...this.compactionHistory];
  }

  /**
   * Get current configuration.
   */
  getConfig(): Readonly<Required<CompactionEngineConfig>> {
    return { ...this.config };
  }

  /**
   * Update configuration at runtime.
   */
  updateConfig(config: Partial<CompactionEngineConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.stats = {
      totalCompactions: 0,
      totalTokensSaved: 0,
      averageCompressionRatio: 1,
      lastCompactionAt: null,
      autoCompactions: 0,
      manualCompactions: 0,
    };
    this.compactionHistory = [];
  }
}
