/**
 * Skill Format Compatibility — hermes-agent / OpenClaw SKILL.md format
 *
 * DynaTrader skills follow the same convention as hermes-agent and OpenClaw:
 * a directory containing SKILL.md with YAML frontmatter (name, description)
 * plus an optional markdown body of instructions. This test locks that
 * contract in so the skill ecosystem stays compatible with the wider
 * agent-skill ecosystem (community skills drop in without conversion).
 *
 * Upstream reference:
 * - hermes-agent: skills are markdown instruction files with YAML frontmatter
 * - OpenClaw: "Skills are markdown instruction files that teach the agent how
 *   and when to use tools. Each skill lives in a directory containing a
 *   SKILL.md file with YAML frontmatter and a markdown body."
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SkillLoader } from "./skill-loader";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "skill-format-test-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("SKILL.md ecosystem compatibility", () => {
  it("loads a bare hermes/openclaw-style skill (frontmatter + markdown body)", async () => {
    // This is exactly what a community skill from the agent ecosystem looks like:
    // no skill.json, just frontmatter + body.
    const dir = join(workspaceDir, "skills", "stop-loss-discipline");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---
name: stop-loss-discipline
description: Always set a stop-loss before entering a position; never widen a losing stop.
type: risk
tags:
  - risk-management
  - exits
---

# Stop-Loss Discipline

1. Compute stop distance from recent volatility (ATR-based), never a round number.
2. If a trade moves against you, do NOT move the stop further away.
3. On exit, record whether the stop or target triggered for the learning loop.
`,
    );

    const loader = new SkillLoader();
    loader.registerPath("workspace", workspaceDir);
    await loader.loadAll();

    const skills = loader.getAllSkills();
    expect(skills.length).toBe(1);
    expect(skills[0]!.metadata.name).toBe("stop-loss-discipline");
    expect(skills[0]!.metadata.description).toContain("never widen");
    expect(skills[0]!.instructions).toContain("ATR-based");
  });

  it("rejects SKILL.md missing required frontmatter", async () => {
    const dir = join(workspaceDir, "skills", "broken-skill");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      "# No frontmatter here\n\nJust markdown body text.",
    );

    const loader = new SkillLoader();
    loader.registerPath("workspace", workspaceDir);
    await loader.loadAll();

    expect(loader.getAllSkills().length).toBe(0);
  });
});
