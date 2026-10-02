import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolCall } from '@dyna/contracts';
import { SkillLoader } from './skill-loader';
import { SkillsListTool } from './skills-list-tool';
import { SkillViewTool } from './skill-view-tool';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'dyna-skill-catalog-'));
  tempDirs.push(directory);
  return directory;
}

function toolCall(tool: string, args: Record<string, unknown>): ToolCall {
  return { id: 'skill-catalog-test', tool, args, timestamp: new Date(), correlationId: 'skill-catalog-test' } as ToolCall;
}

async function writeSkill(base: string, folder: string, name: string): Promise<string> {
  const skillDir = path.join(base, 'skills', folder);
  await mkdir(skillDir, { recursive: true });
  const source = path.join(skillDir, 'SKILL.md');
  await writeFile(source, `---\nname: ${name}\ndescription: Instructions for ${name}.\ntype: utility\ntags: [example]\n---\n\nUse ${name} carefully.\n`);
  return skillDir;
}

async function loadWorkspaceSkills(workspace: string, project?: string): Promise<SkillLoader> {
  const loader = new SkillLoader();
  loader.registerPath('workspace', workspace);
  if (project) loader.registerPath('project', project);
  await loader.loadAll();
  return loader;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('registered skill catalog tools', () => {
  it('skills_list returns sorted metadata only from loader-registered roots', async () => {
    const workspace = await makeTempDir();
    const project = await makeTempDir();
    await writeSkill(workspace, 'zeta', 'zeta');
    await writeSkill(project, 'alpha', 'alpha');
    // A matching skill outside registered roots must not be discovered.
    await writeSkill(await makeTempDir(), 'outside', 'outside');

    const loader = await loadWorkspaceSkills(workspace, project);
    const result = await new SkillsListTool(loader).execute(toolCall('skills_list', {}));

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      count: 2,
      skills: [
        { name: 'alpha', description: 'Instructions for alpha.' },
        { name: 'zeta', description: 'Instructions for zeta.' },
      ],
    });
    expect(JSON.stringify(result.data)).not.toContain('Use zeta carefully');
  });

  it('skills_list includes OpenCode skills from its singular skill directory', async () => {
    const opencode = await makeTempDir();
    const skillDir = path.join(opencode, 'skill', 'quant-review');
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: quant-review\ndescription: Review quant research.\n---\n\nCheck assumptions.\n');

    const loader = new SkillLoader();
    loader.registerPath('project', opencode);
    loader.registerPath('project', opencode, 'skill');
    await loader.loadAll();

    const result = await new SkillsListTool(loader).execute(toolCall('skills_list', {}));
    expect(result.data).toMatchObject({
      count: 1,
      skills: [{ name: 'quant-review', description: 'Review quant research.' }],
    });
  });

  it('skill_view reads full instructions by exact name and a relative support file on request', async () => {
    const workspace = await makeTempDir();
    const skillDir = await writeSkill(workspace, 'risk-check', 'risk-check');
    await mkdir(path.join(skillDir, 'references'), { recursive: true });
    await writeFile(path.join(skillDir, 'references', 'rules.md'), '# Rules\nDo not widen stops.\n');
    const loader = await loadWorkspaceSkills(workspace);
    const tool = new SkillViewTool(loader);

    const main = await tool.execute(toolCall('skill_view', { skill_name: 'risk-check' }));
    const resource = await tool.execute(toolCall('skill_view', { skill_name: 'risk-check', resource_path: 'references/rules.md' }));

    expect(main.success).toBe(true);
    expect(main.data).toMatchObject({
      name: 'risk-check',
      resource: 'SKILL.md',
      contents: 'Use risk-check carefully.',
    });
    expect(resource.data).toMatchObject({
      name: 'risk-check',
      resource: 'references/rules.md',
      contents: '# Rules\nDo not widen stops.\n',
    });
  });

  it('requires exact registered names and rejects traversal, absolute paths, and symlink escapes', async () => {
    const workspace = await makeTempDir();
    const skillDir = await writeSkill(workspace, 'risk-check', 'risk-check');
    const outside = await makeTempDir();
    await writeFile(path.join(outside, 'secret.md'), 'secret');
    await symlink(outside, path.join(skillDir, 'external'), 'junction');
    const tool = new SkillViewTool(await loadWorkspaceSkills(workspace));

    const wrongCase = await tool.execute(toolCall('skill_view', { skill_name: 'Risk-Check' }));
    const traversal = await tool.execute(toolCall('skill_view', { skill_name: 'risk-check', resource_path: '../secret.md' }));
    const absolute = await tool.execute(toolCall('skill_view', { skill_name: 'risk-check', resource_path: path.join(outside, 'secret.md') }));
    const symlinkEscape = await tool.execute(toolCall('skill_view', { skill_name: 'risk-check', resource_path: 'external/secret.md' }));

    expect(wrongCase.error).toContain('exact name');
    expect(traversal.error).toContain('relative path');
    expect(absolute.error).toContain('relative path');
    expect(symlinkEscape.error).toContain('Symbolic links');
  });

  it('exposes both tools as read-only and without write permissions', () => {
    const loader = new SkillLoader();
    for (const definition of [new SkillsListTool(loader).definition, new SkillViewTool(loader).definition]) {
      expect(definition.readOnly).toBe(true);
      expect(definition.sideEffects).toEqual([]);
      expect(definition.permissionsRequired).toEqual(['tool.read']);
    }
  });
});
