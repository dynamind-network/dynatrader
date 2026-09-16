import { describe, expect, test } from "vitest";
import { InMemoryStore } from "./memory-store";

describe("InMemoryStore", () => {
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
