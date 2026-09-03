import { afterEach, describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { getWorkspacePath, initWorkspace } from './workspace-init';

describe('workspace-init', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['DYNA_WORKSPACE'];
  });

  it('prefers DYNA_WORKSPACE when set', () => {
    process.env['DYNA_WORKSPACE'] = 'C:/custom/dynatrader';

    expect(getWorkspacePath()).toBe('C:/custom/dynatrader');
  });

  it('falls back to the home workspace when no override is set', () => {
    expect(getWorkspacePath()).toBe(join(homedir(), '.dynatrader'));
  });
});

describe("trading-dedicated SOUL.md template", () => {
  it("generates SOUL.md referencing risk tools and trading-only scope", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ws-init-soul-"));
    try {
      await initWorkspace(dir);
      const soul = readFileSync(join(dir, ".dynatrader", "SOUL.md"), "utf-8");
      expect(soul).toContain("trading_halt_status");
      expect(soul).toContain("check_circuit_breakers");
      expect(soul).toContain("halt_trading");
      expect(soul).toContain("dedicated quantitative trading agent");
      expect(soul).toContain("out of scope");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("MISSION.md template", () => {
  it("generates MISSION.md with standing-directive sections", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ws-init-mission-"));
    try {
      await initWorkspace(dir);
      const mission = readFileSync(join(dir, ".dynatrader", "MISSION.md"), "utf-8");
      expect(mission).toContain("# MISSION.md");
      expect(mission).toContain("## Objective");
      expect(mission).toContain("## Success Criteria");
      expect(mission).toContain("## Status");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
