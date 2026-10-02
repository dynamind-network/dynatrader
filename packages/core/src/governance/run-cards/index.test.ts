import { afterEach, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
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
    expect(artifactPath).toContain(join(workspace, "runs"));
    await expect(readFile(join(
      workspace,
      "runs",
      new Date(loaded!.startedAt).toISOString().slice(0, 10),
      runCard.runId,
      "run_card.json",
    ), "utf8")).resolves.toContain(runCard.runId);

    const cards = await manager.getRunCards("paper", 10);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.runId).toBe(runCard.runId);

    const artifactContent = JSON.parse(await readFile(artifactPath, "utf8"));
    expect(artifactContent).toEqual({ ok: true });
  });

  it("moves legacy workspace run history into private state and repairs artifact paths", async () => {
    workspace = await mkdtemp(join(tmpdir(), "dyna-run-card-migration-"));
    const runId = "legacy-run";
    const legacyRunDir = join(workspace, "workspace", "runs", "2026-09-01", runId);
    const legacyArtifact = join(legacyRunDir, "snapshot.json");
    const legacyCardPath = join(legacyRunDir, "run_card.json");
    await mkdir(legacyRunDir, { recursive: true });
    await writeFile(legacyArtifact, JSON.stringify({ equity: 100 }), "utf8");
    await writeFile(legacyCardPath, JSON.stringify({
      runId,
      mode: "paper",
      startedAt: "2026-09-01T00:00:00.000Z",
      status: "completed",
      metrics: {},
      verdict: "hold",
      artifacts: [legacyArtifact],
    }), "utf8");

    const manager = new RunCardManager(workspace);
    const cards = await manager.getRunCards();
    const migratedArtifact = join(workspace, "runs", "2026-09-01", runId, "snapshot.json");

    expect(cards.map((card) => card.runId)).toContain(runId);
    expect(cards.find((card) => card.runId === runId)?.artifacts).toEqual([migratedArtifact]);
    await expect(readFile(migratedArtifact, "utf8")).resolves.toBe(JSON.stringify({ equity: 100 }));
    await expect(access(legacyRunDir)).rejects.toThrow();
  });
});
