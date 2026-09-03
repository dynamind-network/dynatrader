/**
 * Skill Manager (Hermes-style)
 *
 * Manages SKILL.md files. The agent creates and patches skills directly
 * to evolve — no approval workflow. Skills improve through usage.
 *
 * Actions:
 * - patch: targeted fixes (preferred, token-efficient: old_string -> new_string)
 * - edit: major structural rewrites (full SKILL.md replacement)
 * - create: new skill
 * - delete: remove a skill
 *
 * Preference order: UPDATE existing > CREATE new
 */

import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";

export interface SkillFileMeta {
  id?: string;
  name?: string;
  description?: string;
  category?: string;
  tags?: string[];
  created_by?: "agent" | "user" | "system";
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface SkillPatch {
  old_string: string;
  new_string: string;
  occurrence?: number;
}

export interface SkillEdit {
  content: string;
}

export interface SkillManageResult {
  success: boolean;
  action: "patch" | "edit" | "create" | "delete";
  skillPath: string;
  message: string;
}

export interface SkillViewResult {
  path: string;
  content: string;
  frontmatter: SkillFileMeta;
  body: string;
}

export class SkillManager {
  private readonly skillsDir: string;

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir;
  }

  async listSkills(): Promise<Array<{ name: string; path: string; manifest: SkillFileMeta }>> {
    const skills: Array<{ name: string; path: string; manifest: SkillFileMeta }> = [];

    if (!existsSync(this.skillsDir)) {
      return skills;
    }

    const entries = await fs.readdir(this.skillsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillPath = path.join(this.skillsDir, entry.name, "SKILL.md");
        if (existsSync(skillPath)) {
          const content = await fs.readFile(skillPath, "utf-8");
          const { frontmatter } = parseSkillFile(content);
          skills.push({ name: entry.name, path: skillPath, manifest: frontmatter });
        }
      }
    }

    return skills;
  }

  async viewSkill(skillName: string): Promise<SkillViewResult> {
    const skillPath = path.join(this.skillsDir, skillName, "SKILL.md");

    if (!existsSync(skillPath)) {
      throw new Error(`Skill not found: ${skillName}`);
    }

    const content = await fs.readFile(skillPath, "utf-8");
    const { frontmatter, body } = parseSkillFile(content);

    return { path: skillPath, content, frontmatter, body };
  }

  async patchSkill(skillName: string, patches: SkillPatch[]): Promise<SkillManageResult> {
    const skillPath = path.join(this.skillsDir, skillName, "SKILL.md");

    if (!existsSync(skillPath)) {
      throw new Error(`Skill not found: ${skillName}`);
    }

    let content = await fs.readFile(skillPath, "utf-8");

    for (const patch of patches) {
      if (!content.includes(patch.old_string)) {
        throw new Error(`Patch target not found: "${patch.old_string.slice(0, 50)}..."`);
      }

      const occurrences = content.split(patch.old_string).length - 1;
      if (occurrences > 1 && patch.occurrence === undefined) {
        throw new Error(
          `Multiple occurrences (${occurrences}) of patch target. Specify occurrence index.`,
        );
      }

      if (patch.occurrence !== undefined) {
        const parts = content.split(patch.old_string);
        if (parts.length <= patch.occurrence) {
          throw new Error(`Occurrence ${patch.occurrence} not found.`);
        }
        parts[patch.occurrence] = patch.new_string;
        content = parts.join(patch.old_string);
      } else {
        content = content.replace(patch.old_string, patch.new_string);
      }
    }

    await fs.writeFile(skillPath, content, "utf-8");

    return {
      success: true,
      action: "patch",
      skillPath,
      message: `Patched ${patches.length} section(s) in ${skillName}`,
    };
  }

  async editSkill(skillName: string, edit: SkillEdit): Promise<SkillManageResult> {
    const skillPath = path.join(this.skillsDir, skillName, "SKILL.md");

    if (!existsSync(skillPath)) {
      throw new Error(`Skill not found: ${skillName}`);
    }

    await fs.writeFile(skillPath, edit.content, "utf-8");

    return {
      success: true,
      action: "edit",
      skillPath,
      message: `Edited ${skillName}`,
    };
  }

  async createSkill(
    skillName: string,
    content: string,
    options?: { category?: string; description?: string },
  ): Promise<SkillManageResult> {
    const skillDir = path.join(this.skillsDir, skillName);
    const skillPath = path.join(skillDir, "SKILL.md");

    if (existsSync(skillPath)) {
      throw new Error(`Skill already exists: ${skillName}. Use patchSkill or editSkill instead.`);
    }

    const frontmatter: SkillFileMeta = {
      id: skillName,
      name: skillName,
      description: options?.description ?? "",
      category: options?.category ?? "general",
      created_by: "agent",
      created_at: new Date().toISOString(),
    };

    const fileContent = buildSkillFile(frontmatter, content);

    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(skillPath, fileContent, "utf-8");

    return {
      success: true,
      action: "create",
      skillPath,
      message: `Created skill: ${skillName}`,
    };
  }

  async deleteSkill(skillName: string): Promise<SkillManageResult> {
    const skillDir = path.join(this.skillsDir, skillName);

    if (!existsSync(skillDir)) {
      throw new Error(`Skill not found: ${skillName}`);
    }

    await fs.rm(skillDir, { recursive: true, force: true });

    return {
      success: true,
      action: "delete",
      skillPath: skillDir,
      message: `Deleted skill: ${skillName}`,
    };
  }

  async addSupportFile(
    skillName: string,
    subDir: "references" | "templates" | "scripts",
    fileName: string,
    content: string,
  ): Promise<SkillManageResult> {
    const filePath = path.join(this.skillsDir, skillName, subDir, fileName);

    if (!existsSync(path.join(this.skillsDir, skillName))) {
      throw new Error(`Skill not found: ${skillName}`);
    }

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf-8");

    return {
      success: true,
      action: "create",
      skillPath: filePath,
      message: `Added ${subDir}/${fileName} to ${skillName}`,
    };
  }
}

function parseSkillFile(content: string): { frontmatter: SkillFileMeta; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const yamlContent = match[1]!;
  const body = match[2]!;

  const frontmatter: Record<string, unknown> = {};
  for (const line of yamlContent.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      if (value.startsWith("[") && value.endsWith("]")) {
        frontmatter[key] = value
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""));
      } else {
        frontmatter[key] = value.replace(/^["']|["']$/g, "");
      }
    }
  }

  return { frontmatter, body };
}

function buildSkillFile(frontmatter: SkillFileMeta, body: string): string {
  const lines: string[] = ["---"];

  for (const [key, value] of Object.entries(frontmatter)) {
    if (value !== undefined && value !== null) {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }

  lines.push("---");
  lines.push("");
  lines.push(body);

  return lines.join("\n");
}
