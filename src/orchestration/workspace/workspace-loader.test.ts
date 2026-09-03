import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceLoader } from "./workspace-loader";

describe("WorkspaceLoader loops", () => {
  let testDir: string;
  let loader: WorkspaceLoader;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "dynatrader-loop-loader-"));
    mkdirSync(join(testDir, "loops"), { recursive: true });
    writeFileSync(join(testDir, "SOUL.md"), "# soul");
    writeFileSync(join(testDir, "IDENTITY.md"), "# identity");
    writeFileSync(join(testDir, "MEMORY.md"), "# memory");
    writeFileSync(join(testDir, "USER.md"), "# user");
    writeFileSync(join(testDir, "auth.json"), JSON.stringify({ owner: "tester", approval_required_for: [] }, null, 2));
    writeFileSync(join(testDir, "config.yaml"), "risk: {}\n");
    loader = new WorkspaceLoader(testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("loads loop files without inventing a default pipeline", async () => {
    writeFileSync(
      join(testDir, "loops", "analysis.loop.json"),
      JSON.stringify(
        {
          id: "analysis-loop",
          name: "Analysis Loop",
          description: "Workspace-defined analysis loop",
          schedule: "every 15m",
          prompt: "Review market structure and report observations.",
          skills: ["market-research"],
          tags: ["analysis"],
          enabled: true,
          approvalStatus: "approved",
          executionPolicy: "close-only",
        },
        null,
        2,
      ),
    );

    const workspace = await loader.load();
    expect(workspace.loops).toHaveLength(1);
    expect(workspace.loops[0]).toMatchObject({
      id: "analysis-loop",
      name: "Analysis Loop",
      schedule: "every 15m",
      enabled: true,
      approvalStatus: "approved",
      executionPolicy: "close-only",
    });
    expect(workspace.loops[0].pipeline).toBeUndefined();
  });
});

describe("WorkspaceLoader validation", () => {
  let testDir: string;
  let loader: WorkspaceLoader;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "dynatrader-validation-"));
    mkdirSync(join(testDir, "skills"), { recursive: true });
    writeFileSync(join(testDir, "SOUL.md"), "# soul");
    writeFileSync(join(testDir, "IDENTITY.md"), "# identity");
    writeFileSync(join(testDir, "MEMORY.md"), "# memory");
    writeFileSync(join(testDir, "USER.md"), "# user");
    writeFileSync(
      join(testDir, "auth.json"),
      JSON.stringify({
        version: "1.0",
        owner: { id: "tester", role: "owner" },
        approval_required_for: [],
        blocked_operations: [],
      }, null, 2),
    );
    writeFileSync(
      join(testDir, "config.yaml"),
      [
        "workspace:",
        "  name: test",
        "runtime:",
        "  mode: paper",
        "models:",
        "  provider: ollama",
        "  model: llama3.1",
        "",
      ].join("\n"),
    );
    loader = new WorkspaceLoader(testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("fails closed when legacy config.json is present", async () => {
    writeFileSync(join(testDir, "config.json"), JSON.stringify({ legacy: true }, null, 2));

    await expect(loader.validateWorkspace()).rejects.toThrow(/config\.json/i);
  });

  it("fails closed on incomplete skill directories", async () => {
    const skillDir = join(testDir, "skills", "bad-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "skill.json"),
      JSON.stringify({
        name: "bad-skill",
        version: "1.0.0",
        description: "Bad skill",
        status: "validated",
        allowedModes: ["research"],
        permissions: { allow: [], deny: [] },
        toolsRequired: [],
        riskLevel: "low",
        review: { humanRequired: false, testsRequired: false, signatureRequired: false },
        security: {
          allowNetwork: false,
          allowFilesystem: false,
          allowCredentials: false,
          allowOrderExecution: false,
        },
      }, null, 2),
    );

    await expect(loader.validateWorkspace()).rejects.toThrow(/missing SKILL\.md/i);
  });

  it("allows valid active skill inventories and rejects pending skill directories", async () => {
    const activeSkillDir = join(testDir, "skills", "active-skill");
    mkdirSync(activeSkillDir, { recursive: true });
    writeFileSync(
      join(activeSkillDir, "skill.json"),
      JSON.stringify({
        name: "active-skill",
        version: "1.0.0",
        description: "Active skill",
        status: "validated",
        allowedModes: ["research", "backtest", "paper"],
        permissions: { allow: [], deny: [] },
        toolsRequired: [],
        riskLevel: "low",
        review: { humanRequired: false, testsRequired: false, signatureRequired: false },
        security: {
          allowNetwork: false,
          allowFilesystem: false,
          allowCredentials: false,
          allowOrderExecution: false,
        },
      }, null, 2),
    );
    writeFileSync(join(activeSkillDir, "SKILL.md"), "# Active skill");

    const pendingSkillDir = join(testDir, "skills", "pending", "proposal-one");
    mkdirSync(pendingSkillDir, { recursive: true });
    writeFileSync(
      join(pendingSkillDir, "skill.json"),
      JSON.stringify({
        name: "proposal-one",
        version: "1.0.0",
        description: "Pending strategy skill",
        status: "draft",
        allowedModes: ["research", "backtest", "paper"],
        permissions: { allow: [], deny: [] },
        toolsRequired: [],
        riskLevel: "medium",
        review: { humanRequired: true, testsRequired: true, signatureRequired: false },
        security: {
          allowNetwork: false,
          allowFilesystem: false,
          allowCredentials: false,
          allowOrderExecution: false,
        },
        approvalState: "pending",
      }, null, 2),
    );
    writeFileSync(join(pendingSkillDir, "SKILL.md"), "# Pending skill");

    await expect(loader.validateWorkspace()).rejects.toThrow(/draft skill folders/i);
  });
});
