/**
 * SQLite-backed Memory Store
 *
 * Implements MemoryStoreBackend using better-sqlite3 with FTS5 full-text search.
 * WAL mode is enabled for better concurrent read performance.
 */

import Database from "better-sqlite3";
import type {
  MemoryEvent,
  MemoryStoreBackend,
  SearchQuery,
  SearchResult,
} from "@dyna/memory-core";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_COMPACT_DAYS = 30;
const DEFAULT_SEARCH_LIMIT = 50;

// ---------------------------------------------------------------------------
// SqliteMemoryStore
// ---------------------------------------------------------------------------

export class SqliteMemoryStore implements MemoryStoreBackend {
  private db: Database.Database;

  constructor(dbPath: string) {
    try {
      this.db = new Database(dbPath);
      this.db.pragma("journal_mode = WAL");
      this.initSchema();
    } catch (err) {
      throw new Error(
        `Failed to open SQLite database at "${dbPath}": ${(err as Error).message}`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Schema initialization
  // -----------------------------------------------------------------------

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_events (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT '',
        payload TEXT NOT NULL DEFAULT '{}',
        timestamp TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_memory_events_scope ON memory_events(scope);
      CREATE INDEX IF NOT EXISTS idx_memory_events_kind ON memory_events(kind);
      CREATE INDEX IF NOT EXISTS idx_memory_events_timestamp ON memory_events(timestamp);

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_events_fts USING fts5(
        payload, content='memory_events', content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS memory_events_ai AFTER INSERT ON memory_events BEGIN
        INSERT INTO memory_events_fts(rowid, payload) VALUES (new.rowid, new.payload);
      END;

      CREATE TRIGGER IF NOT EXISTS memory_events_ad AFTER DELETE ON memory_events BEGIN
        INSERT INTO memory_events_fts(memory_events_fts, rowid, payload) VALUES('delete', old.rowid, old.payload);
      END;

      CREATE TRIGGER IF NOT EXISTS memory_events_au AFTER UPDATE ON memory_events BEGIN
        INSERT INTO memory_events_fts(memory_events_fts, rowid, payload) VALUES('delete', old.rowid, old.payload);
        INSERT INTO memory_events_fts(rowid, payload) VALUES (new.rowid, new.payload);
      END;
    `);
  }

  // -----------------------------------------------------------------------
  // MemoryStoreBackend implementation
  // -----------------------------------------------------------------------

  async put(event: MemoryEvent): Promise<void> {
    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO memory_events (id, scope, kind, payload, timestamp, metadata)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        event.id,
        event.scope,
        event.kind,
        JSON.stringify(event.payload),
        event.timestamp.toISOString(),
        JSON.stringify(event.metadata ?? {}),
      );
    } catch (err) {
      throw new Error(
        `Failed to put event "${event.id}": ${(err as Error).message}`,
      );
    }
  }

  async get(id: string): Promise<MemoryEvent | null> {
    try {
      const stmt = this.db.prepare(
        "SELECT id, scope, kind, payload, timestamp, metadata FROM memory_events WHERE id = ?",
      );
      const row = stmt.get(id) as
        | {
            id: string;
            scope: string;
            kind: string;
            payload: string;
            timestamp: string;
            metadata: string;
          }
        | undefined;

      if (!row) return null;

      return this.rowToEvent(row);
    } catch (err) {
      throw new Error(
        `Failed to get event "${id}": ${(err as Error).message}`,
      );
    }
  }

  async search(query: SearchQuery): Promise<SearchResult[]> {
    try {
      const limit = query.limit ?? DEFAULT_SEARCH_LIMIT;

      // Text search via FTS5
      if (query.text && query.text.trim().length > 0) {
        const normalizedText = this.normalizeFtsQuery(query.text);
        if (normalizedText.length > 0) {
          try {
            return this.searchWithFts({ ...query, text: normalizedText }, limit);
          } catch {
            return this.searchWithTextLike({ ...query, text: normalizedText }, limit);
          }
        }
      }

      // Filter-based search
      return this.searchWithFilters(query, limit);
    } catch (err) {
      throw new Error(
        `Failed to search: ${(err as Error).message}`,
      );
    }
  }

  async compact(scope: string): Promise<void> {
    try {
      const cutoff = new Date(
        Date.now() - DEFAULT_COMPACT_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();

      const stmt = this.db.prepare(
        "DELETE FROM memory_events WHERE scope = ? AND timestamp < ?",
      );
      stmt.run(scope, cutoff);
    } catch (err) {
      throw new Error(
        `Failed to compact scope "${scope}": ${(err as Error).message}`,
      );
    }
  }

  async close(): Promise<void> {
    try {
      this.db.close();
    } catch (err) {
      throw new Error(
        `Failed to close database: ${(err as Error).message}`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private rowToEvent(row: {
    id: string;
    scope: string;
    kind: string;
    payload: string;
    timestamp: string;
    metadata: string;
  }): MemoryEvent {
    return {
      id: row.id,
      scope: row.scope,
      kind: row.kind,
      payload: JSON.parse(row.payload),
      timestamp: new Date(row.timestamp),
      metadata: JSON.parse(row.metadata),
    };
  }

  private normalizeFtsQuery(text: string): string {
    return text
      .replace(/[^\p{L}\p{N}\s]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private searchWithFts(query: SearchQuery, limit: number): SearchResult[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    // FTS5 MATCH clause
    conditions.push("memory_events_fts MATCH ?");
    params.push(query.text);

    // Scope filter
    if (query.scope) {
      conditions.push("me.scope = ?");
      params.push(query.scope);
    }

    // Kind filter
    if (query.kind) {
      conditions.push("me.kind = ?");
      params.push(query.kind);
    }

    this.addActiveMemoryFilters(conditions, query, "me.");

    // Date filters
    if (query.minDate) {
      conditions.push("me.timestamp >= ?");
      params.push(query.minDate.toISOString());
    }

    if (query.maxDate) {
      const maxDate = new Date(query.maxDate);
      conditions.push("me.timestamp <= ?");
      params.push(maxDate.toISOString());
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const sql = `
      SELECT me.id, me.scope, me.kind, me.payload, me.timestamp, me.metadata,
             memory_events_fts.rank AS fts_rank
      FROM memory_events me
      INNER JOIN memory_events_fts ON me.rowid = memory_events_fts.rowid
      ${whereClause}
      ORDER BY memory_events_fts.rank
      LIMIT ?
    `;
    params.push(limit);

    const rows = this.db
      .prepare(sql)
      .all(...params) as Array<{
      id: string;
      scope: string;
      kind: string;
      payload: string;
      timestamp: string;
      metadata: string;
      fts_rank: number;
    }>;

    return rows.map((row) => {
      const event = this.rowToEvent(row);
      // FTS5 rank is negative for good matches; convert to positive score 0-1
      const ftsScore = Math.max(0, 1 - Math.abs(row.fts_rank));
      return {
        id: event.id,
        score: ftsScore,
        payload: event.payload,
        timestamp: event.timestamp,
      };
    });
  }

  private searchWithFilters(query: SearchQuery, limit: number): SearchResult[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.scope) {
      conditions.push("scope = ?");
      params.push(query.scope);
    }

    if (query.kind) {
      conditions.push("kind = ?");
      params.push(query.kind);
    }

    this.addActiveMemoryFilters(conditions, query);

    if (query.minDate) {
      conditions.push("timestamp >= ?");
      params.push(query.minDate.toISOString());
    }

    if (query.maxDate) {
      const maxDate = new Date(query.maxDate);
      conditions.push("timestamp <= ?");
      params.push(maxDate.toISOString());
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const sql = `
      SELECT id, scope, kind, payload, timestamp, metadata
      FROM memory_events
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT ?
    `;
    params.push(limit);

    const rows = this.db
      .prepare(sql)
      .all(...params) as Array<{
      id: string;
      scope: string;
      kind: string;
      payload: string;
      timestamp: string;
      metadata: string;
    }>;

    return rows.map((row) => {
      const event = this.rowToEvent(row);
      const score = this.calcTimeDecayScore(event.timestamp);
      return {
        id: event.id,
        score,
        payload: event.payload,
        timestamp: event.timestamp,
      };
    });
  }

  private searchWithTextLike(query: SearchQuery, limit: number): SearchResult[] {
    const terms = (query.text ?? "")
      .split(" ")
      .map((term) => term.trim())
      .filter((term) => term.length >= 2)
      .slice(0, 8);

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.scope) {
      conditions.push("scope = ?");
      params.push(query.scope);
    }

    if (query.kind) {
      conditions.push("kind = ?");
      params.push(query.kind);
    }

    this.addActiveMemoryFilters(conditions, query);

    if (query.minDate) {
      conditions.push("timestamp >= ?");
      params.push(query.minDate.toISOString());
    }

    if (query.maxDate) {
      conditions.push("timestamp <= ?");
      params.push(new Date(query.maxDate).toISOString());
    }

    if (terms.length > 0) {
      for (const term of terms) {
        conditions.push("LOWER(payload) LIKE ?");
        params.push(`%${term.toLowerCase()}%`);
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `
      SELECT id, scope, kind, payload, timestamp, metadata
      FROM memory_events
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT ?
    `;
    params.push(limit);

    const rows = this.db
      .prepare(sql)
      .all(...params) as Array<{
      id: string;
      scope: string;
      kind: string;
      payload: string;
      timestamp: string;
      metadata: string;
    }>;

    return rows.map((row) => {
      const event = this.rowToEvent(row);
      return {
        id: event.id,
        score: this.calcTimeDecayScore(event.timestamp),
        payload: event.payload,
        timestamp: event.timestamp,
      };
    });
  }

  /** Keep archived source records out of the default active search surface. */
  private addActiveMemoryFilters(conditions: string[], query: SearchQuery, alias = ""): void {
    if (query.includeArchived || query.kind?.endsWith(":archived")) return;

    conditions.push(`${alias}kind NOT LIKE '%:archived'`);
    conditions.push(
      `NOT EXISTS (
        SELECT 1 FROM memory_events archived
        WHERE archived.kind LIKE '%:archived'
          AND json_extract(archived.payload, '$.originalId') = ${alias}id
      )`,
    );
  }

  /**
   * Calculate a time-decay score between 0 and 1.
   * score = 1.0 / (1.0 + daysOld * 0.1)
   */
  private calcTimeDecayScore(timestamp: Date): number {
    const ageInMs = Date.now() - timestamp.getTime();
    const ageInDays = ageInMs / (1000 * 60 * 60 * 24);
    return 1.0 / (1.0 + ageInDays * 0.1);
  }
}
