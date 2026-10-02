import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersistentMemory } from "./persistent-memory";

describe("PersistentMemory", () => {
  let workspace = "";
  afterEach(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  it("recalls entries after creating a new instance", async () => {
    workspace = await mkdtemp(join(tmpdir(), "dyna-memory-"));
    await new PersistentMemory(workspace).remember({ kind: "task", content: "Fixed a websocket reconnect loop" });
    const results = await new PersistentMemory(workspace).recall("websocket");
    expect(results).toHaveLength(1);
    expect(results[0]?.kind).toBe("task");
  });
});
