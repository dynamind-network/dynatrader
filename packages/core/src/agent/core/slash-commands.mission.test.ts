import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SlashCommandRegistry, registerDefaultCommands } from "./slash-commands";

let workspacePath: string;
let registry: SlashCommandRegistry;

const MISSION_SAMPLE = `# MISSION.md - Standing Mission

## Objective
Monitor competitor SEO news

## Success Criteria
- Weekly digest delivered

## Constraints
- Read-only research

## Status
ACTIVE
`;

beforeEach(() => {
  workspacePath = mkdtempSync(join(tmpdir(), "mission-cmd-test-"));
  mkdirSync(workspacePath, { recursive: true });
  writeFileSync(join(workspacePath, "MISSION.md"), MISSION_SAMPLE);
  registry = new SlashCommandRegistry();
  registerDefaultCommands(registry);
});

afterEach(() => {
  rmSync(workspacePath, { recursive: true, force: true });
});

function ctx() {
  return { agent: { getWorkspacePath: () => workspacePath } };
}

describe("/mission command", () => {
  it("show returns current mission content", async () => {
    const res = await registry.execute("/mission show", ctx());
    expect(res?.content).toContain("Monitor competitor SEO news");
  });

  it("set replaces the Objective section", async () => {
    await registry.execute("/mission set Track regulatory filings", ctx());
    const content = readFileSync(join(workspacePath, "MISSION.md"), "utf-8");
    expect(content).toContain("Track regulatory filings");
    expect(content).toContain("## Success Criteria");
    expect(content).not.toContain("Monitor competitor SEO news");
  });

  it("criteria add appends under Success Criteria", async () => {
    await registry.execute("/mission criteria add alert on ranking drops", ctx());
    const content = readFileSync(join(workspacePath, "MISSION.md"), "utf-8");
    expect(content).toContain("- alert on ranking drops");
    expect(content.indexOf("- alert on ranking drops")).toBeGreaterThan(
      content.indexOf("## Success Criteria"),
    );
  });

  it("status updates the status line", async () => {
    await registry.execute("/mission status PAUSED", ctx());
    const content = readFileSync(join(workspacePath, "MISSION.md"), "utf-8");
    expect(content).toMatch(/## Status\nPAUSED/);
  });

  it("rejects invalid status values", async () => {
    const res = await registry.execute("/mission status WHATEVER", ctx());
    expect(res?.content).toContain("must be");
  });

  it("reports missing MISSION.md gracefully", async () => {
    rmSync(join(workspacePath, "MISSION.md"));
    const res = await registry.execute("/mission show", ctx());
    expect(res?.content).toContain("No MISSION.md");
  });
});
