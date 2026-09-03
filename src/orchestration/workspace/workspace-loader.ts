import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import YAML from 'yaml';
import type { WorkspaceManifest, RuntimeConfig } from './types';
import { Logger } from './logger';

const REQUIRED_WORKSPACE_FILES = [
  'SOUL.md',
  'IDENTITY.md',
  'MEMORY.md',
  'USER.md',
  'auth.json',
  'config.yaml',
] as const;

const SKILL_JSON_SCHEMA = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  status: z.enum([
    'draft',
    'validated',
    'sandboxed',
    'backtested',
    'paper_approved',
    'shadow_eligible',
    'micro_live_eligible',
    'live_eligible',
    'deprecated',
  ]),
  allowedModes: z.array(z.enum(['research', 'backtest', 'paper', 'shadow', 'micro_live', 'live'])).min(1),
  permissions: z.object({
    allow: z.array(z.string()),
    deny: z.array(z.string()),
  }),
  toolsRequired: z.array(z.string()),
  riskLevel: z.enum(['low', 'medium', 'high', 'critical']),
  review: z.object({
    humanRequired: z.boolean(),
    testsRequired: z.boolean(),
    signatureRequired: z.boolean(),
  }),
  security: z.object({
    allowNetwork: z.boolean(),
    allowFilesystem: z.boolean(),
    allowCredentials: z.boolean(),
    allowOrderExecution: z.boolean(),
  }),
  approvalState: z.enum(['pending', 'approved']).optional(),
}).passthrough();

export class WorkspaceLoader {
  private logger = new Logger('WorkspaceLoader');

  constructor(private workspacePath: string) {}

  async validateWorkspace(): Promise<void> {
    this.logger.info(`Validating workspace at ${this.workspacePath}`);
    const errors: string[] = [];

    // Check if workspace path exists
    try {
      await fs.access(this.workspacePath);
    } catch {
      throw new Error(`Workspace path does not exist: ${this.workspacePath}`);
    }

    // Check required files
    for (const file of REQUIRED_WORKSPACE_FILES) {
      const filePath = path.join(this.workspacePath, file);
      try {
        await fs.access(filePath);
        this.logger.debug(`Found required file: ${file}`);
      } catch {
        errors.push(`Required workspace file missing: ${file}`);
      }
    }

    const legacyConfigPath = path.join(this.workspacePath, 'config.json');
    if (await this.pathExists(legacyConfigPath)) {
      errors.push('Legacy config.json is not supported; use config.yaml only');
    }

    const authPath = path.join(this.workspacePath, 'auth.json');
    const authErrors = await this.validateAuthConfig(authPath);
    errors.push(...authErrors);

    const skillErrors = await this.validateSkillInventory();
    errors.push(...skillErrors);

    if (errors.length > 0) {
      throw new Error(`Workspace validation failed: ${errors.join('; ')}`);
    }

    // Check for optional directories
    const optionalDirs = ['agents', 'skills', 'plugins', 'tools', 'adapters', 'policies', 'runs', 'memory'];
    for (const dir of optionalDirs) {
      const dirPath = path.join(this.workspacePath, dir);
      try {
        await fs.access(dirPath);
        this.logger.debug(`Found directory: ${dir}`);
      } catch {
        this.logger.debug(`Directory not found (will be created if needed): ${dir}`);
      }
    }
  }

  async load(): Promise<WorkspaceManifest> {
    this.logger.info('Loading workspace manifests');

    const manifest: WorkspaceManifest = {
      agents: [],
      skills: [],
      loops: [],
      plugins: [],
      tools: [],
      adapters: [],
      policies: []
    };

    // Load markdown files
    try {
      manifest.soul = await this.readMarkdownFile('SOUL.md');
      manifest.identity = await this.readMarkdownFile('IDENTITY.md');
      manifest.user = await this.readMarkdownFile('USER.md');
      manifest.memory = await this.readMarkdownFile('MEMORY.md');
    } catch (error) {
      this.logger.error('Failed to load markdown files', error);
      throw error;
    }

    // Load JSON files when present; higher-permission modes validate them later.
    manifest.auth = await this.readJsonFile('auth.json').catch(() => undefined);
    manifest.config = await this.readYamlOrJsonFile('config.yaml').catch(() => undefined);

    // Load dynamic manifests
    manifest.agents = await this.loadAgents();
    manifest.skills = await this.loadSkills();
    manifest.loops = await this.loadLoops();
    manifest.plugins = await this.loadPlugins();
    manifest.tools = await this.loadTools();
    manifest.adapters = await this.loadAdapters();
    manifest.policies = await this.loadPolicies();

    this.logger.info(`Loaded workspace with ${manifest.agents.length} agents, ${manifest.skills.length} skills, ${manifest.loops.length} loops, ${manifest.plugins.length} plugins, ${manifest.tools.length} tools, ${manifest.adapters.length} adapters, ${manifest.policies.length} policies`);

    return manifest;
  }

  private async readMarkdownFile(filename: string): Promise<string> {
    const filePath = path.join(this.workspacePath, filename);
    const content = await fs.readFile(filePath, 'utf-8');
    return content;
  }

  private async readJsonFile<T>(filename: string): Promise<T> {
    const filePath = path.join(this.workspacePath, filename);
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  }

  private async readYamlOrJsonFile<T>(filename: string): Promise<T> {
    const filePath = path.join(this.workspacePath, filename);
    const content = await fs.readFile(filePath, 'utf-8');
    try {
      return YAML.parse(content) as T;
    } catch {
      return JSON.parse(content) as T;
    }
  }

  private async loadAgents(): Promise<any[]> {
    const agentsDir = path.join(this.workspacePath, 'agents');
    try {
      await fs.access(agentsDir);
    } catch {
      return [];
    }

    const files = await fs.readdir(agentsDir);
    const agentManifests = [];

    for (const file of files) {
      if (file.endsWith('.agent.md')) {
        try {
          const filePath = path.join(agentsDir, file);
          const content = await fs.readFile(filePath, 'utf-8');

          // Parse YAML frontmatter + markdown content
          const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
          if (frontmatterMatch) {
            const [, frontmatter, instructions] = frontmatterMatch;
            const parsed = this.parseYamlFrontmatter(frontmatter!);

            agentManifests.push({
              ...parsed,
              instructions,
              filename: file
            });
          }
        } catch (error) {
          this.logger.error(`Failed to load agent ${file}`, error);
        }
      }
    }

    return agentManifests;
  }

  private async loadSkills(): Promise<any[]> {
    const skillsDir = path.join(this.workspacePath, 'skills');
    try {
      await fs.access(skillsDir);
    } catch {
      return [];
    }

    const skills = [];
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillDir = path.join(skillsDir, entry.name);
        try {
          const skillJsonPath = path.join(skillDir, 'skill.json');
          const skillMdPath = path.join(skillDir, 'SKILL.md');

          const skillJson = await fs.readFile(skillJsonPath, 'utf-8');
          const skillMd = await fs.readFile(skillMdPath, 'utf-8');

          const parsed = JSON.parse(skillJson);
          skills.push({
            ...parsed,
            allowedModes: parsed.allowedModes ?? parsed.allowed_modes ?? [],
            toolsRequired: parsed.toolsRequired ?? parsed.tools_required ?? [],
            approvalRequiredFor: parsed.approvalRequiredFor ?? parsed.approval_required_for ?? [],
            riskLevel: parsed.riskLevel ?? parsed.risk_level,
            instructions: skillMd,
            directory: entry.name
          });
        } catch (error) {
          this.logger.error(`Failed to load skill ${entry.name}`, error);
        }
      }
    }

    return skills;
  }

  private async loadLoops(): Promise<any[]> {
    const loopsDir = path.join(this.workspacePath, 'loops');
    try {
      await fs.access(loopsDir);
    } catch {
      return [];
    }

    const loops: any[] = [];
    const entries = await fs.readdir(loopsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const loopDir = path.join(loopsDir, entry.name);
        try {
          const loopJsonPath = path.join(loopDir, 'loop.json');
          const loopJson = await fs.readFile(loopJsonPath, 'utf-8');
          const parsed = JSON.parse(loopJson);
          loops.push({
            ...parsed,
            enabled: parsed.enabled ?? true,
            pipeline: this.normalizeLoopPipeline(parsed.pipeline),
            skills: Array.isArray(parsed.skills) ? parsed.skills.map(String) : [],
            tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
            approvalStatus: this.normalizeLoopApprovalStatus(parsed.approvalStatus),
            executionPolicy: this.normalizeLoopExecutionPolicy(parsed.executionPolicy),
            directory: entry.name,
          });
        } catch (error) {
          this.logger.error(`Failed to load loop ${entry.name}`, error);
        }
        continue;
      }

      if (entry.name.endsWith('.loop.json')) {
        try {
          const loopPath = path.join(loopsDir, entry.name);
          const loopJson = await fs.readFile(loopPath, 'utf-8');
          const parsed = JSON.parse(loopJson);
          loops.push({
            ...parsed,
            enabled: parsed.enabled ?? true,
            pipeline: this.normalizeLoopPipeline(parsed.pipeline),
            skills: Array.isArray(parsed.skills) ? parsed.skills.map(String) : [],
            tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
            approvalStatus: this.normalizeLoopApprovalStatus(parsed.approvalStatus),
            executionPolicy: this.normalizeLoopExecutionPolicy(parsed.executionPolicy),
            filename: entry.name,
          });
        } catch (error) {
          this.logger.error(`Failed to load loop ${entry.name}`, error);
        }
      }
    }

    return loops;
  }

  private async loadPlugins(): Promise<any[]> {
    const pluginsDir = path.join(this.workspacePath, 'plugins');
    try {
      await fs.access(pluginsDir);
    } catch {
      return [];
    }

    const entries = await fs.readdir(pluginsDir, { withFileTypes: true });
    const plugins = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const pluginDir = path.join(pluginsDir, entry.name);
      try {
        const pluginJsonPath = path.join(pluginDir, 'plugin.json');
        const content = await fs.readFile(pluginJsonPath, 'utf-8');
        plugins.push({
          ...JSON.parse(content),
          directory: entry.name,
        });
      } catch (error) {
        this.logger.error(`Failed to load plugin ${entry.name}`, error);
      }
    }

    return plugins;
  }

  private async loadTools(): Promise<any[]> {
    const toolsDir = path.join(this.workspacePath, 'tools');
    try {
      await fs.access(toolsDir);
    } catch {
      return [];
    }

    const files = await fs.readdir(toolsDir);
    const toolManifests = [];

    for (const file of files) {
      if (file.endsWith('.tool.json')) {
        try {
          const filePath = path.join(toolsDir, file);
          const content = await fs.readFile(filePath, 'utf-8');
          const manifest = JSON.parse(content);

          toolManifests.push({
            ...manifest,
            filename: file
          });
        } catch (error) {
          this.logger.error(`Failed to load tool ${file}`, error);
        }
      }
    }

    return toolManifests;
  }

  private async loadAdapters(): Promise<any[]> {
    const adaptersDir = path.join(this.workspacePath, 'adapters');
    try {
      await fs.access(adaptersDir);
    } catch {
      return [];
    }

    const files = await fs.readdir(adaptersDir);
    const adapterManifests = [];

    for (const file of files) {
      if (file.endsWith('.adapter.json')) {
        try {
          const filePath = path.join(adaptersDir, file);
          const content = await fs.readFile(filePath, 'utf-8');
          const manifest = JSON.parse(content);

          adapterManifests.push({
            ...manifest,
            filename: file
          });
        } catch (error) {
          this.logger.error(`Failed to load adapter ${file}`, error);
        }
      }
    }

    return adapterManifests;
  }

  private async loadPolicies(): Promise<any[]> {
    const policiesDir = path.join(this.workspacePath, 'policies');
    try {
      await fs.access(policiesDir);
    } catch {
      return [];
    }

    const files = await fs.readdir(policiesDir);
    const policyManifests = [];

    for (const file of files) {
      if (file.endsWith('.policy.json')) {
        try {
          const filePath = path.join(policiesDir, file);
          const content = await fs.readFile(filePath, 'utf-8');
          const manifest = JSON.parse(content);

          policyManifests.push({
            ...manifest,
            filename: file
          });
        } catch (error) {
          this.logger.error(`Failed to load policy ${file}`, error);
        }
      }
    }

    return policyManifests;
  }

  private async validateAuthConfig(authPath: string): Promise<string[]> {
    try {
      const raw = await fs.readFile(authPath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const errors: string[] = [];

      const owner = parsed['owner'] as Record<string, unknown> | undefined;
      if (!owner || typeof owner['id'] !== 'string' || !owner['id'].trim()) {
        errors.push('auth.json must define an owner.id');
      }
      if (!Array.isArray(parsed['approval_required_for'])) {
        errors.push('auth.json must define approval_required_for as an array');
      }
      if (!Array.isArray(parsed['blocked_operations'])) {
        errors.push('auth.json must define blocked_operations as an array');
      }

      return errors;
    } catch {
      return ['auth.json must contain valid JSON'];
    }
  }

  private async validateSkillInventory(): Promise<string[]> {
    const skillsDir = path.join(this.workspacePath, 'skills');
    if (!(await this.pathExists(skillsDir))) {
      return ['skills directory is missing'];
    }

    const errors: string[] = [];
    const entries = await fs.readdir(skillsDir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      if (entry.name === 'pending') {
        errors.push('draft skill folders are no longer supported; write learned skills directly under skills/');
        continue;
      }

      errors.push(...await this.validateSkillDirectory(path.join(skillsDir, entry.name), entry.name));
    }

    return errors;
  }

  private async validateSkillDirectory(skillDir: string, label: string): Promise<string[]> {
    const errors: string[] = [];
    const skillJsonPath = path.join(skillDir, 'skill.json');
    const skillMdPath = path.join(skillDir, 'SKILL.md');

    if (!(await this.pathExists(skillJsonPath))) {
      errors.push(`Skill ${label}: missing skill.json`);
      return errors;
    }

    if (!(await this.pathExists(skillMdPath))) {
      errors.push(`Skill ${label}: missing SKILL.md`);
      return errors;
    }

    try {
      const raw = await fs.readFile(skillJsonPath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const result = SKILL_JSON_SCHEMA.safeParse(parsed);
      if (!result.success) {
        for (const issue of result.error.issues) {
          errors.push(`Skill ${label}: ${issue.path.join('.') || 'manifest'} ${issue.message}`);
        }
      }
    } catch {
      errors.push(`Skill ${label}: skill.json must contain valid JSON`);
    }

    return errors;
  }

  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private parseYamlFrontmatter(frontmatter: string): any {
    const parsed = YAML.parse(frontmatter) ?? {};
    return {
      ...parsed,
      allowedModes: parsed.allowedModes ?? parsed.allowed_modes ?? [],
      approvalRequiredFor: parsed.approvalRequiredFor ?? parsed.approval_required_for ?? [],
      riskLevel: parsed.riskLevel ?? parsed.risk_level,
    };
    /* const lines = frontmatter.split('\n');
    const result: any = {};

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...rest] = trimmed.split(':');
        if (key && rest.length > 0) {
          const value = rest.join(':').trim();

          // Handle YAML types
          if (value.startsWith('[') && value.endsWith(']')) {
            // Array
            result[key] = value.slice(1, -1).split(',').map((item: string) => item.trim());
          } else if (value === 'true' || value === 'false') {
            // Boolean
            result[key] = value === 'true';
          } else if (!isNaN(Number(value))) {
            // Number
            result[key] = Number(value);
          } else {
            // String
            result[key] = value.replace(/^["']|["']$/g, '');
          }
        }
      }
    }

    return result; */
  }

  private normalizeLoopPipeline(value: unknown): 'analysis' | 'execution' | 'monitoring' | 'research' | undefined {
    return value === 'analysis' || value === 'execution' || value === 'monitoring' || value === 'research'
      ? value
      : undefined;
  }

  private normalizeLoopApprovalStatus(value: unknown): 'pending' | 'approved' | 'rejected' | undefined {
    return value === 'pending' || value === 'approved' || value === 'rejected'
      ? value
      : undefined;
  }

  private normalizeLoopExecutionPolicy(value: unknown): 'trade' | 'close-only' | undefined {
    return value === 'trade' || value === 'close-only'
      ? value
      : undefined;
  }
}
