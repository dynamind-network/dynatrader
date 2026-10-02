import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ToolCall, ToolDefinition, ToolHandler, ToolResult } from '@dyna/contracts';
import type { SkillLoader } from './skill-loader';
import type { Skill } from './skill-types';

/** Reads instructions or one relative support resource from a registered skill. */
export class SkillViewTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'skill_view',
    description: 'Read full instructions for one skill returned by skills_list. To read a support file, pass its relative path within that skill directory as resource_path. Skill names are exact and support paths cannot escape the selected skill directory.',
    category: 'memory',
    inputSchema: {
      skill_name: 'string',
      resource_path: 'string?',
    },
    outputSchema: { name: 'string', description: 'string', resource: 'string', contents: 'string' },
    permissionsRequired: ['tool.read'],
    sideEffects: [],
    riskLevel: 'low',
    timeoutMs: 10000,
    canRunInParallel: true,
    readOnly: true,
  };

  constructor(private readonly loader: SkillLoader) {}

  async execute(call: ToolCall): Promise<ToolResult> {
    const started = Date.now();
    try {
      const name = call.args.skill_name;
      if (typeof name !== 'string' || name.trim() !== name || !name) {
        return this.failure('skill_name must be an exact non-empty name from skills_list', started);
      }

      const skill = this.loader.getSkill(name);
      if (!skill) {
        return this.failure(`No registered skill has the exact name '${name}'. Use skills_list to see available names.`, started);
      }

      const requestedResource = call.args.resource_path;
      if (requestedResource === undefined || requestedResource === null || requestedResource === '') {
        return this.success(skill, path.basename(skill.source), skill.instructions, started);
      }
      if (typeof requestedResource !== 'string') {
        return this.failure('resource_path must be a relative path string', started);
      }

      const result = await this.readSupportResource(skill, requestedResource);
      return this.success(skill, result.relativePath, result.contents, started);
    } catch (error) {
      return this.failure(error instanceof Error ? error.message : String(error), started);
    }
  }

  private async readSupportResource(skill: Skill, requested: string): Promise<{ relativePath: string; contents: string }> {
    const relativePath = requested.replace(/\\/g, '/');
    const segments = relativePath.split('/');
    if (!relativePath || path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(requested)
      || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
      throw new Error('resource_path must be a normalized relative path within the selected skill');
    }

    // Supporting resources belong to a directory-form skill. Flat .skill.md
    // entries have no private directory and must not expose sibling skills.
    if (path.basename(skill.source).toLowerCase() !== 'skill.md') {
      throw new Error('This skill has no directory for support resources');
    }

    const skillRoot = path.resolve(path.dirname(skill.source));
    const source = path.resolve(skillRoot, ...segments);
    const relative = path.relative(skillRoot, source);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      throw new Error('resource_path must stay within the selected skill directory');
    }
    if (source.toLowerCase() === path.resolve(skill.source).toLowerCase()) {
      throw new Error('Omit resource_path to read the skill instructions');
    }

    // Reject symlinks in every path component so a resource cannot point out
    // of the registered skill directory.
    let current = skillRoot;
    for (const segment of segments) {
      current = path.join(current, segment);
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new Error('Symbolic links are not allowed in skill resource paths');
      }
    }
    const info = await lstat(source);
    if (!info.isFile()) throw new Error('resource_path must refer to a file');

    return {
      relativePath: segments.join('/'),
      contents: await readFile(source, 'utf8'),
    };
  }

  private success(skill: Skill, resource: string, contents: string, started: number): ToolResult {
    return {
      success: true,
      data: {
        name: skill.metadata.name,
        description: skill.metadata.description,
        resource,
        contents,
      },
      durationMs: Date.now() - started,
      truncated: false,
    };
  }

  private failure(error: string, started: number): ToolResult {
    return { success: false, error, durationMs: Date.now() - started, truncated: false };
  }
}
