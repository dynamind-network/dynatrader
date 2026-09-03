import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import matter from 'gray-matter';
import { AgentFrontmatterSchema, type AgentFrontmatter, type LoadedAgent } from './types.js';
import { getErrorMessage } from '../utils/index.js';

function createDefaultFrontmatter(): AgentFrontmatter {
  return {
    enabled: true,
    hidden: false,
    mode: { subagent: false, skill: false, command: false },
    tools: [],
  };
}

type AgentLoaderOptions =
  | string
  | {
      projectDir?: string;
      projectDirs?: string[];
      globalDir?: string;
      globalDirs?: string[];
    };

export class AgentLoader {
  private agents: Map<string, LoadedAgent> = new Map();
  private projectBaseDirs: string[] = [];
  private globalBaseDirs: string[] = [];
  private loaded: boolean = false;

  constructor(options?: AgentLoaderOptions) {
    if (typeof options === 'string') {
      this.projectBaseDirs = [options];
      return;
    }

    this.projectBaseDirs = [
      ...(options?.projectDirs ?? []),
      ...(options?.projectDir ? [options.projectDir] : []),
    ];
    this.globalBaseDirs = [
      ...(options?.globalDirs ?? []),
      ...(options?.globalDir ? [options.globalDir] : []),
    ];
  }

  private getScanTargets(): Array<{
    scope: 'project' | 'global';
    dir: string;
  }> {
    const targets: Array<{ scope: 'project' | 'global'; dir: string }> = [];

    for (const dir of this.globalBaseDirs) {
      targets.push({ scope: 'global', dir });
    }

    for (const dir of this.projectBaseDirs) {
      targets.push({ scope: 'project', dir });
    }

    return targets;
  }

  async discoverAndLoad(): Promise<void> {
    if (this.loaded) return;

    try {
      const { readdirSync } = await import('node:fs');

      const files: Array<{ filePath: string; scope: 'project' | 'global' }> = [];

      const scanDir = (baseDir: string, dir: string, scope: 'project' | 'global') => {
        if (!dir.startsWith(baseDir)) {
          dir = path.resolve(baseDir, dir);
        }
        try {
          const entries = readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              scanDir(baseDir, fullPath, scope);
            } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'AGENTS.md') {
              files.push({ filePath: fullPath, scope });
            }
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.warn('[AgentLoader] Failed to scan directory:', getErrorMessage(err));
          }
        }
      };

      // Scan the default agent directories
      for (const target of this.getScanTargets()) {
        scanDir(target.dir, '.', target.scope);
      }

      // Load each discovered markdown file
      for (const file of files) {
        await this.loadFile(file.filePath, file.scope);
      }
      this.loaded = true;
    } catch (error) {
      console.error(`[AgentLoader] Failed to discover agents:`, getErrorMessage(error));
    }
  }

  async loadFile(
    filePath: string,
    scope: 'project' | 'global' = 'project'
  ): Promise<LoadedAgent | null> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = matter(content);

      const frontmatterResult = AgentFrontmatterSchema.safeParse(parsed.data);
      const frontmatter: AgentFrontmatter = frontmatterResult.success
        ? frontmatterResult.data
        : createDefaultFrontmatter();
      const name = frontmatter.name?.trim();

      if (!name) {
        console.warn(
          `[AgentLoader] Skipping unnamed agent file ${filePath}; set frontmatter.name to make it discoverable.`
        );
        return null;
      }

      const id = name.toLowerCase().replace(/\s+/g, '-');

      const agent: LoadedAgent = {
        id,
        filePath,
        scope,
        frontmatter: {
          ...frontmatter,
          name,
        },
        body: parsed.content.trim(),
      };

      this.agents.set(id, agent);
      return agent;
    } catch (error) {
      console.error(`[AgentLoader] Failed to load agent from ${filePath}:`, getErrorMessage(error));
      return null;
    }
  }

  getAgent(id: string): LoadedAgent | undefined {
    return this.agents.get(id.toLowerCase().replace(/\s+/g, '-'));
  }

  getAll(): LoadedAgent[] {
    return Array.from(this.agents.values());
  }

  getEnabled(): LoadedAgent[] {
    return this.getAll().filter((a) => a.frontmatter.enabled);
  }

  getVisible(): LoadedAgent[] {
    return this.getEnabled().filter((a) => !a.frontmatter.hidden);
  }

  getByMode(mode: 'subagent' | 'skill' | 'command'): LoadedAgent[] {
    return this.getEnabled().filter((a) => a.frontmatter.mode?.[mode] ?? false);
  }

  getVisibleByMode(mode: 'subagent' | 'skill' | 'command'): LoadedAgent[] {
    return this.getVisible().filter((a) => a.frontmatter.mode?.[mode] ?? false);
  }

  getSubagentNames(): string[] {
    return this.getByMode('subagent').map((a) => a.id);
  }

  getSubagentDescriptions(): string[] {
    return this.getByMode('subagent').map(
      (a) => `- \`${a.id}\`: ${a.frontmatter.description || 'No description'}`
    );
  }

  async disableAgent(id: string): Promise<boolean> {
    const agent = this.getAgent(id);
    if (!agent) return false;

    try {
      const content = await fs.readFile(agent.filePath, 'utf-8');
      const parsed = matter(content);
      parsed.data.enabled = false;

      const updatedContent = (
        matter as {
          stringify: (input: string, data: Record<string, unknown>) => string;
        }
      ).stringify(parsed.content, parsed.data);
      await fs.writeFile(agent.filePath, updatedContent, 'utf-8');

      agent.frontmatter.enabled = false;
      return true;
    } catch (error) {
      console.error(`[AgentLoader] Failed to disable agent ${id}:`, getErrorMessage(error));
      return false;
    }
  }

  async enableAgent(id: string): Promise<boolean> {
    const agent = this.getAgent(id);
    if (!agent) return false;

    try {
      const content = await fs.readFile(agent.filePath, 'utf-8');
      const parsed = matter(content);
      parsed.data.enabled = true;

      const updatedContent = (
        matter as {
          stringify: (input: string, data: Record<string, unknown>) => string;
        }
      ).stringify(parsed.content, parsed.data);
      await fs.writeFile(agent.filePath, updatedContent, 'utf-8');

      agent.frontmatter.enabled = true;
      return true;
    } catch (error) {
      console.error(`[AgentLoader] Failed to enable agent ${id}:`, getErrorMessage(error));
      return false;
    }
  }

  getPaths(): { project?: string; global?: string } {
    return {
      project: this.projectBaseDirs[0],
      global: this.globalBaseDirs[0],
    };
  }

  findByName(id: string): LoadedAgent[] {
    const normalized = id.toLowerCase().replace(/\s+/g, '-');
    return this.getAll().filter((agent) => agent.id === normalized);
  }

  async createAgent(
    id: string,
    frontmatter: Partial<AgentFrontmatter>,
    body: string,
    scope: 'project' | 'global' = 'project'
  ): Promise<string | null> {
    const baseDir = scope === 'global' ? this.globalBaseDirs[0] : this.projectBaseDirs[0];

    if (!baseDir) {
      return null;
    }

    const filePath = path.join(baseDir, `${id}.md`);

    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });

      if (
        !frontmatter.agent ||
        typeof frontmatter.agent.maxTurns !== 'number' ||
        !Number.isFinite(frontmatter.agent.maxTurns) ||
        frontmatter.agent.maxTurns <= 0
      ) {
        throw new Error('Subagent maxTurns must be set explicitly.');
      }

      const explicitName = frontmatter.name?.trim();
      if (!explicitName) {
        throw new Error('Subagent name must be set explicitly.');
      }

      const normalizedId = explicitName.toLowerCase().replace(/\s+/g, '-');
      if (normalizedId !== id.toLowerCase().replace(/\s+/g, '-')) {
        throw new Error(
          `Subagent name "${explicitName}" does not match id "${id}". Use the same name in the file frontmatter and filename.`
        );
      }

      const fullFrontmatter: AgentFrontmatter = {
        name: explicitName,
        description: frontmatter.description || '',
        enabled: frontmatter.enabled ?? true,
        hidden: frontmatter.hidden ?? false,
        mode: frontmatter.mode ?? {
          subagent: true,
          skill: false,
          command: false,
        },
        agent: frontmatter.agent,
        tools: frontmatter.tools ?? [],
        mcp: frontmatter.mcp,
      };

      const frontmatterToWrite = Object.fromEntries(
        Object.entries(fullFrontmatter).filter(([, value]) => value !== undefined)
      );

      const content = (
        matter as {
          stringify: (input: string, data: Record<string, unknown>) => string;
        }
      ).stringify(body, frontmatterToWrite);
      await fs.writeFile(filePath, content, 'utf-8');

      await this.loadFile(filePath, scope);
      return filePath;
    } catch (error) {
      console.error(`[AgentLoader] Failed to create agent ${id}:`, getErrorMessage(error));
      return null;
    }
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  clear(): void {
    this.agents.clear();
    this.loaded = false;
  }
}
