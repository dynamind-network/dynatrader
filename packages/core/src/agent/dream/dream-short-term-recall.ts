/**
 * Dream Cycle — Short-Term Recall Store
 *
 * In-memory buffer for recent observations that serve as candidates
 * for the dreaming pipeline.
 *
 * Maintains a separate buffer from main memory. After each dream cycle
 * completes, the buffer is cleared. Entries that survive taint-gating
 * and scoring are promoted to durable memory.
 */

import { MemoryScorer } from '../../memory/memory-scorer';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ShortTermEntrySource = 'insight' | 'trade' | 'decision' | 'error' | 'observation';

export type ShortTermStagedPhase = 'taint-gate' | 'scoring' | 'promotion' | 'discarded';

export interface ShortTermEntry {
  id: string;
  content: string;
  source: ShortTermEntrySource;
  timestamp: number;
  metadata: Record<string, unknown>;
  /** Dreaming promotion score (0-1), set by scoreEntry(). */
  dreamScore?: number;
  /** Which dream phase this entry has been staged in, if any. */
  stagedInPhase?: ShortTermStagedPhase;
}

export interface ShortTermRecallConfig {
  /** Maximum entries held in the buffer (oldest evicted first). */
  maxEntries: number;
  /** Maximum age of an entry in ms before it expires. */
  maxAgeMs: number;
  /** Minimum dreamScore for an entry to be promotable to durable memory. */
  promotionThreshold: number;
}

export const DEFAULT_SHORT_TERM_RECALL_CONFIG: ShortTermRecallConfig = {
  maxEntries: 500,
  maxAgeMs: 24 * 60 * 60 * 1000,
  promotionThreshold: 0.6,
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class ShortTermRecallStore {
  private buffer: ShortTermEntry[] = [];
  private config: Required<ShortTermRecallConfig>;

  constructor(config: Partial<ShortTermRecallConfig> = {}) {
    this.config = { ...DEFAULT_SHORT_TERM_RECALL_CONFIG, ...config };
  }

  /**
   * Add an entry to the buffer. Evicts the oldest entries when over capacity.
   */
  add(
    content: string,
    source: ShortTermEntrySource,
    metadata: Record<string, unknown> = {},
  ): ShortTermEntry {
    const entry: ShortTermEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      content,
      source,
      timestamp: Date.now(),
      metadata,
    };

    this.buffer.push(entry);

    if (this.buffer.length > this.config.maxEntries) {
      this.buffer.sort((a, b) => a.timestamp - b.timestamp);
      this.buffer = this.buffer.slice(-this.config.maxEntries);
    }

    return entry;
  }

  /**
   * Get all live (non-expired) entries as dreaming candidates.
   */
  getCandidates(): ShortTermEntry[] {
    this.pruneExpired();
    return [...this.buffer];
  }

  /**
   * Get live entries filtered by source type.
   */
  getCandidatesBySource(source: ShortTermEntrySource): ShortTermEntry[] {
    return this.getCandidates().filter((entry) => entry.source === source);
  }

  /**
   * Score an entry for dreaming promotion (0-1), combining recency,
   * source weight, and metadata richness.
   */
  scoreEntry(entry: ShortTermEntry): number {
    const ageScore = MemoryScorer.scoreAge(entry.timestamp, this.config.maxAgeMs);

    const sourceWeights: Record<ShortTermEntrySource, number> = {
      insight: 0.9,
      trade: 0.8,
      decision: 0.7,
      error: 0.6,
      observation: 0.5,
    };
    const sourceScore = sourceWeights[entry.source] ?? 0.5;

    const metadataRichness = MemoryScorer.scoreMetadataRichness(entry.metadata);

    const score = ageScore * 0.4 + sourceScore * 0.35 + metadataRichness * 0.25;
    entry.dreamScore = Math.round(score * 100) / 100;
    return entry.dreamScore;
  }

  /**
   * Get entries that should be promoted to durable memory.
   */
  getPromotable(): ShortTermEntry[] {
    const candidates = this.getCandidates();
    for (const entry of candidates) {
      this.scoreEntry(entry);
    }
    return candidates.filter((entry) => (entry.dreamScore ?? 0) >= this.config.promotionThreshold);
  }

  /**
   * Mark an entry as staged in a specific dream phase.
   */
  markStaged(entryId: string, phase: ShortTermStagedPhase): void {
    const entry = this.buffer.find((candidate) => candidate.id === entryId);
    if (entry) {
      entry.stagedInPhase = phase;
    }
  }

  /**
   * Remove expired entries from the buffer.
   */
  pruneExpired(): void {
    const cutoff = Date.now() - this.config.maxAgeMs;
    this.buffer = this.buffer.filter((entry) => entry.timestamp >= cutoff);
  }

  /**
   * Current number of live entries.
   */
  size(): number {
    this.pruneExpired();
    return this.buffer.length;
  }

  /**
   * Clear the buffer after a dream cycle completes.
   */
  clear(): void {
    this.buffer = [];
  }
}
