import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearSettingsCache, updatePluginSetting } from '../src/config/settings.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

afterEach(() => {
  clearSettingsCache();
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }
});

describe('built-in tool plugins', () => {
  it('registers market tools by default, portfolio is opt-in', async () => {
    const homeDir = await makeTempDir('dynamind-home-');
    const workspaceDir = await makeTempDir('dynamind-workspace-');
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    const registry = createDefaultToolRegistry(workspaceDir);
    const toolNames = registry.getToolNames();

    expect(toolNames).toContain('market_data');
    expect(toolNames).not.toContain('portfolio');
    expect(toolNames).not.toContain('technical_analysis');
    expect(toolNames).not.toContain('multi_file');
    expect(toolNames).toContain('glob');
    expect(toolNames).toContain('grep');
  });

  it('registers enabled plugin tools from workspace settings', async () => {
    const homeDir = await makeTempDir('dynamind-home-');
    const workspaceDir = await makeTempDir('dynamind-workspace-');
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    await updatePluginSetting('market', true, workspaceDir);
    await updatePluginSetting('portfolio', true, workspaceDir);

    const registry = createDefaultToolRegistry(workspaceDir);
    const toolNames = registry.getToolNames();

    expect(toolNames).toContain('market_data');
    expect(toolNames).toContain('portfolio');
  });
});
