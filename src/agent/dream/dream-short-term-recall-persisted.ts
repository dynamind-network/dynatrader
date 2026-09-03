/**
 * Persisted Short-Term Recall Store
 *
 * Extends the in-memory ShortTermRecallStore with SQLite persistence.
 * Survives process restarts for long-running trading sessions.
 *
 * Pattern from Hermes: background sync + persistence layer.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { MemoryScorer } from '../../memory/memory-scorer';
import type { ShortTermEntry, ShortTermRecallConfig } from './dream-short-term-recall';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersistedShortTermConfig extends ShortTermRecallConfig {
  /** SQLite database path. */
  dbPath: string;
  /** Sync interval in ms. Default: 5000 (5s). */
  syncIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// PersistedShortTermRecallStore
// ---------------------------------------------------------------------------

export class PersistedShortTermRecallStore {
  private db: Database.Database;
  private memoryBuffer: ShortTermEntry[] = [];
  private config: Required<PersistedShortTermConfig>;
  private syncTimer?: ReturnType<typeof setInterval>;
  private isDirty = false;

  constructor(config: PersistedShortTermConfig) {
    this.config = {
      syncIntervalMs: 5000,
      ...config,
    };

    this.db = new Database(this.config.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
    this.loadFromDisk();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS short_term_recall (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        dream_score REAL,
        staged_in_phase TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_str_timestamp ON short_term_recall(timestamp);
      CREATE INDEX IF NOT EXISTS idx_str_source ON short_term_recall(source);
    `);
  }

  private loadFromDisk(): void {
    const cutoff = Date.now() - this.config.maxAgeMs;

    const rows = this.db.prepare(`
      SELECT id, content, source, timestamp, metadata, dream_score, staged_in_phase
      FROM short_term_recall
      WHERE timestamp >= ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(cutoff, this.config.maxEntries) as Array<{
      id: string;
      content: string;
      source: string;
      timestamp: number;
      metadata: string;
      dream_score: number | null;
      staged_in_phase: string | null;
    }>;

    this.memoryBuffer = rows.map(row => ({
      id: row.id,
      content: row.content,
      source: row.source as ShortTermEntry['source'],
      timestamp: row.timestamp,
      metadata: JSON.parse(row.metadata),
      dreamScore: row.dream_score ?? undefined,
      stagedInPhase: (row.staged_in_phase as ShortTermEntry['stagedInPhase']) ?? undefined,
    }));
  }

  /**
   * Add an entry to the buffer and mark as dirty for sync.
   */
  add(
    content: string,
    source: ShortTermEntry['source'],
    metadata: Record<string, unknown> = {},
  ): ShortTermEntry {
    const entry: ShortTermEntry = {
      id: randomUUID(),
      content,
      source,
      timestamp: Date.now(),
      metadata,
    };

    this.memoryBuffer.push(entry);
    this.isDirty = true;

    // Evict if over capacity
    if (this.memoryBuffer.length > this.config.maxEntries) {
      this.memoryBuffer.sort((a, b) => a.timestamp - b.timestamp);
      this.memoryBuffer = this.memoryBuffer.slice(-this.config.maxEntries);
    }

    return entry;
  }

  /**
   * Get all entries (from memory buffer).
   */
  getCandidates(): ShortTermEntry[] {
    this.pruneExpired();
    return [...this.memoryBuffer];
  }

  /**
   * Get entries filtered by source type.
   */
  getCandidatesBySource(source: ShortTermEntry['source']): ShortTermEntry[] {
    return this.getCandidates().filter(e => e.source === source);
  }

  /**
   * Score an entry for dreaming promotion.
   */
  scoreEntry(entry: ShortTermEntry): number {
    const ageScore = MemoryScorer.scoreAge(entry.timestamp, this.config.maxAgeMs);

    const sourceWeights: Record<ShortTermEntry['source'], number> = {
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
    return candidates.filter(e => (e.dreamScore ?? 0) >= this.config.promotionThreshold);
  }

  /**
   * Mark an entry as staged in a specific dream phase.
   */
  markStaged(entryId: string, phase: ShortTermEntry['stagedInPhase']): void {
    const entry = this.memoryBuffer.find(e => e.id === entryId);
    if (entry) {
      entry.stagedInPhase = phase;
      this.isDirty = true;

      // Update in SQLite
      this.db.prepare(`
        UPDATE short_term_recall
        SET staged_in_phase = ?, dream_score = ?
        WHERE id = ?
      `).run(phase, entry.dreamScore ?? null, entryId);
    }
  }

  /**
   * Clear the buffer after a dream cycle completes.
   */
  clear(): void {
    this.memoryBuffer = [];
    this.isDirty = true;

    // Clear from SQLite
    this.db.prepare('DELETE FROM short_term_recall').run();
  }

  /**
   * Get current buffer size.
   */
  size(): number {
    return this.memoryBuffer.length;
  }

  /**
   * Get buffer statistics.
   */
  stats(): {
    total: number;
    bySource: Record<string, number>;
    avgAge: number;
    promotable: number;
    persisted: number;
  } {
    const candidates = this.getCandidates();
    const now = Date.now();
    const bySource: Record<string, number> = {};
    let totalAge = 0;

    for (const entry of candidates) {
      bySource[entry.source] = (bySource[entry.source] ?? 0) + 1;
      totalAge += now - entry.timestamp;
    }

    for (const entry of candidates) {
      this.scoreEntry(entry);
    }

    const persisted = (this.db.prepare('SELECT COUNT(*) as count FROM short_term_recall').get() as { count: number }).count;

    return {
      total: candidates.length,
      bySource,
      avgAge: candidates.length > 0 ? totalAge / candidates.length : 0,
      promotable: candidates.filter(e => (e.dreamScore ?? 0) >= this.config.promotionThreshold).length,
      persisted,
    };
  }

  /**
   * Start automatic sync to SQLite.
   */
  startAutoSync(): void {
    if (this.syncTimer) return;

    this.syncTimer = setInterval(() => {
      this.syncToDisk();
    }, this.config.syncIntervalMs);
  }

  /**
   * Stop automatic sync.
   */
  stopAutoSync(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = undefined;
    }
  }

  /**
   * Sync dirty buffer to SQLite.
   */
  syncToDisk(): void {
    if (!this.isDirty) return;

    const upsert = this.db.prepare(`
      INSERT OR REPLACE INTO short_term_recall (id, content, source, timestamp, metadata, dream_score, staged_in_phase)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const syncMany = this.db.transaction((entries: ShortTermEntry[]) => {
      for (const entry of entries) {
        upsert.run(
          entry.id,
          entry.content,
          entry.source,
          entry.timestamp,
          JSON.stringify(entry.metadata),
          entry.dreamScore ?? null,
          entry.stagedInPhase ?? null,
        );
      }
    });

    syncMany(this.memoryBuffer);
    this.isDirty = false;
  }

  /**
   * Prune entries older than maxAgeMs.
   */
  private pruneExpired(): void {
    const cutoff = Date.now() - this.config.maxAgeMs;
    const before = this.memoryBuffer.length;

    this.memoryBuffer = this.memoryBuffer.filter(e => e.timestamp >= cutoff);

    if (this.memoryBuffer.length < before) {
      this.isDirty = true;

      // Also prune from SQLite
      this.db.prepare('DELETE FROM short_term_recall WHERE timestamp < ?').run(cutoff);
    }
  }

  /**
   * Close the store and sync final state.
   */
  close(): void {
    this.stopAutoSync();
    this.syncToDisk();
    this.db.close();
  }
}
