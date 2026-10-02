import { afterEach, describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { getStatePath, getWorkspacePath, initWorkspace } from './workspace-init';

describe('workspace-init', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['DYNA_WORKSPACE'];
    delete process.env['DYNA_STATE_DIR'];
  });

  it('prefers DYNA_WORKSPACE when set', () => {
    process.env['DYNA_WORKSPACE'] = 'C:/custom/dynatrader';

    expect(getWorkspacePath()).toBe('C:/custom/dynatrader');
  });

  it('falls back to the home workspace when no override is set', () => {
    expect(getWorkspacePath()).toBe(join(homedir(), '.dynatrader', 'workspace'));
  });

  it('keeps runtime state at DYNA_STATE_DIR and agent content in its workspace child', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dyna-state-root-'));
    process.env['DYNA_STATE_DIR'] = dir;
    try {
      expect(getStatePath()).toBe(dir);
      expect(getWorkspacePath()).toBe(join(dir, 'workspace'));
      await initWorkspace();
      expect(readFileSync(join(dir, 'config.yaml'), 'utf8')).toContain('runtime:');
      expect(readFileSync(join(dir, 'cron', 'jobs.json'), 'utf8')).toContain('risk-check-daily');
      expect(() => readFileSync(join(dir, 'workspace', 'IDENTITY.md'), 'utf8')).not.toThrow();
      expect(existsSync(join(dir, 'workspace', 'logs'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
