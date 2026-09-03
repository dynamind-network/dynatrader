/**
 * SkillLoader
 *
 * Scans directories for *.skill.md files, parses YAML frontmatter + markdown
 * body, and loads skills with precedence ordering.
 * Supports SKILL.md format.
 *
 * Precedence (lower number = higher priority):
 *   0 = workspace/   (user's active workspace)
 *   1 = project/     (project-level skills)
 *   2 = personal/    (user's personal skill library)
 *   3 = bundled/     (shipped with the application)
 *
 * Higher-precedence skills override lower-precedence ones with the same name.
 */

import fs from 'fs/promises';
import path from 'path';
import * as yaml from 'js-yaml';
import type { Skill, SkillMetadata, PrecedenceLevel } from './skill-types';
import { PRECEDENCE_ORDER } from './skill-types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Glob pattern for skill files. */
const SKILL_FILE_PATTERN = '.skill.md';

/** Default precedence directories relative to a base path. */
const DEFAULT_PRECEDENCE_DIRS: Record<PrecedenceLevel, string> = {
  workspace: 'skills',
  project: 'skills',
  personal: 'skills',
  bundled: 'skills',
};

// ---------------------------------------------------------------------------
// SkillLoader
// ---------------------------------------------------------------------------

export class SkillLoader {
  /** Loaded skills keyed by name (deduplicated by precedence). */
  private skills: Map<string, Skill> = new Map();

  /** Base paths for each precedence level. */
  private basePaths: Map<PrecedenceLevel, string> = new Map();

  /**
   * Register a base path for a precedence level.
   * Skills will be loaded from `<basePath>/<precedenceDir>/`.
   */
  registerPath(level: PrecedenceLevel, basePath: string): void {
    this.basePaths.set(level, basePath);
  }

  /**
   * Load all skills from all registered precedence directories.
   * Higher-precedence skills override lower-precedence ones with the same name.
   *
   * @param precedenceOrder - Optional custom precedence order (defaults to workspace > project > personal > bundled).
   * @returns All loaded skills (deduplicated by name).
   */
  async loadAll(
    precedenceOrder?: PrecedenceLevel[],
  ): Promise<Skill[]> {
    const order =
      precedenceOrder ??
      Array.from(this.basePaths.keys()).sort(
        (a, b) => PRECEDENCE_ORDER[a] - PRECEDENCE_ORDER[b],
      );

    // Clear existing skills for a fresh load.
    this.skills.clear();

    // Load from lowest priority to highest so that higher-priority skills
    // (lower precedence number) override lower-priority ones with the same name
    // via Map.set() -- last write wins.
    const loadOrder = [...order].sort(
      (a, b) => PRECEDENCE_ORDER[b] - PRECEDENCE_ORDER[a],
    );
    // Use the caller's order as a filter: only load levels present in their order.
    const effectiveOrder = loadOrder.filter((l) => order.includes(l));

    for (const level of effectiveOrder) {
      const basePath = this.basePaths.get(level);
      if (!basePath) continue;

      const precedence = PRECEDENCE_ORDER[level];
      const dirName = DEFAULT_PRECEDENCE_DIRS[level];
      const dirPath = path.join(basePath, dirName);

      const loaded = await this.loadFromDirectory(dirPath, precedence);
      for (const skill of loaded) {
        this.skills.set(skill.metadata.name, skill);
      }
    }

    return Array.from(this.skills.values());
  }

  /**
   * Scan a single directory for skills and parse them.
   * Supports two formats:
   *   1. Flat *.skill.md files with YAML frontmatter
   *   2. Subdirectories containing SKILL.md + skill.json (workspace format)
   *
   * @param dirPath - Absolute path to the directory to scan.
   * @param precedence - Numeric precedence level to assign to loaded skills.
   * @returns Parsed skills from this directory.
   */
  async loadFromDirectory(
    dirPath: string,
    precedence: number,
  ): Promise<Skill[]> {
    let entries: string[];
    try {
      await fs.access(dirPath);
      entries = await fs.readdir(dirPath);
    } catch {
      // Directory does not exist -- nothing to load.
      return [];
    }

    const skills: Skill[] = [];

    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry);
      const stat = await fs.stat(entryPath).catch(() => null);
      if (!stat) continue;

      if (stat.isDirectory()) {
        // Format 2: Subdirectory with SKILL.md + skill.json
        const skill = await this.parseSkillDirectory(entryPath, precedence);
        if (skill) {
          this.skills.set(skill.metadata.name, skill);
          skills.push(skill);
        }
      } else if (entry.endsWith(SKILL_FILE_PATTERN)) {
        // Format 1: Flat .skill.md file with YAML frontmatter
        const skill = await this.parseSkillFile(entryPath, precedence);
        if (skill) {
          this.skills.set(skill.metadata.name, skill);
          skills.push(skill);
        }
      }
    }

    return skills;
  }

  /**
   * Parse a skill directory containing SKILL.md and optional skill.json.
   * Standard skill directory format.
   */
  private async parseSkillDirectory(
    dirPath: string,
    precedence: number,
  ): Promise<Skill | null> {
    const skillMdPath = path.join(dirPath, 'SKILL.md');
    const skillJsonPath = path.join(dirPath, 'skill.json');

    // Check if SKILL.md exists
    try {
      await fs.access(skillMdPath);
    } catch {
      return null;
    }

    const skillMdContent = await fs.readFile(skillMdPath, 'utf-8').catch(() => null);
    if (!skillMdContent) return null;

    // Try to load skill.json for metadata
    let skillJson: Record<string, unknown> | null = null;
    try {
      const jsonContent = await fs.readFile(skillJsonPath, 'utf-8');
      skillJson = JSON.parse(jsonContent);
    } catch {
      // skill.json is optional
    }

    // Check if SKILL.md has YAML frontmatter (source format)
    if (skillMdContent.startsWith('---')) {
      // Use existing frontmatter parser
      return this.parseSkillFile(skillMdPath, precedence);
    }

    // Workspace format: skill.json provides metadata, SKILL.md provides instructions
    if (!skillJson || typeof skillJson !== 'object') {
      return null;
    }

    const name = skillJson['name'] as string | undefined;
    const description = skillJson['description'] as string | undefined;
    const category = skillJson['category'] as string | undefined;

    if (!name || !description) {
      return null;
    }

    // Map category to SkillMetadata type
    const typeMap: Record<string, SkillMetadata['type']> = {
      strategy: 'strategy',
      analysis: 'analysis',
      research: 'research',
      risk: 'risk',
      utility: 'utility',
    };
    const type = typeMap[category as string] ?? 'utility';

    const metadata: SkillMetadata = {
      name,
      description,
      type,
      tags: Array.isArray(skillJson['tags']) ? skillJson['tags'].map(String) : [],
      confidence: typeof skillJson['confidence'] === 'number' ? skillJson['confidence'] : 0.5,
    };

    return {
      metadata,
      instructions: skillMdContent.trim(),
      source: skillMdPath,
      precedence,
    };
  }

  /**
   * Parse a single .skill.md file into a Skill object.
   * The file must have YAML frontmatter delimited by `---` lines,
   * followed by markdown body (instructions).
   */
  async parseSkillFile(
    filePath: string,
    precedence: number,
  ): Promise<Skill | null> {
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch {
      return null;
    }

    const parsed = this.parseFrontmatter(content);
    if (!parsed) return null;

    const { frontmatter, body } = parsed;

    // Validate required fields.
    if (!frontmatter.name || typeof frontmatter.name !== 'string') {
      return null;
    }
    if (!frontmatter.description || typeof frontmatter.description !== 'string') {
      return null;
    }
    if (!frontmatter.type || !['strategy', 'analysis', 'research', 'risk', 'utility'].includes(frontmatter.type as string)) {
      return null;
    }

    const metadata: SkillMetadata = {
      name: frontmatter.name,
      description: frontmatter.description,
      type: frontmatter.type as SkillMetadata['type'],
      tags: Array.isArray(frontmatter.tags) ? frontmatter.tags.map(String) : [],
      confidence: typeof frontmatter.confidence === 'number' ? frontmatter.confidence : 0.5,
    };

    // Parse optional requires block
    if (frontmatter.requires && typeof frontmatter.requires === 'object') {
      const req = frontmatter.requires as Record<string, unknown>;
      metadata.requires = {};
      if (Array.isArray(req.bins)) metadata.requires.bins = req.bins.map(String);
      if (Array.isArray(req.env)) metadata.requires.env = req.env.map(String);
      if (Array.isArray(req.config)) metadata.requires.config = req.config.map(String);
      if (Object.keys(metadata.requires).length === 0) {
        delete metadata.requires;
      }
    }

    // Parse optional OS filter
    if (Array.isArray(frontmatter.os)) {
      metadata.os = frontmatter.os.filter((o: unknown): o is 'win32' | 'darwin' | 'linux' =>
        o === 'win32' || o === 'darwin' || o === 'linux',
      );
      if (metadata.os.length === 0) {
        delete metadata.os;
      }
    }

    return {
      metadata,
      instructions: body.trim(),
      source: filePath,
      precedence,
    };
  }

  // -----------------------------------------------------------------------
  // Query methods
  // -----------------------------------------------------------------------

  /**
   * Get all currently loaded skills.
   */
  getAllSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  /**
   * Get a skill by name.
   */
  getSkill(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /**
   * Filter loaded skills by type.
   */
  getSkillsByType(type: SkillMetadata['type']): Skill[] {
    return this.getAllSkills().filter((s) => s.metadata.type === type);
  }

  /**
   * Filter loaded skills by tag (matches any of the given tags).
   */
  getSkillsByTag(tag: string): Skill[] {
    return this.getAllSkills().filter((s) => s.metadata.tags.includes(tag));
  }

  /**
   * Get skills that pass all gating requirements.
   * Uses the provided SkillGates instance to evaluate each skill.
   *
   * @param gates - SkillGates instance for evaluating requirements.
   * @returns Skills that pass all gates.
   */
  getEnabledSkills(gates: { evaluateAll: (skill: Skill) => { passed: boolean; reason?: string } }): Skill[] {
    return this.getAllSkills().filter((s) => gates.evaluateAll(s).passed);
  }

  /**
   * Clear all loaded skills.
   */
  clear(): void {
    this.skills.clear();
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Parse YAML frontmatter from a markdown file.
   * Expects content between `---` delimiters at the start of the file.
   */
  private parseFrontmatter(
    content: string,
  ): { frontmatter: Record<string, unknown>; body: string } | null {
    // Must start with ---
    if (!content.startsWith('---')) {
      return null;
    }

    // Find the closing ---
    const endIndex = content.indexOf('---', 3);
    if (endIndex === -1) {
      return null;
    }

    const yamlStr = content.slice(3, endIndex).trim();
    const body = content.slice(endIndex + 3).trim();

    if (!yamlStr) {
      return null;
    }

    try {
      const frontmatter = yaml.load(yamlStr) as Record<string, unknown>;
      if (!frontmatter || typeof frontmatter !== 'object') {
        return null;
      }
      return { frontmatter, body };
    } catch {
      return null;
    }
  }
}
