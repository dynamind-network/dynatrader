/**
 * Tests for SqliteMemoryStore
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteMemoryStore } from "./sqlite-store";
import type { MemoryEvent, SearchQuery } from "@dyna/memory-core";
import fs from "fs";
import path from "path";
import os from "os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    id: overrides.id ?? `test-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
    scope: overrides.scope ?? "test-scope",
    kind: overrides.kind ?? "test-kind",
    payload: overrides.payload ?? { message: "hello" },
    timestamp: overrides.timestamp ?? new Date(),
    metadata: overrides.metadata ?? {},
  };
}

function getTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-memory-test-"));
  return path.join(dir, "memory.db");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SqliteMemoryStore", () => {
  let dbPath: string;
  let store: SqliteMemoryStore;

  beforeEach(() => {
    dbPath = getTempDbPath();
    store = new SqliteMemoryStore(dbPath);
  });

  afterEach(async () => {
    await store.close();
    // Clean up temp directory
    const dir = path.dirname(dbPath);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------

  it("creates DB file and tables on construction", () => {
    expect(fs.existsSync(dbPath)).toBe(true);

    // Verify tables exist by querying sqlite_master
    const tables = store["db"]
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_events'",
      )
      .all();
    expect(tables).toHaveLength(1);

    const ftsTables = store["db"]
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_events_fts'",
      )
      .all();
    expect(ftsTables).toHaveLength(1);

    // Verify triggers exist
    const triggers = store["db"]
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'memory_events_%'",
      )
      .all();
    expect(triggers).toHaveLength(3);
  });

  // -----------------------------------------------------------------------
  // put and get
  // -----------------------------------------------------------------------

  it("round-trips a single event via put() and get()", async () => {
    const event = makeEvent({
      id: "roundtrip-1",
      scope: "test",
      kind: "info",
      payload: { value: 42, nested: { a: 1 } },
      metadata: { source: "test" },
    });

    await store.put(event);

    const retrieved = await store.get("roundtrip-1");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe("roundtrip-1");
    expect(retrieved!.scope).toBe("test");
    expect(retrieved!.kind).toBe("info");
    expect(retrieved!.payload).toEqual({ value: 42, nested: { a: 1 } });
    expect(retrieved!.metadata).toEqual({ source: "test" });
    expect(retrieved!.timestamp).toBeInstanceOf(Date);
  });

  it("returns null for non-existent id", async () => {
    const result = await store.get("non-existent-id");
    expect(result).toBeNull();
  });

  it("overwrites existing event with same id", async () => {
    const event1 = makeEvent({
      id: "dup-id",
      payload: { version: 1 },
    });
    const event2 = makeEvent({
      id: "dup-id",
      payload: { version: 2 },
    });

    await store.put(event1);
    await store.put(event2);

    const retrieved = await store.get("dup-id");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.payload).toEqual({ version: 2 });
  });

  // -----------------------------------------------------------------------
  // search with text (FTS5)
  // -----------------------------------------------------------------------

  it("searches by text using FTS5 match", async () => {
    const event1 = makeEvent({
      id: "fts-1",
      scope: "search-scope",
      payload: { content: "the quick brown fox" },
    });
    const event2 = makeEvent({
      id: "fts-2",
      scope: "search-scope",
      payload: { content: "jumps over the lazy dog" },
    });
    const event3 = makeEvent({
      id: "fts-3",
      scope: "other-scope",
      payload: { content: "quick silver" },
    });

    await store.put(event1);
    await store.put(event2);
    await store.put(event3);

    const results = await store.search({
      text: "quick",
      scope: "search-scope",
    });

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.map((r) => r.id)).toContain("fts-1");
    // fts-3 is in other-scope, should not appear
    expect(results.map((r) => r.id)).not.toContain("fts-3");
  });

  it("returns empty array when FTS text matches nothing", async () => {
    const event = makeEvent({
      id: "fts-nomatch",
      payload: { message: "hello world" },
    });
    await store.put(event);

    const results = await store.search({ text: "zzzzzznonexistent" });
    expect(results).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // search without text (filter-based)
  // -----------------------------------------------------------------------

  it("searches by scope and kind filters", async () => {
    const event1 = makeEvent({
      id: "filter-1",
      scope: "alpha",
      kind: "trade",
      payload: { symbol: "BTC" },
    });
    const event2 = makeEvent({
      id: "filter-2",
      scope: "alpha",
      kind: "signal",
      payload: { symbol: "ETH" },
    });
    const event3 = makeEvent({
      id: "filter-3",
      scope: "beta",
      kind: "trade",
      payload: { symbol: "SOL" },
    });

    await store.put(event1);
    await store.put(event2);
    await store.put(event3);

    // Filter by scope only
    const alphaResults = await store.search({ scope: "alpha" });
    expect(alphaResults).toHaveLength(2);
    expect(alphaResults.map((r) => r.id)).toEqual(
      expect.arrayContaining(["filter-1", "filter-2"]),
    );

    // Filter by scope + kind
    const tradeResults = await store.search({
      scope: "alpha",
      kind: "trade",
    });
    expect(tradeResults).toHaveLength(1);
    expect(tradeResults[0]!.id).toBe("filter-1");
  });

  it("keeps archived sources out of active searches while preserving audit access", async () => {
    await store.put(makeEvent({
      id: "active-source",
      scope: "archive-scope",
      kind: "learning",
      payload: { content: "consolidated memory" },
    }));
    await store.put(makeEvent({
      id: "source-archive",
      scope: "archive-scope",
      kind: "learning:archived",
      payload: { originalId: "active-source", originalPayload: { content: "consolidated memory" } },
    }));

    const active = await store.search({ scope: "archive-scope", text: "consolidated" });
    expect(active.map((result) => result.id)).not.toContain("active-source");
    expect(active.map((result) => result.id)).not.toContain("source-archive");

    const audit = await store.search({
      scope: "archive-scope",
      kind: "learning:archived",
      includeArchived: true,
    });
    expect(audit.map((result) => result.id)).toContain("source-archive");
  });

  it("returns results ordered by timestamp DESC", async () => {
    const now = Date.now();
    const old = makeEvent({
      id: "order-old",
      timestamp: new Date(now - 10000),
      payload: { seq: 1 },
    });
    const mid = makeEvent({
      id: "order-mid",
      timestamp: new Date(now - 5000),
      payload: { seq: 2 },
    });
    const recent = makeEvent({
      id: "order-recent",
      timestamp: new Date(now),
      payload: { seq: 3 },
    });

    await store.put(old);
    await store.put(mid);
    await store.put(recent);

    const results = await store.search({ scope: old.scope });
    expect(results).toHaveLength(3);
    expect(results[0]!.id).toBe("order-recent");
    expect(results[1]!.id).toBe("order-mid");
    expect(results[2]!.id).toBe("order-old");
  });

  it("respects limit parameter", async () => {
    for (let i = 0; i < 10; i++) {
      await store.put(
        makeEvent({
          id: `limit-${i}`,
          scope: "limit-scope",
          timestamp: new Date(Date.now() - i * 1000),
        }),
      );
    }

    const results = await store.search({ scope: "limit-scope", limit: 3 });
    expect(results).toHaveLength(3);
  });

  // -----------------------------------------------------------------------
  // compact
  // -----------------------------------------------------------------------

  it("removes events older than 30 days", async () => {
    const recent = makeEvent({
      id: "compact-recent",
      scope: "compact-scope",
      timestamp: new Date(), // now
    });
    const old = makeEvent({
      id: "compact-old",
      scope: "compact-scope",
      timestamp: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000), // 60 days ago
    });

    await store.put(recent);
    await store.put(old);

    await store.compact("compact-scope");

    const recentResult = await store.get("compact-recent");
    expect(recentResult).not.toBeNull();

    const oldResult = await store.get("compact-old");
    expect(oldResult).toBeNull();
  });

  it("does not remove events from other scopes during compact", async () => {
    const keep = makeEvent({
      id: "compact-other-scope",
      scope: "other-scope",
      timestamp: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000), // 60 days old
    });
    await store.put(keep);

    await store.compact("compact-scope");

    const result = await store.get("compact-other-scope");
    expect(result).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // close
  // -----------------------------------------------------------------------

  it("close() works without error", async () => {
    const localStore = new SqliteMemoryStore(getTempDbPath());
    await expect(localStore.close()).resolves.toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Multiple events in same scope
  // -----------------------------------------------------------------------

  it("multiple events with same scope are searchable", async () => {
    const events = [
      makeEvent({ id: "multi-1", scope: "multi-scope", kind: "a" }),
      makeEvent({ id: "multi-2", scope: "multi-scope", kind: "b" }),
      makeEvent({ id: "multi-3", scope: "multi-scope", kind: "c" }),
    ];

    for (const event of events) {
      await store.put(event);
    }

    const results = await store.search({ scope: "multi-scope" });
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.id)).toEqual(
      expect.arrayContaining(["multi-1", "multi-2", "multi-3"]),
    );
  });

  // -----------------------------------------------------------------------
  // Empty search
  // -----------------------------------------------------------------------

  it("empty search returns empty array when no events exist", async () => {
    const results = await store.search({});
    expect(results).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Score calculation
  // -----------------------------------------------------------------------

  it("search results have scores between 0 and 1", async () => {
    await store.put(
      makeEvent({
        id: "score-test",
        scope: "score-scope",
        timestamp: new Date(),
      }),
    );

    const results = await store.search({ scope: "score-scope" });
    expect(results).toHaveLength(1);
    expect(results[0]!.score).toBeGreaterThanOrEqual(0);
    expect(results[0]!.score).toBeLessThanOrEqual(1);
  });
});
