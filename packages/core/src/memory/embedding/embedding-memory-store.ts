/**
 * Embedding-Based Memory Search
 *
 * Integrates OpenAI embeddings (text-embedding-3-small) with SQLite
 * for hybrid semantic + keyword search.
 * of 70% vector + 30% BM25 weighting.
 *
 * Features:
 * - Automatic embedding generation with caching
 * - Vector similarity search via cosine distance
 * - Hybrid search combining vector + FTS5
 * - Batch embedding for efficiency
 */

import Database from 'better-sqlite3';
import type { MemoryEvent } from '@dyna/memory-core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmbeddingConfig {
  /** OpenAI API key. */
  apiKey: string;
  /** Embedding model. Default: text-embedding-3-small. */
  model?: string;
  /** Vector dimensions. Default: 1536 for text-embedding-3-small. */
  dimensions?: number;
  /** Hybrid search weights. Default: 70% vector, 30% BM25. */
  weights?: {
    vector: number;
    bm25: number;
  };
  /** Batch size for embedding requests. Default: 20. */
  batchSize?: number;
  /** Cache TTL in seconds. Default: 3600 (1 hour). */
  cacheTtlSeconds?: number;
}

export interface EmbeddingSearchQuery {
  /** Text to search for. */
  text: string;
  /** Scope filter. */
  scope?: string;
  /** Kind filter. */
  kind?: string;
  /** Min date filter. */
  minDate?: Date;
  /** Max date filter. */
  maxDate?: Date;
  /** Max results. Default: 10. */
  limit?: number;
  /** Minimum similarity score (0-1). Default: 0.3. */
  minScore?: number;
  /** Whether to use hybrid mode (vector + BM25). Default: true. */
  hybrid?: boolean;
}

export interface EmbeddingSearchResult {
  id: string;
  score: number;
  vectorScore: number;
  bm25Score: number;
  payload: Record<string, unknown>;
  timestamp: Date;
}

// ---------------------------------------------------------------------------
// EmbeddingService
// ---------------------------------------------------------------------------

export class EmbeddingService {
  private config: Required<EmbeddingConfig>;
  private cache: Map<string, { embedding: number[]; expiresAt: number }> = new Map();

  constructor(config: EmbeddingConfig) {
    this.config = {
      model: 'text-embedding-3-small',
      dimensions: 1536,
      weights: { vector: 0.7, bm25: 0.3 },
      batchSize: 20,
      cacheTtlSeconds: 3600,
      ...config,
    };
  }

  /**
   * Generate embedding for a single text.
   * Uses cache if available.
   */
  async embed(text: string): Promise<number[]> {
    const cacheKey = this.getCacheKey(text);
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.embedding;
    }

    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        input: text,
        model: this.config.model,
        dimensions: this.config.dimensions,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Embedding API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[] }>;
    };

    const embedding = data.data[0].embedding;

    // Cache the result
    this.cache.set(cacheKey, {
      embedding,
      expiresAt: Date.now() + this.config.cacheTtlSeconds * 1000,
    });

    return embedding;
  }

  /**
   * Generate embeddings for multiple texts in batch.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = new Array(texts.length);
    const uncached: Array<{ index: number; text: string }> = [];

    // Check cache first
    for (let i = 0; i < texts.length; i++) {
      const cacheKey = this.getCacheKey(texts[i]);
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        results[i] = cached.embedding;
      } else {
        uncached.push({ index: i, text: texts[i] });
      }
    }

    // Batch embed uncached texts
    for (let i = 0; i < uncached.length; i += this.config.batchSize) {
      const batch = uncached.slice(i, i + this.config.batchSize);
      const batchTexts = batch.map(item => item.text);

      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          input: batchTexts,
          model: this.config.model,
          dimensions: this.config.dimensions,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Embedding API error: ${response.status} - ${error}`);
      }

      const data = await response.json() as {
        data: Array<{ embedding: number[] }>;
      };

      // Store results
      for (let j = 0; j < batch.length; j++) {
        const embedding = data.data[j].embedding;
        results[batch[j].index] = embedding;

        // Cache
        const cacheKey = this.getCacheKey(batch[j].text);
        this.cache.set(cacheKey, {
          embedding,
          expiresAt: Date.now() + this.config.cacheTtlSeconds * 1000,
        });
      }
    }

    return results;
  }

  /**
   * Calculate cosine similarity between two vectors.
   */
  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error('Vectors must have same dimensions');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Clear expired cache entries.
   */
  clearExpiredCache(): number {
    const now = Date.now();
    let cleared = 0;
    for (const [key, value] of this.cache) {
      if (value.expiresAt <= now) {
        this.cache.delete(key);
        cleared++;
      }
    }
    return cleared;
  }

  private getCacheKey(text: string): string {
    // Simple hash for cache key
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash) + text.charCodeAt(i);
      hash = hash & hash;
    }
    return `emb_${Math.abs(hash).toString(36)}`;
  }
}

// ---------------------------------------------------------------------------
// EmbeddingMemoryStore (extends SqliteMemoryStore)
// ---------------------------------------------------------------------------

export class EmbeddingMemoryStore {
  private db: Database.Database;
  private embeddingService: EmbeddingService;
  private weights: { vector: number; bm25: number };

  constructor(
    dbPath: string,
    embeddingConfig: EmbeddingConfig,
  ) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.embeddingService = new EmbeddingService(embeddingConfig);
    this.weights = embeddingConfig.weights ?? { vector: 0.7, bm25: 0.3 };
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      -- Main memory events table
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

      -- FTS5 for keyword search
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

      -- Embeddings table for vector search
      CREATE TABLE IF NOT EXISTS memory_embeddings (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        embedding BLOB NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (memory_id) REFERENCES memory_events(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_memory_embeddings_memory_id ON memory_embeddings(memory_id);
    `);
  }

  /**
   * Store a memory event with its embedding.
   */
  async put(event: MemoryEvent): Promise<void> {
    // Store the event
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

    // Generate and store embedding
    try {
      const text = this.extractSearchableText(event);
      const embedding = await this.embeddingService.embed(text);

      const embStmt = this.db.prepare(`
        INSERT OR REPLACE INTO memory_embeddings (id, memory_id, embedding, created_at)
        VALUES (?, ?, ?, datetime('now'))
      `);

      embStmt.run(
        `emb-${event.id}`,
        event.id,
        Buffer.from(new Float32Array(embedding).buffer),
      );
    } catch (err) {
      // Embedding failure is non-fatal; log and continue
      console.warn(`Failed to generate embedding for ${event.id}:`, err);
    }
  }

  /**
   * Hybrid search combining vector similarity + BM25.
   * Returns results scored with configurable weights.
   */
  async hybridSearch(query: EmbeddingSearchQuery): Promise<EmbeddingSearchResult[]> {
    const limit = query.limit ?? 10;
    const minScore = query.minScore ?? 0.3;

    // Generate query embedding
    let queryEmbedding: number[];
    try {
      queryEmbedding = await this.embeddingService.embed(query.text);
    } catch (err) {
      throw new Error(`Failed to embed query: ${(err as Error).message}`);
    }

    // Vector search
    const vectorResults = await this.vectorSearch(queryEmbedding, query, limit * 4);

    // BM25 search
    const bm25Results = await this.bm25Search(query.text, query, limit * 4);

    // Merge and score results
    const merged = new Map<string, {
      id: string;
      vectorScore: number;
      bm25Score: number;
      payload: Record<string, unknown>;
      timestamp: Date;
    }>();

    // Add vector results
    for (const result of vectorResults) {
      merged.set(result.id, {
        id: result.id,
        vectorScore: result.score,
        bm25Score: 0,
        payload: result.payload,
        timestamp: result.timestamp,
      });
    }

    // Add/update with BM25 results
    for (const result of bm25Results) {
      const existing = merged.get(result.id);
      if (existing) {
        existing.bm25Score = result.score;
      } else {
        merged.set(result.id, {
          id: result.id,
          vectorScore: 0,
          bm25Score: result.score,
          payload: result.payload,
          timestamp: result.timestamp,
        });
      }
    }

    // Calculate hybrid scores and filter
    const results: EmbeddingSearchResult[] = [];
    for (const result of merged.values()) {
      const hybridScore =
        result.vectorScore * this.weights.vector +
        result.bm25Score * this.weights.bm25;

      if (hybridScore >= minScore) {
        results.push({
          id: result.id,
          score: hybridScore,
          vectorScore: result.vectorScore,
          bm25Score: result.bm25Score,
          payload: result.payload,
          timestamp: result.timestamp,
        });
      }
    }

    // Sort by hybrid score and limit
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  private async vectorSearch(
    queryEmbedding: number[],
    query: EmbeddingSearchQuery,
    limit: number,
  ): Promise<Array<{
    id: string;
    score: number;
    payload: Record<string, unknown>;
    timestamp: Date;
  }>> {
    // Get all embeddings and calculate similarity
    const stmt = this.db.prepare(`
      SELECT me.id, me.payload, me.timestamp, mem.embedding
      FROM memory_events me
      INNER JOIN memory_embeddings mem ON me.id = mem.memory_id
    `);

    const rows = stmt.all() as Array<{
      id: string;
      payload: string;
      timestamp: string;
      embedding: Buffer;
    }>;

    const results: Array<{
      id: string;
      score: number;
      payload: Record<string, unknown>;
      timestamp: Date;
    }> = [];

    for (const row of rows) {
      // Apply filters
      const event = {
        id: row.id,
        payload: JSON.parse(row.payload),
        timestamp: new Date(row.timestamp),
      };

      if (query.scope && !event.payload['scope']?.toString().includes(query.scope)) {
        continue;
      }
      if (query.minDate && event.timestamp < query.minDate) continue;
      if (query.maxDate && event.timestamp > query.maxDate) continue;

      // Calculate similarity
      const embedding = Array.from(new Float32Array(row.embedding.buffer));
      const score = this.embeddingService.cosineSimilarity(queryEmbedding, embedding);

      results.push({
        id: row.id,
        score,
        payload: event.payload,
        timestamp: event.timestamp,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  private async bm25Search(
    text: string,
    query: EmbeddingSearchQuery,
    limit: number,
  ): Promise<Array<{
    id: string;
    score: number;
    payload: Record<string, unknown>;
    timestamp: Date;
  }>> {
    const normalizedText = text
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!normalizedText) return [];

    const conditions: string[] = [];
    const params: unknown[] = [];

    conditions.push('memory_events_fts MATCH ?');
    params.push(normalizedText);

    if (query.scope) {
      conditions.push('me.scope = ?');
      params.push(query.scope);
    }

    if (query.kind) {
      conditions.push('me.kind = ?');
      params.push(query.kind);
    }

    if (query.minDate) {
      conditions.push('me.timestamp >= ?');
      params.push(query.minDate.toISOString());
    }

    if (query.maxDate) {
      conditions.push('me.timestamp <= ?');
      params.push(query.maxDate.toISOString());
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const sql = `
      SELECT me.id, me.payload, me.timestamp, memory_events_fts.rank
      FROM memory_events me
      INNER JOIN memory_events_fts ON me.rowid = memory_events_fts.rowid
      ${whereClause}
      ORDER BY memory_events_fts.rank
      LIMIT ?
    `;
    params.push(limit);

    try {
      const rows = this.db.prepare(sql).all(...params) as Array<{
        id: string;
        payload: string;
        timestamp: string;
        rank: number;
      }>;

      return rows.map(row => ({
        id: row.id,
        score: Math.max(0, 1 - Math.abs(row.rank)),
        payload: JSON.parse(row.payload),
        timestamp: new Date(row.timestamp),
      }));
    } catch {
      // FTS5 may fail with special characters; fallback to empty
      return [];
    }
  }

  private extractSearchableText(event: MemoryEvent): string {
    const parts: string[] = [];

    if (event.kind) parts.push(event.kind);
    if (event.scope) parts.push(event.scope);

    const payload = event.payload as Record<string, unknown>;
    if (payload.text) parts.push(String(payload.text));
    if (payload.content) parts.push(String(payload.content));
    if (payload.description) parts.push(String(payload.description));

    // Fallback: stringify entire payload
    if (parts.length === 0) {
      parts.push(JSON.stringify(payload));
    }

    return parts.join(' ');
  }

  /**
   * Get embedding statistics.
   */
  stats(): {
    totalEvents: number;
    embeddedEvents: number;
    cacheSize: number;
  } {
    const totalEvents = (this.db.prepare('SELECT COUNT(*) as count FROM memory_events').get() as { count: number }).count;
    const embeddedEvents = (this.db.prepare('SELECT COUNT(*) as count FROM memory_embeddings').get() as { count: number }).count;

    return {
      totalEvents,
      embeddedEvents,
      cacheSize: this.embeddingService['cache'].size,
    };
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }
}
