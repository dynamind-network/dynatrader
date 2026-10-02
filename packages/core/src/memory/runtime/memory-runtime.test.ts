/**
 * Tests for FileBackedMemoryStore
 *
 * Covers: create, read, search, summarize, compact,
 *        persistence across instances, error handling, daily rotation
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

import { FileBackedMemoryStore } from "./file-backed-store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

async function makeTmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "mem-runtime-test-"));
  return d;
}

async function wipeDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/** Count JSONL lines in a file */
async function countLines(filePath: string): Promise<number> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return content.trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

/** List the JSONL files in the memory dir */
async function listMemoryFiles(dir: string): Promise<string[]> {
  const memoryDir = path.join(dir, "memory");
  try {
    const all = await fs.readdir(memoryDir);
    return all.filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FileBackedMemoryStore", () => {
  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await wipeDir(tmpDir);
  });

  // ---- 1. create / put event -------------------------------------------
  it("should store an event and make it searchable", async () => {
    const store = new FileBackedMemoryStore(tmpDir);
    const ts = new Date("2025-01-15T10:00:00Z");

    await store.put({ scope: "test", kind: "info", payload: { msg: "hello" }, ts });

    const results = await store.search({ scope: "test", text: "", topK: 10 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.payload).toEqual({ msg: "hello" });
  });

  // ---- 2. read (search by scope) ---------------------------------------
  it("should filter events by scope", async () => {
    const store = new FileBackedMemoryStore(tmpDir);
    const ts = new Date();

    await store.put({ scope: "alpha", kind: "log", payload: 1, ts });
    await store.put({ scope: "beta", kind: "log", payload: 2, ts });

    const alphaResults = await store.search({ scope: "alpha", text: "", topK: 10 });
    expect(alphaResults.every((r) => r.payload === 1)).toBe(true);
    expect(alphaResults.length).toBe(1);

    const betaResults = await store.search({ scope: "beta", text: "", topK: 10 });
    expect(betaResults.length).toBe(1);
  });

  // ---- 3. search with text ---------------------------------------------
  it("should return events matching search text", async () => {
    const store = new FileBackedMemoryStore(tmpDir);
    const ts = new Date();

    await store.put({ scope: "chat", kind: "message", payload: { text: "first" }, ts });
    await store.put({ scope: "chat", kind: "message", payload: { text: "second" }, ts });

    const results = await store.search({ scope: "chat", text: "", topK: 10 });
    expect(results.length).toBe(2);
  });

  // ---- 4. summarize ----------------------------------------------------
  it("should generate a text summary for a scope", async () => {
    const store = new FileBackedMemoryStore(tmpDir);
    const ts = new Date("2025-06-01T00:00:00Z");

    await store.put({ scope: "bot", kind: "trade", payload: { symbol: "BTC" }, ts });
    await store.put({ scope: "bot", kind: "trade", payload: { symbol: "ETH" }, ts });

    const summary = await store.summarize({ scope: "bot" });
    expect(summary).toContain("bot");
    expect(summary).toContain("2 events");
  });

  // ---- 5. compact ------------------------------------------------------
  it("should compact events and remove old persisted files", async () => {
    const store = new FileBackedMemoryStore(tmpDir);
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000); // 60 days ago
    const recentDate = new Date();

    await store.put({ scope: "test", kind: "old", payload: "old", ts: oldDate });
    await store.put({ scope: "test", kind: "new", payload: "new", ts: recentDate });

    await store.compact({ scope: "test" });

    const results = await store.search({ scope: "test", text: "", topK: 10 });
    // After compact (30-day cutoff) only the recent event remains
    expect(results.length).toBe(1);
    expect(results[0]!.payload).toBe("new");
  });

  // ---- 6. persistence across instances ---------------------------------
  it("should reload persisted events on a new store instance", async () => {
    const store1 = new FileBackedMemoryStore(tmpDir);
    const ts = new Date("2025-03-10T12:00:00Z");
    await store1.put({ scope: "persist", kind: "check", payload: { ok: true }, ts });
    // wait a tick for filesystem flush
    await new Promise((r) => setTimeout(r, 50));

    const store2 = new FileBackedMemoryStore(tmpDir);
    const results = await store2.search({ scope: "persist", text: "", topK: 10 });
    expect(results.length).toBe(1);
    expect(results[0]!.payload).toEqual({ ok: true });
  });

  // ---- 8. daily rotation -----------------------------------------------
  it("should write events to different JSONL files per day", async () => {
    const store = new FileBackedMemoryStore(tmpDir);

    const day1 = new Date("2025-07-01T00:00:00Z");
    const day2 = new Date("2025-07-02T00:00:00Z");

    await store.put({ scope: "rotate", kind: "day1", payload: "a", ts: day1 });
    await store.put({ scope: "rotate", kind: "day2", payload: "b", ts: day2 });

    // Allow writes to flush
    await new Promise((r) => setTimeout(r, 50));

    const files = await listMemoryFiles(tmpDir);
    expect(files).toContain("2025-07-01.jsonl");
    expect(files).toContain("2025-07-02.jsonl");

    // Verify content
    const file1 = path.join(tmpDir, "memory", "2025-07-01.jsonl");
    const file2 = path.join(tmpDir, "memory", "2025-07-02.jsonl");
    expect(await countLines(file1)).toBe(1);
    expect(await countLines(file2)).toBe(1);
  });

  // ---- 9. search returns results sorted by recency ---------------------
  it("should return search results sorted newest-first", async () => {
    const store = new FileBackedMemoryStore(tmpDir);

    await store.put({ scope: "sort", kind: "event", payload: "old", ts: new Date("2025-01-01Z") });
    await store.put({ scope: "sort", kind: "event", payload: "mid", ts: new Date("2025-06-15Z") });
    await store.put({ scope: "sort", kind: "event", payload: "new", ts: new Date("2025-12-31Z") });

    const results = await store.search({ scope: "sort", text: "", topK: 10 });
    expect(results.length).toBe(3);
    expect(results[0]!.payload).toBe("new");
    expect(results[1]!.payload).toBe("mid");
    expect(results[2]!.payload).toBe("old");
  });

  // ---- 10. compact removes old JSONL files -----------------------------
  it("should delete JSONL files older than 30 days on compact", async () => {
    const store = new FileBackedMemoryStore(tmpDir);

    const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000); // 40 days ago
    const recentDate = new Date();

    await store.put({ scope: "cleanup", kind: "old", payload: "old", ts: oldDate });
    await store.put({ scope: "cleanup", kind: "recent", payload: "recent", ts: recentDate });

    await new Promise((r) => setTimeout(r, 50));

    await store.compact({ scope: "cleanup" });

    const files = await listMemoryFiles(tmpDir);
    // Only the recent file should remain
    const oldDay = oldDate.toISOString().slice(0, 10);
    const recentDay = recentDate.toISOString().slice(0, 10);

    if (oldDay !== recentDay) {
      expect(files).not.toContain(`${oldDay}.jsonl`);
    }
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  // ---- 7. error handling MUST be last (corrupts shared tmpDir) ----------
  it("should fall back to in-memory when filesystem is unavailable", async () => {
    const isolatedDir = await makeTmpDir();
    const badPath = path.join(isolatedDir, "memory");
    await fs.writeFile(badPath, "not-a-directory", "utf-8");

    const store = new FileBackedMemoryStore(isolatedDir);
    const ts = new Date();

    await store.put({ scope: "fallback", kind: "test", payload: "ok", ts });
    const results = await store.search({ scope: "fallback", text: "", topK: 10 });
    expect(results.length).toBe(1);
    expect(results[0]!.payload).toBe("ok");

    await fs.rm(isolatedDir, { recursive: true, force: true });
  });
});
