import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { glob } from 'glob';
import matter from 'gray-matter';
import type { Skill, AgentFrontmatter } from './types.js';
import { AgentFrontmatterSchema } from './types.js';
import { getErrorMessage } from '../utils/index.js';
import { parseJson } from '../utils/json.js';
import { processShellBlocks } from '../utils/shell-executor.js';
import { resolveTemplate, buildDefaultVariables } from '../utils/template-engine.js';
import { getDynamindPath, DYNAMIND_DIR } from '../utils/constants.js';

interface SkillFrontmatter {
  name?: string;
  description?: string;
  allowed_tools?: string[];
  allowedTools?: string[];
  paths?: string[];
  argument_hint?: string;
  argumentHint?: string;
  model?: string;
}

type SkillManagerOptions =
  | string
  | {
      projectDir?: string;
      globalDir?: string;
      activatedFilePath?: string;
      workingDir?: string;
    };

export class SkillManager {
  private skills: Map<string, Skill> = new Map();
  private activatedSkills: Set<string> = new Set();
  private projectBaseDir: string;
  private globalBaseDir?: string;
  private activatedFilePath: string;
  private workingDir: string;
  private loaded: boolean = false;

  constructor(options?: SkillManagerOptions) {
    if (typeof options === 'string') {
      this.projectBaseDir = options;
      this.workingDir = process.cwd();
    } else {
      this.projectBaseDir = options?.projectDir ?? '.dynamind/skills';
      this.globalBaseDir = options?.globalDir ?? getDynamindPath('skills');
      this.workingDir = options?.workingDir ?? process.cwd();
    }

    this.activatedFilePath =
      options && typeof options !== 'string' && options.activatedFilePath
        ? options.activatedFilePath
        : getDynamindPath('activated-skills.json');
  }

  async discoverAndLoad(): Promise<void> {
    if (this.loaded) return;

    try {
      await this.loadActivatedSkills();

      const targets = this.getScanTargets();

      for (const target of targets) {
        try {
          const pattern = path.join(target.dir, '**/SKILL.md');
          const files = await glob(pattern, {
            ignore: ['**/node_modules/**'],
          });

          for (const file of files) {
            await this.loadSkill(file, target.scope);
          }
        } catch (err) {
          console.warn(`[SkillManager] Failed to scan ${target.dir}:`, getErrorMessage(err));
        }
      }

      const projectRoot = path.resolve(this.projectBaseDir, '..', '..');
      const agentsFile = path.join(projectRoot, 'AGENTS.md');
      try {
        await fs.access(agentsFile);
        await this.loadSkillsFromAgentsFile(agentsFile, 'project');
      } catch {
        // AGENTS.md not present
      }

      this.loaded = true;
    } catch (error) {
      console.error(`[SkillManager] Failed to discover skills:`, getErrorMessage(error));
    }
  }

  private getScanTargets(): Array<{
    scope: 'project' | 'global';
    dir: string;
  }> {
    const targets: Array<{ scope: 'project' | 'global'; dir: string }> = [];

    if (this.globalBaseDir) {
      targets.push({ scope: 'global', dir: this.globalBaseDir });
    }

    targets.push({ scope: 'project', dir: this.projectBaseDir });

    return targets;
  }

  private async loadActivatedSkills(): Promise<void> {
    try {
      const content = await fs.readFile(this.activatedFilePath, 'utf-8');
      const activated = parseJson<string[]>(content);
      if (Array.isArray(activated)) {
        activated.forEach((id: string) => this.activatedSkills.add(id));
      }
    } catch {
      // No activated skills file yet
    }
  }

  private async saveActivatedSkills(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.activatedFilePath), { recursive: true });
      const content = JSON.stringify(Array.from(this.activatedSkills), null, 2);
      await fs.writeFile(this.activatedFilePath, content, 'utf-8');
    } catch (error) {
      console.error(`[SkillManager] Failed to save activated skills:`, getErrorMessage(error));
    }
  }

  private async loadSkill(
    filePath: string,
    scope: 'project' | 'global' = 'project'
  ): Promise<Skill | null> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = matter(content);
      const dirName = path.basename(path.dirname(filePath));
      const data = parsed.data as SkillFrontmatter;

      const id = dirName.toLowerCase().replace(/\s+/g, '-');
      const skillDir = path.dirname(filePath);

      let body = parsed.content.trim();

      body = await processShellBlocks(body, {
        workingDir: this.workingDir,
      });

      const variables = buildDefaultVariables({
        SKILL_DIR: skillDir,
        PROJECT_ROOT: path.resolve(this.projectBaseDir, '..', '..'),
        WORKING_DIR: this.workingDir,
      });
      body = resolveTemplate(body, variables);

      const skill: Skill = {
        id,
        name: data.name || dirName,
        description: data.description || '',
        body,
        allowedTools: data.allowed_tools || data.allowedTools || [],
        filePath,
        enabled: this.activatedSkills.has(id),
        scope,
        paths: data.paths || data.argument_hint?.split(',').map((p) => p.trim()),
        argumentHint: data.argument_hint || data.argumentHint,
        model: data.model,
      };

      this.skills.set(skill.id, skill);
      return skill;
    } catch (error) {
      console.error(
        `[SkillManager] Failed to load skill from ${filePath}:`,
        getErrorMessage(error)
      );
      return null;
    }
  }

  private async loadSkillsFromAgentsFile(
    filePath: string,
    scope: 'project' | 'global' = 'project'
  ): Promise<void> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const blockRegex = /---\n([\s\S]*?)\n---\n([\s\S]*?)(?=\n---\n|$)/g;
      let match: RegExpExecArray | null;
      let index = 0;
      while ((match = blockRegex.exec(content)) !== null) {
        const block = `---\n${match[1]}\n---\n${match[2]}`;
        const parsed = matter(block);
        const mode = (parsed.data as any).mode;
        if (mode && mode.skill) {
          const data = parsed.data as SkillFrontmatter;
          const name = data.name || `skill-${index}`;
          const id = name.toLowerCase().replace(/\s+/g, '-');

          let body = parsed.content.trim();
          body = await processShellBlocks(body, {
            workingDir: this.workingDir,
          });

          const variables = buildDefaultVariables({
            PROJECT_ROOT: path.resolve(this.projectBaseDir, '..', '..'),
            WORKING_DIR: this.workingDir,
          });
          body = resolveTemplate(body, variables);

          const skill: Skill = {
            id,
            name,
            description: data.description || '',
            body,
            allowedTools: data.allowed_tools || data.allowedTools || [],
            filePath: `${filePath}#${index}`,
            enabled: (data as any).enabled !== false,
            scope,
            paths: data.paths,
            argumentHint: data.argument_hint || data.argumentHint,
            model: data.model,
          };
          this.skills.set(id, skill);
          index++;
        }
      }
    } catch (error) {
      console.error(
        `[SkillManager] Failed to parse AGENTS.md ${filePath}:`,
        getErrorMessage(error)
      );
    }
  }

  getSkill(id: string): Skill | undefined {
    return this.skills.get(id.toLowerCase().replace(/\s+/g, '-'));
  }

  getAll(): Skill[] {
    return Array.from(this.skills.values());
  }

  getActivated(): Skill[] {
    return this.getAll().filter((s) => this.activatedSkills.has(s.id));
  }

  getAvailable(): Skill[] {
    return this.getAll().filter((s) => !this.activatedSkills.has(s.id));
  }

  getConditional(): Skill[] {
    return this.getAll().filter((s) => s.paths && s.paths.length > 0);
  }

  async activateSkill(id: string): Promise<boolean> {
    const skill = this.getSkill(id);
    if (!skill) return false;

    this.activatedSkills.add(id);
    await this.saveActivatedSkills();
    return true;
  }

  async deactivateSkill(id: string): Promise<boolean> {
    const skill = this.getSkill(id);
    if (!skill) return false;

    this.activatedSkills.delete(id);
    await this.saveActivatedSkills();
    return true;
  }

  isActivated(id: string): boolean {
    return this.activatedSkills.has(id.toLowerCase().replace(/\s+/g, '-'));
  }

  async getSkillForContext(query: string): Promise<Skill | undefined> {
    const activated = this.getActivated();
    if (activated.length === 0) return undefined;

    const lowerQuery = query.toLowerCase();
    let bestMatch: Skill | null = null;
    let bestScore = 0;

    for (const skill of activated) {
      let score = 0;

      if (skill.name.toLowerCase().includes(lowerQuery)) {
        score += 10;
      }
      if (skill.description.toLowerCase().includes(lowerQuery)) {
        score += 5;
      }
      if (lowerQuery.includes(skill.name.toLowerCase())) {
        score += 3;
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = skill;
      }
    }

    return bestScore >= 3 ? (bestMatch ?? undefined) : undefined;
  }

  async getSkillsForFile(filePath: string): Promise<Skill[]> {
    const conditional = this.getConditional();
    const matches: Skill[] = [];

    for (const skill of conditional) {
      if (!skill.paths) continue;
      for (const pattern of skill.paths) {
        try {
          const matched = await glob(pattern, {
            cwd: this.workingDir,
            absolute: true,
          });
          if (matched.some((m) => filePath === m || filePath.includes(m))) {
            matches.push(skill);
            break;
          }
        } catch {
          // Pattern invalid
        }
      }
    }

    return matches;
  }

  async createSkillDirectory(
    name: string,
    description: string,
    body: string
  ): Promise<string | null> {
    const skillDir = path.join(this.projectBaseDir, name);
    const filePath = path.join(skillDir, 'SKILL.md');

    try {
      await fs.mkdir(skillDir, { recursive: true });

      const frontmatter: Record<string, unknown> = {
        name,
        description,
      };

      const content = (
        matter as {
          stringify: (input: string, data: Record<string, unknown>) => string;
        }
      ).stringify(body, frontmatter);
      await fs.writeFile(filePath, content, 'utf-8');

      await this.loadSkill(filePath, 'project');
      return skillDir;
    } catch (error) {
      console.error(`[SkillManager] Failed to create skill ${name}:`, getErrorMessage(error));
      return null;
    }
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  clear(): void {
    this.skills.clear();
    this.activatedSkills.clear();
    this.loaded = false;
  }
}
