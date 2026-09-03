import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

function createTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dynamind-agent-defaults-'));
}

describe('resolveSubagentMaxTurns', () => {
  afterEach(() => {
    delete process.env.DYNAMIND_WORKSPACE_DIR;
  });

  it('reads the workspace terminal maxTurns setting', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dynamind-workspace-'));
    process.env.DYNAMIND_WORKSPACE_DIR = workspace;

    fs.mkdirSync(path.join(workspace, '.dynamind'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.dynamind', 'config.json'),
      JSON.stringify({ terminal: { maxTurns: 27 } }),
      'utf-8'
    );

    const { resolveSubagentMaxTurns } = await import('../src/config/agent-defaults.js');
    expect(resolveSubagentMaxTurns()).toBe(27);
  });

  it('falls back to a safe default when workspace config is missing', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dynamind-workspace-'));
    process.env.DYNAMIND_WORKSPACE_DIR = workspace;

    const { resolveSubagentMaxTurns } = await import('../src/config/agent-defaults.js');
    expect(resolveSubagentMaxTurns()).toBe(12);
  });
});
