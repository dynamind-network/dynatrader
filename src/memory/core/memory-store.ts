/**
 * Memory Store Implementation
 *
 * Provides in-memory storage with optional backend adapters (LanceDB,
 * SQLite).
 */

import type { MemoryStore } from "@dyna/contracts";
import { memoryScorer } from "../memory-scorer";

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export interface MemoryEvent {
  id: string;
  scope: string;
  kind: string;
  payload: unknown;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface StoredUser {
  id: string;
  username: string;
  email?: string;
  hashedPassword: string;
  role: string;
  permissions?: string[];
  accountId?: string;
}

export interface StoredApiKey {
  userId: string;
  name: string;
  role: string;
  permissions: string[];
}

export interface SearchQuery {
  scope?: string;
  kind?: string;
  includeArchived?: boolean;
  text?: string;
  minDate?: Date;
  maxDate?: number;
  limit?: number;
}

export interface SearchResult {
  id: string;
  score: number;
  payload: unknown;
  timestamp: Date;
}

// ---------------------------------------------------------------------------
// Backend adapter interfaces
// ---------------------------------------------------------------------------

export interface MemoryStoreBackend {
  put(event: MemoryEvent): Promise<void>;
  get(id: string): Promise<MemoryEvent | null>;
  search(query: SearchQuery): Promise<SearchResult[]>;
  compact(scope: string): Promise<void>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Configuration for unified memory store
// ---------------------------------------------------------------------------

export interface SqliteBackendConfig {
  kind: "sqlite";
  dbPath?: string;
}

export interface MemoryConfig {
  /** Backend to use. Defaults to "sqlite" when omitted. */
  backend?: "in-memory" | "sqlite";
  sqlite?: SqliteBackendConfig;
  /** Maximum events to keep per scope during compaction. Default 10000. */
  maxEventsPerScope?: number;
}

// ---------------------------------------------------------------------------
// In-memory store (default, no external dependencies)
// ---------------------------------------------------------------------------

export class InMemoryStore implements MemoryStoreBackend {
  private events: Map<string, MemoryEvent> = new Map();
  private index: Map<string, MemoryEvent[]> = new Map(); // scope -> events

  async put(event: MemoryEvent): Promise<void> {
    const previous = this.events.get(event.id);
    if (previous) {
      const previousScope = this.index.get(previous.scope);
      if (previousScope) {
        this.index.set(previous.scope, previousScope.filter((item) => item.id !== event.id));
      }
    }
    this.events.set(event.id, event);

    // Update index
    if (!this.index.has(event.scope)) {
      this.index.set(event.scope, []);
    }
    this.index.get(event.scope)!.push(event);
  }

  async get(id: string): Promise<MemoryEvent | null> {
    return this.events.get(id) || null;
  }

  async search(query: SearchQuery): Promise<SearchResult[]> {
    let events = Array.from(this.events.values());

    // Filter by scope
    if (query.scope) {
      events = events.filter(e => e.scope === query.scope);
    }

    // Filter by kind
    if (query.kind) {
      events = events.filter(e => e.kind === query.kind);
    }

    // Archive records are retained for audit, but their original source IDs
    // must not remain in the default active search surface.
    if (!query.includeArchived && !query.kind?.endsWith(':archived')) {
      const archivedIds = new Set(
        events
          .filter((event) => event.kind.endsWith(':archived'))
          .map((event) => (event.payload as Record<string, unknown>)?.originalId)
          .filter((id): id is string => typeof id === 'string'),
      );
      events = events.filter((event) => !event.kind.endsWith(':archived') && !archivedIds.has(event.id));
    }

    // Filter by date range
    if (query.minDate) {
      events = events.filter(e => e.timestamp >= query.minDate!);
    }

    if (query.maxDate) {
      const maxDate = new Date(query.maxDate);
      events = events.filter(e => e.timestamp <= maxDate);
    }

    // Text queries should find relevant memory rather than merely returning the
    // newest event. Preserve recency as a tie-breaker for empty queries.
    const ranked = events.map((event) => ({ event, score: memoryScorer.score(event, query).total }));
    ranked.sort((a, b) => b.score - a.score || b.event.timestamp.getTime() - a.event.timestamp.getTime());

    const limit = query.limit || 50;
    const selected = ranked.slice(0, limit);
    const queryDiversity = query.text
      ? Math.min(1, new Set(query.text.toLowerCase().split(/\s+/).filter(Boolean)).size / 10)
      : 0.5;

    for (const { event } of selected) {
      const metadata = { ...(event.metadata ?? {}) };
      metadata.accessCount = (typeof metadata.accessCount === "number" ? metadata.accessCount : 0) + 1;
      metadata.frequency = (typeof metadata.frequency === "number" ? metadata.frequency : 0) + 1;
      metadata.lastAccessedAt = new Date().toISOString();
      metadata.queryDiversity = typeof metadata.queryDiversity === "number"
        ? (metadata.queryDiversity + queryDiversity) / 2
        : queryDiversity;
      event.metadata = metadata;
      this.events.set(event.id, event);
    }

    return selected.map(({ event, score }) => ({
      id: event.id,
      score,
      payload: event.payload,
      timestamp: event.timestamp,
    }));
  }

  async compact(scope: string): Promise<void> {
    // For in-memory store, compaction means pruning stale entries and merging
    // near-duplicates so the searchable surface stays bounded.
    const events = this.index.get(scope) || [];
    const cutoffDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
    const buckets: MemoryEvent[][] = [];
    const archived: MemoryEvent[] = [];

    for (const event of events) {
      if (event.timestamp <= cutoffDate && memoryScorer.shouldArchive(event, { scope, limit: 1 })) {
        archived.push({
          ...event,
          scope: `${scope}:archive`,
          metadata: {
            ...(event.metadata ?? {}),
            archivedAt: new Date().toISOString(),
          },
        });
        continue;
      }

      const bucket = buckets.find((candidate) => {
        const primary = candidate[0];
        return primary ? memoryScorer.isNearDuplicate(primary, event) : false;
      });

      if (bucket) {
        bucket.push(event);
      } else {
        buckets.push([event]);
      }
    }

    const compacted: MemoryEvent[] = [];
    for (const bucket of buckets) {
      bucket.sort((a, b) => {
        const scoreDiff = memoryScorer.score(b, { scope, limit: 1 }).total - memoryScorer.score(a, { scope, limit: 1 }).total;
        return scoreDiff !== 0 ? scoreDiff : b.timestamp.getTime() - a.timestamp.getTime();
      });

      const [primary, ...duplicates] = bucket;
      if (!primary) {
        continue;
      }

      if (duplicates.length > 0) {
        compacted.push(this.mergeEvents(primary, duplicates));
      } else {
        compacted.push(primary);
      }
    }

    this.index.set(scope, compacted);
    if (archived.length > 0) {
      this.index.set(`${scope}:archive`, archived);
    } else {
      this.index.delete(`${scope}:archive`);
    }

    // Update main events map
    for (const event of compacted) {
      this.events.set(event.id, event);
    }
    for (const event of archived) {
      this.events.set(event.id, event);
    }

    // Remove events that are no longer in any scope
    const allEventIds = new Set(Array.from(this.index.values()).flat().map(e => e.id));
    for (const [id] of this.events) {
      if (!allEventIds.has(id)) {
        this.events.delete(id);
      }
    }
  }

  async close(): Promise<void> {
    this.events.clear();
    this.index.clear();
  }

  private mergeEvents(primary: MemoryEvent, duplicates: MemoryEvent[]): MemoryEvent {
    const all = [primary, ...duplicates];
    const frequency = all.reduce((sum, event) => {
      const metaFrequency = typeof event.metadata?.["frequency"] === "number" ? (event.metadata["frequency"] as number) : 1;
      return sum + Math.max(1, metaFrequency);
    }, 0);
    const accessCount = all.reduce((sum, event) => {
      const metaAccess = typeof event.metadata?.["accessCount"] === "number" ? (event.metadata["accessCount"] as number) : 1;
      return sum + Math.max(1, metaAccess);
    }, 0);
    const consolidationCount = all.reduce((sum, event) => {
      const metaConsolidation = typeof event.metadata?.["consolidationCount"] === "number" ? (event.metadata["consolidationCount"] as number) : 0;
      return sum + Math.max(0, metaConsolidation);
    }, 0) + 1;

    return {
      ...primary,
      timestamp: all.reduce((latest, event) => event.timestamp > latest ? event.timestamp : latest, primary.timestamp),
      metadata: {
        ...(primary.metadata ?? {}),
        frequency,
        accessCount,
        consolidationCount,
        conceptualRichness: Math.min(1, all.length / 5),
        lastMergedAt: new Date().toISOString(),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Unified MemoryStoreImpl — the main class consumers use
// ---------------------------------------------------------------------------

export class MemoryStoreImpl implements MemoryStore {
  private backend: MemoryStoreBackend;
  private kvStore: Map<string, unknown> = new Map();
  private config: MemoryConfig;

  constructor(backend?: MemoryStoreBackend, config?: MemoryConfig) {
    this.backend = backend || new InMemoryStore();
    this.config = config ?? {};
  }

  // -----------------------------------------------------------------------
  // Factory: create a MemoryStoreImpl with a specific backend
  // -----------------------------------------------------------------------

  /**
   * Create a MemoryStoreImpl from a generic MemoryConfig.
   * Defaults to SQLite when no backend is specified.
   */
  static async fromConfig(config: MemoryConfig): Promise<MemoryStoreImpl> {
    switch (config.backend) {
      case "sqlite":
        return MemoryStoreImpl.withSqlite(config.sqlite);
      default:
        return MemoryStoreImpl.withSqlite(config.sqlite);
    }
  }

  /**
   * Create a MemoryStoreImpl backed by SQLite.
   */
  static async withSqlite(
    sqliteConfig?: SqliteBackendConfig,
  ): Promise<MemoryStoreImpl> {
    const { SqliteMemoryStore } = await import("@dyna/memory-sqlite");
    const dbPath = sqliteConfig?.dbPath ?? "workspace/state.db";
    const backend = new SqliteMemoryStore(dbPath);
    return new MemoryStoreImpl(backend, {
      backend: "sqlite",
      sqlite: sqliteConfig ?? { kind: "sqlite" },
    });
  }

  /** Return the current config (useful for diagnostics). */
  getConfig(): Readonly<MemoryConfig> {
    return { ...this.config };
  }

  /** Return the underlying backend adapter (e.g. SqliteMemoryStore). */
  getBackend(): MemoryStoreBackend {
    return this.backend;
  }

  // -----------------------------------------------------------------------
  // Generic key-value store methods used by consumers
  // (performance-core, security-boundary, etc.)
  // -----------------------------------------------------------------------

  async getCacheItem(key: string): Promise<unknown> {
    return this.kvStore.get(key) ?? null;
  }

  async setCacheItem(key: string, value: unknown): Promise<void> {
    this.kvStore.set(key, value);
  }

  async deleteCacheItem(key: string): Promise<boolean> {
    return this.kvStore.delete(key);
  }

  async hasCacheItem(key: string): Promise<boolean> {
    return this.kvStore.has(key);
  }

  async clearCache(): Promise<void> {
    this.kvStore.clear();
  }

  async setAuditEvent(id: string, event: unknown): Promise<void> {
    this.kvStore.set(`audit:${id}`, event);
  }

  async getAuditEvents(filters?: Record<string, unknown>): Promise<unknown[]> {
    const events: unknown[] = [];
    for (const [key, value] of this.kvStore) {
      if (key.startsWith('audit:')) {
        events.push(value);
      }
    }
    return events;
  }

  async getAuditEventCount(filters?: Record<string, unknown>): Promise<number> {
    let count = 0;
    for (const key of this.kvStore.keys()) {
      if (key.startsWith('audit:')) count++;
    }
    return count;
  }

  async archiveAuditEvents(before: number): Promise<void> {
    for (const key of this.kvStore.keys()) {
      if (key.startsWith('audit:')) {
        this.kvStore.delete(key);
      }
    }
  }

  async getUser(emailOrId: string): Promise<StoredUser | null> {
    return (this.kvStore.get(`user:${emailOrId}`) as StoredUser) ?? null;
  }

  async getUserById(id: string): Promise<StoredUser | null> {
    return (this.kvStore.get(`user:${id}`) as StoredUser) ?? null;
  }

  async getUserPermissions(userId: string): Promise<unknown[]> {
    return (this.kvStore.get(`user_permissions:${userId}`) as unknown[]) ?? [];
  }

  async getLoginAttempts(email: string): Promise<{ count: number; lastAttempt: number; lockUntil: number | null } | null> {
    return (this.kvStore.get(`login_attempts:${email}`) as { count: number; lastAttempt: number; lockUntil: number | null }) ?? null;
  }

  async setLoginAttempts(email: string, data: { count: number; lastAttempt: number; lockUntil: number | null }): Promise<void> {
    this.kvStore.set(`login_attempts:${email}`, data);
  }

  async setSession(session: unknown): Promise<void> {
    const s = session as { id?: string; userId?: string };
    if (s.id) this.kvStore.set(`session:${s.id}`, session);
    if (s.userId) this.kvStore.set(`user_sessions:${s.userId}`, session);
  }

  async getUserSessions(userId: string): Promise<unknown[]> {
    const sessions: unknown[] = [];
    for (const [key, value] of this.kvStore) {
      if (key.startsWith('session:') && (value as Record<string, unknown>)?.userId === userId) {
        sessions.push(value);
      }
    }
    return sessions;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    return this.kvStore.delete(`session:${sessionId}`);
  }

  async hasActiveSession(sessionId: string): Promise<boolean> {
    return this.kvStore.has(`session:${sessionId}`);
  }

  async validateApiKey(key: string): Promise<StoredApiKey | null> {
    return (this.kvStore.get(`apikey:${key}`) as StoredApiKey) ?? null;
  }

  async incrementGlobalCounter(key: string): Promise<number> {
    const current = (this.kvStore.get(`counter:${key}`) as number) ?? 0;
    const next = current + 1;
    this.kvStore.set(`counter:${key}`, next);
    return next;
  }

  async incrementUserCounter(userId: string, key: string): Promise<number> {
    const fullKey = `counter:${userId}:${key}`;
    const current = (this.kvStore.get(fullKey) as number) ?? 0;
    const next = current + 1;
    this.kvStore.set(fullKey, next);
    return next;
  }

  async getGlobalCounter(key: string): Promise<number> {
    return (this.kvStore.get(`counter:${key}`) as number) ?? 0;
  }

  async getUserCounter(userId: string, key: string): Promise<number> {
    const fullKey = `counter:${userId}:${key}`;
    return (this.kvStore.get(fullKey) as number) ?? 0;
  }

  async getKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    for (const key of this.kvStore.keys()) {
      if (key.startsWith(prefix)) keys.push(key);
    }
    return keys;
  }

  async kvDelete(key: string): Promise<boolean> {
    return this.kvStore.delete(key);
  }

  // -----------------------------------------------------------------------
  // MemoryStore contract methods — delegate to backend
  // -----------------------------------------------------------------------

  async put(event: { scope: string; kind: string; payload: unknown; ts: Date }): Promise<void> {
    const memoryEvent: MemoryEvent = {
      id: `event-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      scope: event.scope,
      kind: event.kind,
      payload: event.payload,
      timestamp: event.ts,
    };
    await this.backend.put(memoryEvent);
  }

  async search(query: { scope: string; text: string; topK?: number; kind?: string; includeArchived?: boolean }): Promise<Array<{ id: string; score: number; payload: unknown; timestamp: Date }>> {
    return this.backend.search({
      scope: query.scope,
      kind: query.kind,
      text: query.text,
      includeArchived: query.includeArchived,
      limit: query.topK,
    });
  }

  async summarize(scope: { scope: string; from?: Date; to?: Date }): Promise<string> {
    const searchQuery: SearchQuery = {
      scope: scope.scope,
    };

    if (scope.from) searchQuery.minDate = scope.from;
    if (scope.to) searchQuery.maxDate = scope.to.getTime();

    const results = await this.backend.search(searchQuery);

    if (results.length === 0) {
      return `No events found in scope "${scope.scope}".`;
    }

    let summary = `Found ${results.length} events in scope "${scope.scope}".\n\n`;

    const kindCounts = new Map<string, number>();
    results.forEach(result => {
      const kind = result.id.split('-')[0] || 'unknown';
      kindCounts.set(kind, (kindCounts.get(kind) || 0) + 1);
    });

    summary += "Event types:\n";
    kindCounts.forEach((count, kind) => {
      summary += `- ${kind}: ${count} events\n`;
    });

    const sortedResults = results.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    const latestDate = sortedResults[0]!.timestamp.toLocaleDateString();
    const earliestDate = sortedResults[sortedResults.length - 1]!.timestamp.toLocaleDateString();

    summary += `\nDate range: ${earliestDate} to ${latestDate}\n`;
    summary += `Total time span: ${Math.ceil((sortedResults[0]!.timestamp.getTime() - sortedResults[sortedResults.length - 1]!.timestamp.getTime()) / (1000 * 60 * 60 * 24))} days`;

    return summary;
  }

  async compact(scope: { scope: string }): Promise<void> {
    await this.backend.compact(scope.scope);
  }

  async close(): Promise<void> {
    await this.backend.close();
  }

  // -----------------------------------------------------------------------
  // Factory methods
  // -----------------------------------------------------------------------
}
