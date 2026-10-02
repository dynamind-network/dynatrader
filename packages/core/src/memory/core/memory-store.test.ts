import { describe, expect, test } from "vitest";
import { InMemoryStore, MemoryStoreImpl } from "./memory-store";

describe("InMemoryStore", () => {
  test("hides archived source records from active search but preserves archive lookup", async () => {
    const store = new InMemoryStore();
    const timestamp = new Date();
    await store.put({ id: "source", scope: "agent_memory", kind: "note", payload: { content: "active fact" }, timestamp });
    await store.put({ id: "archive-source", scope: "agent_memory", kind: "note:archived", payload: { originalId: "source" }, timestamp });

    expect(await store.search({ scope: "agent_memory", limit: 10 })).toEqual([]);
    expect(await store.search({ scope: "agent_memory", includeArchived: true, limit: 10 })).toHaveLength(2);
    expect(await store.search({ scope: "agent_memory", kind: "note:archived", limit: 10 })).toHaveLength(1);
  });

  test("merges duplicate memories during compaction", async () => {
    const store = new InMemoryStore();
    const now = new Date();

    await store.put({
      id: "mem-1",
      scope: "agent_memory",
      kind: "note",
      payload: { topic: "loop", detail: "duplicate" },
      timestamp: now,
    });

    await store.put({
      id: "mem-2",
      scope: "agent_memory",
      kind: "note",
      payload: { topic: "loop", detail: "duplicate" },
      timestamp: new Date(now.getTime() - 1_000),
    });

    await store.compact("agent_memory");

    const results = await store.search({ scope: "agent_memory", text: "duplicate", limit: 10 });
    expect(results).toHaveLength(1);

    const merged = await store.get(results[0]!.id);
    expect(merged?.metadata?.["frequency"]).toBeGreaterThanOrEqual(2);
    expect(merged?.metadata?.["consolidationCount"]).toBeGreaterThan(0);
  });

  test("prunes stale low-value memories during compaction", async () => {
    const store = new InMemoryStore();
    const stale = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);

    await store.put({
      id: "stale-1",
      scope: "agent_memory",
      kind: "note",
      payload: { topic: "old" },
      timestamp: stale,
    });

    await store.compact("agent_memory");

    const results = await store.search({ scope: "agent_memory", text: "old", limit: 10 });
    expect(results).toHaveLength(0);
  });

  test("ranks relevant memories ahead of generic ones and updates access metadata", async () => {
    const store = new InMemoryStore();

    await store.put({
      id: "generic-1",
      scope: "agent_memory",
      kind: "note",
      payload: { topic: "misc", detail: "general observation" },
      timestamp: new Date(),
    });

    await store.put({
      id: "btc-1",
      scope: "agent_memory",
      kind: "note",
      payload: { topic: "btc", detail: "BTC breakout strategy with explicit BTC context" },
      timestamp: new Date(),
    });

    const results = await store.search({ scope: "agent_memory", text: "BTC breakout", limit: 2 });
    expect(results[0]?.id).toBe("btc-1");

    const touched = await store.get("btc-1");
    expect(touched?.metadata?.accessCount).toBeGreaterThan(0);
    expect(touched?.metadata?.frequency).toBeGreaterThan(0);
  });
});

describe("MemoryStoreImpl audit events", () => {
  test("filters audit events and returns them in chronological order", async () => {
    const store = new MemoryStoreImpl();
    const events = [
      { id: "late", userId: "u1", type: "AUTH_FAILURE", severity: "warning", ipAddress: "192.0.2.1", timestamp: 30 },
      { id: "match", userId: "u1", type: "AUTH_FAILURE", severity: "warning", ipAddress: "192.0.2.1", timestamp: 20 },
      { id: "wrong-user", userId: "u2", type: "AUTH_FAILURE", severity: "warning", ipAddress: "192.0.2.1", timestamp: 15 },
      { id: "wrong-type", userId: "u1", type: "LOGOUT", severity: "warning", ipAddress: "192.0.2.1", timestamp: 18 },
      { id: "too-early", userId: "u1", type: "AUTH_FAILURE", severity: "warning", ipAddress: "192.0.2.1", timestamp: 9 },
    ];
    for (const event of events) await store.setAuditEvent(event.id, event);

    const result = await store.getAuditEvents({
      userId: "u1",
      type: "AUTH_FAILURE",
      severity: "warning",
      ipAddress: "192.0.2.1",
      start: 10,
      end: 30,
    }) as Array<{ id: string }>;

    expect(result.map((event) => event.id)).toEqual(["match", "late"]);
  });

  test("paginates filtered events while counting the full filtered result", async () => {
    const store = new MemoryStoreImpl();
    for (let timestamp = 1; timestamp <= 3; timestamp += 1) {
      const event = { id: `event-${timestamp}`, userId: "u1", type: "AUTH_SUCCESS", severity: "info", ipAddress: "192.0.2.1", timestamp };
      await store.setAuditEvent(event.id, event);
    }

    const filters = { userId: "u1", type: "AUTH_SUCCESS", limit: 1, offset: 1 };
    const page = await store.getAuditEvents(filters) as Array<{ id: string }>;

    expect(page.map((event) => event.id)).toEqual(["event-2"]);
    expect(await store.getAuditEventCount(filters)).toBe(3);
  });

  test("archives only valid audit events at or before the cutoff", async () => {
    const store = new MemoryStoreImpl();
    await store.setAuditEvent("old", { id: "old", timestamp: 10 });
    await store.setAuditEvent("cutoff", { id: "cutoff", timestamp: 20 });
    await store.setAuditEvent("new", { id: "new", timestamp: 21 });
    await store.setCacheItem("audit:malformed", { id: "malformed", timestamp: "10" });
    await store.setCacheItem("not-audit", { id: "unrelated", timestamp: 1 });

    await store.archiveAuditEvents(20);

    expect((await store.getAuditEvents()).map((event) => (event as { id: string }).id)).toEqual(["new"]);
    expect(await store.getCacheItem("audit:malformed")).toEqual({ id: "malformed", timestamp: "10" });
    expect(await store.getCacheItem("not-audit")).toEqual({ id: "unrelated", timestamp: 1 });
  });
});
