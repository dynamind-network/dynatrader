import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { glob } from 'glob';
import matter from 'gray-matter';
import type { Command } from './types.js';
import { getErrorMessage } from '../utils/index.js';
import { processShellBlocks } from '../utils/shell-executor.js';
import { resolveTemplate, buildDefaultVariables } from '../utils/template-engine.js';
import { getDynamindPath } from '../utils/constants.js';

interface CommandFrontmatter {
  name?: string;
  description?: string;
  model?: string;
  subtask?: boolean;
  enabled?: boolean;
  argument_hint?: string;
  argumentHint?: string;
}

type CommandRegistryOptions =
  | string
  | {
      projectDir?: string;
      globalDir?: string;
      workingDir?: string;
    };

export class CommandRegistry {
  private commands: Map<string, Command> = new Map();
  private projectBaseDir: string;
  private globalBaseDir?: string;
  private workingDir: string;
  private loaded: boolean = false;

  constructor(options?: CommandRegistryOptions) {
    if (typeof options === 'string') {
      this.projectBaseDir = options;
      this.workingDir = process.cwd();
    } else {
      this.projectBaseDir = options?.projectDir ?? '.dynamind/commands';
      this.globalBaseDir = options?.globalDir ?? getDynamindPath('commands');
      this.workingDir = options?.workingDir ?? process.cwd();
    }
  }

  async discoverAndLoad(): Promise<void> {
    if (this.loaded) return;

    try {
      const targets = this.getScanTargets();

      for (const target of targets) {
        try {
          const files = await glob(path.join(target.dir, '*.md'), {
            ignore: ['**/node_modules/**'],
          });

          for (const file of files) {
            await this.loadCommand(file, target.scope);
          }
        } catch (err) {
          console.warn(`[CommandRegistry] Failed to scan ${target.dir}:`, getErrorMessage(err));
        }
      }

      const projectRoot = path.resolve(this.projectBaseDir, '..', '..');
      const agentsFile = path.join(projectRoot, 'AGENTS.md');
      try {
        await fs.access(agentsFile);
        await this.loadCommandsFromAgentsFile(agentsFile, 'project');
      } catch {
        // AGENTS.md not present
      }

      this.loaded = true;
    } catch (error) {
      console.error(`[CommandRegistry] Failed to discover commands:`, getErrorMessage(error));
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

  async loadCommand(
    filePath: string,
    scope: 'project' | 'global' = 'project'
  ): Promise<Command | null> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = matter(content);
      const fileName = path.basename(filePath, '.md');
      const id = fileName.toLowerCase().replace(/\s+/g, '-');
      const data = parsed.data as CommandFrontmatter;

      let body = parsed.content.trim();

      body = await processShellBlocks(body, {
        workingDir: this.workingDir,
      });

      const variables = buildDefaultVariables({
        COMMAND_DIR: path.dirname(filePath),
        PROJECT_ROOT: path.resolve(this.projectBaseDir, '..', '..'),
        WORKING_DIR: this.workingDir,
      });
      body = resolveTemplate(body, variables);

      const command: Command = {
        id,
        name: data.name || fileName,
        description: data.description || '',
        body,
        model: data.model,
        subtask: data.subtask || false,
        filePath,
        enabled: data.enabled !== false,
        scope,
        argumentHint: data.argument_hint || data.argumentHint,
      };

      this.commands.set(id, command);
      return command;
    } catch (error) {
      console.error(
        `[CommandRegistry] Failed to load command from ${filePath}:`,
        getErrorMessage(error)
      );
      return null;
    }
  }

  private async loadCommandsFromAgentsFile(
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
        const data = parsed.data as CommandFrontmatter;
        if (data && (data as any).mode?.command) {
          const name = data.name || `command-${index}`;
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

          const command: Command = {
            id,
            name,
            description: data.description || '',
            body,
            model: data.model,
            subtask: data.subtask || false,
            filePath: `${filePath}#${index}`,
            enabled: data.enabled !== false,
            scope,
            argumentHint: data.argument_hint || data.argumentHint,
          };
          this.commands.set(id, command);
          index++;
        }
      }
    } catch (error) {
      console.error(
        `[CommandRegistry] Failed to parse AGENTS.md ${filePath}:`,
        getErrorMessage(error)
      );
    }
  }

  getCommand(id: string): Command | undefined {
    return this.commands.get(id.toLowerCase().replace(/\s+/g, '-'));
  }

  getAll(): Command[] {
    return Array.from(this.commands.values());
  }

  getEnabled(): Command[] {
    return this.getAll().filter((c) => c.enabled);
  }

  async disableCommand(id: string): Promise<boolean> {
    const command = this.getCommand(id);
    if (!command) return false;

    try {
      const content = await fs.readFile(command.filePath, 'utf-8');
      const parsed = matter(content);
      (parsed.data as CommandFrontmatter).enabled = false;

      const updatedContent = (
        matter as {
          stringify: (input: string, data: Record<string, unknown>) => string;
        }
      ).stringify(parsed.content, parsed.data);
      await fs.writeFile(command.filePath, updatedContent, 'utf-8');

      command.enabled = false;
      return true;
    } catch (error) {
      console.error(`[CommandRegistry] Failed to disable command ${id}:`, getErrorMessage(error));
      return false;
    }
  }

  async enableCommand(id: string): Promise<boolean> {
    const command = this.getCommand(id);
    if (!command) return false;

    try {
      const content = await fs.readFile(command.filePath, 'utf-8');
      const parsed = matter(content);
      (parsed.data as CommandFrontmatter).enabled = true;

      const updatedContent = (
        matter as {
          stringify: (input: string, data: Record<string, unknown>) => string;
        }
      ).stringify(parsed.content, parsed.data);
      await fs.writeFile(command.filePath, updatedContent, 'utf-8');

      command.enabled = true;
      return true;
    } catch (error) {
      console.error(`[CommandRegistry] Failed to enable command ${id}:`, getErrorMessage(error));
      return false;
    }
  }

  async createCommand(
    id: string,
    description: string,
    body: string,
    options?: {
      model?: string;
      subtask?: boolean;
    }
  ): Promise<string | null> {
    const filePath = path.join(this.projectBaseDir, `${id}.md`);

    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });

      const frontmatter: Record<string, unknown> = {
        description,
        enabled: true,
      };

      if (options?.model) frontmatter.model = options.model;
      if (options?.subtask) frontmatter.subtask = options.subtask;

      const content = (
        matter as {
          stringify: (input: string, data: Record<string, unknown>) => string;
        }
      ).stringify(body, frontmatter);
      await fs.writeFile(filePath, content, 'utf-8');

      await this.loadCommand(filePath, 'project');
      return filePath;
    } catch (error) {
      console.error(`[CommandRegistry] Failed to create command ${id}:`, getErrorMessage(error));
      return null;
    }
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  clear(): void {
    this.commands.clear();
    this.loaded = false;
  }
}

