import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import { AgentLoader } from '../src/agents/agent-loader.js';
import {
  buildWorkspaceContextPrompt,
  loadWorkspaceIdentitySync,
  resolveWorkspaceAgentDirectories,
} from '../src/config/workspace-context.js';
import { getHomeDirectory } from '../src/utils/constants.js';

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('workspace context loading', () => {
  const cleanupTargets: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupTargets.splice(0).map((target) => fs.rm(target, { recursive: true, force: true }))
    );
  });

  it('reads identity frontmatter and includes workspace files in the prompt', async () => {
    const cwd = await makeTempDir('dynamind-workspace-context-');
    cleanupTargets.push(cwd);

    await fs.writeFile(
      path.join(cwd, 'IDENTITY.md'),
      matter.stringify('# Identity body', {
        name: 'Alice',
        role: 'Research agent',
      }),
      'utf8'
    );
    await fs.writeFile(path.join(cwd, 'SOUL.md'), '# Soul body', 'utf8');
    await fs.writeFile(path.join(cwd, 'USER.md'), '# User body', 'utf8');

    const identity = loadWorkspaceIdentitySync(cwd);
    expect(identity?.name).toBe('Alice');
    expect(identity?.role).toBe('Research agent');

    const prompt = buildWorkspaceContextPrompt(cwd);
    expect(prompt).toContain('Workspace instructions define identity');
    expect(prompt).toContain('## Identity');
    expect(prompt).toContain('Alice — Research agent');
    expect(prompt).toContain('## SOUL.md');
    expect(prompt).toContain('## IDENTITY.md');
    expect(prompt).toContain('## Available on demand');
    expect(prompt).toContain('- USER.md (user preferences)');
  });

  it('requires explicit names when creating new agents', async () => {
    const baseDir = await makeTempDir('dynamind-agent-create-');
    cleanupTargets.push(baseDir);

    const loader = new AgentLoader({ projectDir: baseDir, globalDir: undefined });
    const result = await loader.createAgent(
      'no-name',
      {
        description: 'Missing explicit name',
        agent: { maxTurns: 8 },
      },
      'Body'
    );

    expect(result).toBeNull();
    await expect(fs.access(path.join(baseDir, 'no-name.md'))).rejects.toThrow();
  });

  it('uses DynaTrader project agents and the canonical agent workspace, not another CLI home', async () => {
    const cwd = await makeTempDir('dynamind-agent-roots-');
    cleanupTargets.push(cwd);
    const roots = resolveWorkspaceAgentDirectories(cwd);
    expect(roots.project).toEqual([path.join(cwd, '.dynamind', 'agents')]);
    expect(roots.global).toEqual([path.join(getHomeDirectory(), '.dynatrader', 'workspace', 'agents')]);
    expect(roots.project.join('\n')).not.toContain('.codex');
    expect(roots.global.join('\n')).not.toContain('.codex');
  });
});
