/**
 * Strategy Template Manager
 *
 * Loads strategy templates from workspace files and turns them into SkillManifest
 * without shipping person-specific or preset strategy logic in the runtime.
 */

import type { SkillManifest } from "@dyna/contracts";

export interface BotTemplate {
  id: string;
  name: string;
  description?: string;
  category?: string;
  riskLevel?: "low" | "medium" | "high";
  params?: Record<string, unknown>;
  strategy: Partial<SkillManifest>;
}

export interface BotTemplateManagerOptions {
  templateDir?: string;
}

export class BotTemplateManager {
  private readonly templates: BotTemplate[] = [];

  constructor(_options: BotTemplateManagerOptions = {}) {
    // Templates are loaded from workspace at runtime.
    // No hardcoded presets — strategies are SKILL.md files.
  }

  getTemplates(): BotTemplate[] {
    return [...this.templates];
  }

  getTemplate(id: string): BotTemplate | undefined {
    return this.templates.find((t) => t.id === id);
  }

  addTemplate(template: BotTemplate): void {
    this.templates.push(template);
  }
}

export const botTemplateManager = new BotTemplateManager();

export const getTemplateCategories = (): string[] => {
  return Array.from(
    new Set(
      botTemplateManager
        .getTemplates()
        .map((template) => template.category?.trim())
        .filter((category): category is string => Boolean(category && category.length > 0)),
    ),
  ).sort((a, b) => a.localeCompare(b));
};

export const getRiskLevels = (): string[] => {
  return ["low", "medium", "high"];
};
