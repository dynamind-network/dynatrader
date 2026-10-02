import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SkillMetadata } from './skill-types';

const execFileAsync = promisify(execFile);

export interface ImportResult {
  name: string;
  path: string;
  source: string;
  tags: string[];
}

export interface ImportError {
  error: string;
  source: string;
}

/**
 * Imports community skills from external sources (git URLs, local paths,
 * or raw SKILL.md content) into the workspace skills directory.
 *
 * The SKILL.md format is compatible with hermes-agent/OpenClaw community skills.
 */
export class SkillImporter {
  private workspaceSkillsDir: string;

  constructor(workspacePath: string) {
    this.workspaceSkillsDir = path.join(workspacePath, 'skills');
  }

  async importFromGitUrl(url: string): Promise<ImportResult> {
    const tmpDir = path.join(
      this.workspaceSkillsDir,
      '.tmp-import-' + Date.now(),
    );

    try {
      await fs.mkdir(tmpDir, { recursive: true });
      await execFileAsync('git', ['clone', '--depth=1', url, tmpDir], {
        timeout: 30_000,
      });

      const skillMdPath = await this.findSkillMd(tmpDir);
      if (!skillMdPath) {
        throw new Error('No SKILL.md or *.skill.md found in repository');
      }

      return await this.importFromPath(skillMdPath);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async importFromPath(sourcePath: string): Promise<ImportResult> {
    const stat = await fs.stat(sourcePath).catch(() => null);
    if (!stat) {
      throw new Error(`Source not found: ${sourcePath}`);
    }

    let skillMdPath: string;
    if (stat.isDirectory()) {
      const found = await this.findSkillMd(sourcePath);
      if (!found) {
        throw new Error('No SKILL.md or *.skill.md found in directory');
      }
      skillMdPath = found;
    } else {
      skillMdPath = sourcePath;
    }

    const content = await fs.readFile(skillMdPath, 'utf-8');
    const parsed = this.parseSkillContent(content);
    if (!parsed) {
      throw new Error('Invalid SKILL.md format — missing required fields (name, description, type)');
    }

    const destDir = path.join(this.workspaceSkillsDir, parsed.metadata.name);
    await fs.mkdir(destDir, { recursive: true });

    // Write SKILL.md with community tag appended
    const tags = [...parsed.metadata.tags, 'community'];
    const skillMd = this.formatSkillMd({
      ...parsed.metadata,
      tags,
    }, parsed.body);
    await fs.writeFile(path.join(destDir, 'SKILL.md'), skillMd, 'utf-8');

    // Write skill.json
    const skillJson = {
      name: parsed.metadata.name,
      description: parsed.metadata.description,
      type: parsed.metadata.type,
      tags,
      confidence: parsed.metadata.confidence,
      source: 'community',
      importedAt: new Date().toISOString(),
    };
    await fs.writeFile(
      path.join(destDir, 'skill.json'),
      JSON.stringify(skillJson, null, 2),
      'utf-8',
    );

    return {
      name: parsed.metadata.name,
      path: destDir,
      source: sourcePath,
      tags,
    };
  }

  async importFromContent(
    name: string,
    rawContent: string,
  ): Promise<ImportResult> {
    const parsed = this.parseSkillContent(rawContent);
    if (!parsed) {
      throw new Error('Invalid SKILL.md content — missing required fields');
    }

    const metadataName = parsed.metadata.name || name;
    const destDir = path.join(this.workspaceSkillsDir, metadataName);
    await fs.mkdir(destDir, { recursive: true });

    const tags = [...parsed.metadata.tags, 'community'];
    const skillMd = this.formatSkillMd(
      { ...parsed.metadata, name: metadataName, tags },
      parsed.body,
    );
    await fs.writeFile(path.join(destDir, 'SKILL.md'), skillMd, 'utf-8');

    const skillJson = {
      name: metadataName,
      description: parsed.metadata.description,
      type: parsed.metadata.type,
      tags,
      confidence: parsed.metadata.confidence,
      source: 'community',
      importedAt: new Date().toISOString(),
    };
    await fs.writeFile(
      path.join(destDir, 'skill.json'),
      JSON.stringify(skillJson, null, 2),
      'utf-8',
    );

    return {
      name: metadataName,
      path: destDir,
      source: 'content',
      tags,
    };
  }

  private parseSkillContent(
    content: string,
  ): { metadata: SkillMetadata; body: string } | null {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!frontmatterMatch) {
      // Try bare format: just markdown with a title
      const nameMatch = content.match(/^#\s+(.+)/m);
      if (!nameMatch) return null;
      return {
        metadata: {
          name: nameMatch[1].trim(),
          description: content.slice(0, 200).trim(),
          type: 'utility',
          tags: [],
          confidence: 0.5,
        },
        body: content,
      };
    }

    const [, frontmatterStr, body] = frontmatterMatch;
    const fm = this.parseYamlSimple(frontmatterStr);

    if (!fm.name || !fm.description || !fm.type) return null;

    const validTypes = ['strategy', 'analysis', 'research', 'risk', 'utility'];
    const type = validTypes.includes(String(fm.type)) ? String(fm.type) : 'utility';

    return {
      metadata: {
        name: String(fm.name),
        description: String(fm.description),
        type: type as SkillMetadata['type'],
        tags: Array.isArray(fm.tags) ? fm.tags.map(String) : [],
        confidence:
          typeof fm.confidence === 'number' ? fm.confidence : 0.5,
      },
      body: body.trim(),
    };
  }

  private parseYamlSimple(yamlStr: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    let currentKey = '';
    let currentArray: string[] | null = null;

    for (const line of yamlStr.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const arrayMatch = trimmed.match(/^(\w[\w-]*):\s*$/);
      if (arrayMatch) {
        if (currentKey && currentArray) {
          result[currentKey] = currentArray;
        }
        currentKey = arrayMatch[1];
        currentArray = [];
        continue;
      }

      const arrayItemMatch = trimmed.match(/^-\s+(.+)/);
      if (arrayItemMatch && currentArray) {
        currentArray.push(arrayItemMatch[1].replace(/^["']|["']$/g, ''));
        continue;
      }

      const kvMatch = trimmed.match(/^([\w-]+):\s*(.+)/);
      if (kvMatch) {
        if (currentKey && currentArray) {
          result[currentKey] = currentArray;
          currentArray = null;
        }
        currentKey = kvMatch[1];
        let value: unknown = kvMatch[2].trim();
        if (value === 'true') value = true;
        else if (value === 'false') value = false;
        else if (!isNaN(Number(value))) value = Number(value);
        else value = String(value).replace(/^["']|["']$/g, '');
        result[currentKey] = value;
      }
    }

    if (currentKey && currentArray) {
      result[currentKey] = currentArray;
    }

    return result;
  }

  private formatSkillMd(metadata: SkillMetadata, body: string): string {
    const lines = ['---'];
    lines.push(`name: "${metadata.name}"`);
    lines.push(`description: "${metadata.description}"`);
    lines.push(`type: ${metadata.type}`);
    if (metadata.tags.length > 0) {
      lines.push('tags:');
      for (const tag of metadata.tags) {
        lines.push(`  - "${tag}"`);
      }
    }
    lines.push(`confidence: ${metadata.confidence}`);
    lines.push('---');
    lines.push('');
    lines.push(body);
    return lines.join('\n');
  }

  private async findSkillMd(dir: string): Promise<string | null> {
    // Check for SKILL.md first
    const skillMd = path.join(dir, 'SKILL.md');
    try {
      await fs.access(skillMd);
      return skillMd;
    } catch {
      // not found
    }

    // Check for *.skill.md files
    try {
      const entries = await fs.readdir(dir);
      const skillFile = entries.find((e) => e.endsWith('.skill.md'));
      if (skillFile) return path.join(dir, skillFile);
    } catch {
      // not found
    }

    return null;
  }
}
