import fs from 'fs/promises';
import path from 'path';
import yaml from 'js-yaml';
import { ZodError } from 'zod';
import { ManifestValidator } from './index';

export interface ManifestFile {
  path: string;
  type: 'agent' | 'skill' | 'tool' | 'adapter' | 'policy';
  data: any;
  validated: boolean;
  errors?: string[];
}

/**
 * Extract human-readable error messages from a Zod safeParse result.
 */
function extractZodErrors(result: { success: boolean; error?: unknown }): string[] {
  if (result.success || !result.error) return [];
  if (result.error instanceof ZodError) {
    return result.error.issues.map((issue) => issue.message);
  }
  return [String(result.error)];
}

export class ManifestLoader {
  private loadedManifests = new Map<string, ManifestFile>();

  async loadFromDirectory(directory: string, type: ManifestFile['type']): Promise<ManifestFile[]> {
    const manifestFiles: ManifestFile[] = [];
    const dirPath = path.resolve(directory);

    try {
      await fs.access(dirPath);
    } catch {
      return manifestFiles;
    }

    const files = await fs.readdir(dirPath);

    for (const file of files) {
      if (this.isManifestFile(file, type)) {
        const filePath = path.join(dirPath, file);
        const manifest = await this.loadManifestFile(filePath, type);

        if (manifest) {
          this.loadedManifests.set(filePath, manifest);
          manifestFiles.push(manifest);
        }
      }
    }

    return manifestFiles;
  }

  private isManifestFile(filename: string, type: ManifestFile['type']): boolean {
    switch (type) {
      case 'agent':
        return filename.endsWith('.agent.md');
      case 'skill':
        // Skills are directories
        return false;
      case 'tool':
        return filename.endsWith('.tool.json');
      case 'adapter':
        return filename.endsWith('.adapter.json');
      case 'policy':
        return filename.endsWith('.policy.json');
      default:
        return false;
    }
  }

  private async loadManifestFile(filePath: string, type: ManifestFile['type']): Promise<ManifestFile | null> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      let data: any;

      if (type === 'agent' && filePath.endsWith('.md')) {
        // Parse YAML frontmatter + JSON content
        const parsed = this.parseAgentManifest(content);
        data = parsed;
      } else if (type === 'skill') {
        // Skills are directories with JSON and MD files
        return await this.loadSkillManifest(filePath);
      } else if (filePath.endsWith('.json')) {
        data = JSON.parse(content);
      } else {
        return null;
      }

      // Validate the manifest
      const result = this.validateManifest(data, type);

      return {
        path: filePath,
        type,
        data,
        validated: result.success,
        errors: result.success ? undefined : result.errors
      };
    } catch (error) {
      console.error(`Failed to load manifest ${filePath}:`, error);
      return null;
    }
  }

  private parseAgentManifest(content: string): any {
    const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
    if (!frontmatterMatch) {
      throw new Error('Invalid agent manifest format: missing frontmatter');
    }

    const [, frontmatter, instructions] = frontmatterMatch;
    const data = yaml.load(frontmatter!) as any;

    // Add instructions as a special field
    data.instructions = instructions;
    data.filename = path.basename(content);

    return data;
  }

  private async loadSkillManifest(dirPath: string): Promise<ManifestFile | null> {
    const manifestFile = path.join(dirPath, 'skill.json');
    const instructionsFile = path.join(dirPath, 'SKILL.md');

    try {
      const [manifestContent, instructionsContent] = await Promise.all([
        fs.readFile(manifestFile, 'utf-8'),
        fs.readFile(instructionsFile, 'utf-8')
      ]);

      const data = JSON.parse(manifestContent);

      // Add instructions
      data.instructions = instructionsContent;

      // Validate the manifest
      const result = this.validateManifest(data, 'skill');

      return {
        path: dirPath,
        type: 'skill',
        data,
        validated: result.success,
        errors: result.success ? undefined : result.errors
      };
    } catch (error) {
      console.error(`Failed to load skill manifest ${dirPath}:`, error);
      return null;
    }
  }

  private validateManifest(data: any, type: ManifestFile['type']): { success: boolean; errors: string[] } {
    const errors: string[] = [];

    switch (type) {
      case 'agent':
        errors.push(...extractZodErrors(ManifestValidator.validateAgentManifest(data)));
        break;
      case 'skill':
        errors.push(...extractZodErrors(ManifestValidator.validateSkillManifest(data)));
        break;
      case 'tool':
        errors.push(...extractZodErrors(ManifestValidator.validateToolManifest(data)));
        break;
      case 'adapter':
        errors.push(...extractZodErrors(ManifestValidator.validateAdapterManifest(data)));
        break;
      case 'policy':
        errors.push(...extractZodErrors(ManifestValidator.validatePolicyManifest(data)));
        break;
    }

    return {
      success: errors.length === 0,
      errors
    };
  }

  getLoadedManifests(): Map<string, ManifestFile> {
    return this.loadedManifests;
  }

  getManifestsByType(type: ManifestFile['type']): ManifestFile[] {
    return Array.from(this.loadedManifests.values()).filter(m => m.type === type);
  }

  clear(): void {
    this.loadedManifests.clear();
  }
}
