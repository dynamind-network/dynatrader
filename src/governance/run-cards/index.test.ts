import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunCardManager } from "./index";

describe("RunCardManager", () => {
  let workspace = "";

  afterEach(async () => {
    if (workspace) {
      await rm(workspace, { recursive: true, force: true });
      workspace = "";
    }
  });

  it("persists, reloads, and attaches artifacts to run cards", async () => {
    workspace = await mkdtemp(join(tmpdir(), "dyna-run-card-"));
    const manager = new RunCardManager(workspace);

    const runCard = await manager.createRunCard({ mode: "paper", agentName: "agent-a" });
    await manager.startRun(runCard.runId);
    const artifactPath = await manager.addArtifact(runCard.runId, { ok: true }, "Snapshot");
    await manager.completeRun(runCard.runId, { verdict: "hold", summary: "done", artifacts: [artifactPath] });

    const loaded = await manager.getRunCard(runCard.runId);
    expect(loaded).not.toBeNull();
    expect(loaded?.status).toBe("completed");
    expect(loaded?.artifacts).toContain(artifactPath);

    const cards = await manager.getRunCards("paper", 10);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.runId).toBe(runCard.runId);

    const artifactContent = JSON.parse(await readFile(artifactPath, "utf8"));
    expect(artifactContent).toEqual({ ok: true });
  });
});
