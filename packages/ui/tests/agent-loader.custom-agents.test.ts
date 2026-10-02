import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import { AgentLoader } from '../src/agents/agent-loader.js';
import { SubagentRegistry } from '../src/agents/subagent.js';

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeAgent(
  baseDir: string,
  id: string,
  frontmatter: Record<string, unknown>,
  body: string
): Promise<void> {
  await fs.mkdir(baseDir, { recursive: true });
  await fs.writeFile(
    path.join(baseDir, `${id}.md`),
    matter.stringify(body, { name: id, ...frontmatter }),
    'utf8'
  );
}

describe('custom agent discovery', () => {
  const cleanupTargets: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupTargets.splice(0).map((target) => fs.rm(target, { recursive: true, force: true }))
    );
  });

  it('prefers project agents over global agents on name collision', async () => {
    const projectDir = await makeTempDir('dynamind-project-agents-');
    const globalDir = await makeTempDir('dynamind-global-agents-');
    cleanupTargets.push(projectDir, globalDir);

    await writeAgent(
      globalDir,
      'researcher',
      {
        description: 'Global version',
        enabled: true,
        hidden: false,
        mode: { subagent: true, skill: false, command: false },
        agent: { maxTurns: 12 },
      },
      'Global prompt'
    );
    await writeAgent(
      projectDir,
      'researcher',
      {
        description: 'Project version',
        enabled: true,
        hidden: false,
        mode: { subagent: true, skill: false, command: false },
        agent: { maxTurns: 18 },
      },
      'Project prompt'
    );

    const registry = new SubagentRegistry({ projectDir, globalDir });
    await registry.initialize();

    expect(registry.get('researcher')?.description).toBe('Project version');
    expect(registry.get('researcher')?.systemPrompt).toBe('Project prompt');
  });

  it('hides hidden agents from visible autocomplete while keeping them callable', async () => {
    const projectDir = await makeTempDir('dynamind-project-agents-');
    cleanupTargets.push(projectDir);

    await writeAgent(
      projectDir,
      'stealth',
      {
        description: 'Hidden but callable',
        enabled: true,
        hidden: true,
        mode: { subagent: true, skill: false, command: false },
        agent: { maxTurns: 9 },
      },
      'Hidden prompt'
    );

    const registry = new SubagentRegistry({ projectDir, globalDir: undefined });
    await registry.initialize();

    // Hidden agents are excluded from getNames() (the public listing)
    expect(registry.getNames()).not.toContain('stealth');
    // But they are still callable via get()
    expect(registry.get('stealth')?.systemPrompt).toBe('Hidden prompt');
  });

  it('lists both project and global paths from the loader', () => {
    const projectDir = path.join('project', '.dynamind', 'agents');
    const globalDir = path.join('home', '.dynamind', 'agents');

    const loader = new AgentLoader({ projectDir, globalDir });

    expect(loader.getPaths()).toEqual({ project: projectDir, global: globalDir });
  });

  it('skips unnamed agent files instead of inventing discoverable names', async () => {
    const projectDir = await makeTempDir('dynamind-unnamed-agents-');
    cleanupTargets.push(projectDir);

    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, 'mystery.md'),
      matter.stringify('Unnamed body', {
        enabled: true,
        hidden: false,
        mode: { subagent: true, skill: false, command: false },
      }),
      'utf8'
    );

    const loader = new AgentLoader({ projectDir, globalDir: undefined });
    await loader.discoverAndLoad();

    expect(loader.getAll().map((agent) => agent.id)).not.toContain('mystery');
  });

  it('loads existing subagent frontmatter with a name inferred from its filename', async () => {
    const projectDir = await makeTempDir('dynamind-project-agents-');
    cleanupTargets.push(projectDir);
    await fs.writeFile(path.join(projectDir, 'explore.md'), [
      '---',
      'description: Read-only exploration',
      'mode: subagent',
      'permission:',
      '  read: allow',
      '  write: deny',
      '---',
      'Inspect and summarize.',
    ].join('\n'), 'utf8');
    const loader = new AgentLoader({ projectDir });

    await loader.discoverAndLoad();

    expect(loader.getAgent('explore')?.frontmatter.mode?.subagent).toBe(true);
    expect(loader.getAgent('explore')?.frontmatter.agent?.maxTurns).toBe(50);
    expect(loader.getAgent('explore')?.body).toBe('Inspect and summarize.');
  });
});
