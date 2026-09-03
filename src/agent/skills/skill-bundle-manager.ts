/**
 * Skill Bundles
 *
 * Groups related skills together with shared instructions.
 * Pattern from Hermes: skill bundles for coordinated execution.
 *
 * Features:
 * - Bundle definitions with shared instructions
 * - Bundle activation/deactivation
 * - Bundle-level permissions and constraints
 * - Bundle execution orchestration
 */

import type { UnifiedSkillManifest } from './unified-skill-manifest';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillBundle {
  /** Unique bundle name. */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Skills included in this bundle. */
  skills: string[];
  /** Shared instruction prefix injected before all skill instructions. */
  instruction?: string;
  /** Bundle-level permissions (overrides individual skill permissions). */
  permissions?: {
    allow?: string[];
    deny?: string[];
  };
  /** Bundle-level security constraints. */
  security?: {
    allowNetwork?: boolean;
    allowFilesystem?: boolean;
    allowCredentials?: boolean;
    allowOrderExecution?: boolean;
  };
  /** Tags for categorization. */
  tags?: string[];
  /** Whether this bundle is enabled. */
  enabled: boolean;
  /** Creation timestamp. */
  createdAt: string;
  /** Last modified timestamp. */
  updatedAt: string;
}

export interface BundleExecutionPlan {
  bundle: SkillBundle;
  skills: UnifiedSkillManifest[];
  sharedContext: Record<string, unknown>;
  executionOrder: string[];
}

// ---------------------------------------------------------------------------
// SkillBundleManager
// ---------------------------------------------------------------------------

export class SkillBundleManager {
  private bundles: Map<string, SkillBundle> = new Map();
  private skills: Map<string, UnifiedSkillManifest> = new Map();

  /**
   * Register a skill manifest.
   */
  registerSkill(manifest: UnifiedSkillManifest): void {
    this.skills.set(manifest.name, manifest);
  }

  /**
   * Register multiple skill manifests.
   */
  registerSkills(manifests: UnifiedSkillManifest[]): void {
    for (const manifest of manifests) {
      this.registerSkill(manifest);
    }
  }

  /**
   * Create a new bundle.
   */
  createBundle(bundle: Omit<SkillBundle, 'createdAt' | 'updatedAt'>): SkillBundle {
    if (this.bundles.has(bundle.name)) {
      throw new Error(`Bundle "${bundle.name}" already exists`);
    }

    // Validate all skills exist
    for (const skillName of bundle.skills) {
      if (!this.skills.has(skillName)) {
        throw new Error(`Skill "${skillName}" not found`);
      }
    }

    const newBundle: SkillBundle = {
      ...bundle,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.bundles.set(bundle.name, newBundle);
    return newBundle;
  }

  /**
   * Update an existing bundle.
   */
  updateBundle(
    name: string,
    updates: Partial<Omit<SkillBundle, 'name' | 'createdAt'>>,
  ): SkillBundle {
    const bundle = this.bundles.get(name);
    if (!bundle) {
      throw new Error(`Bundle "${name}" not found`);
    }

    // Validate skills if updating skill list
    if (updates.skills) {
      for (const skillName of updates.skills) {
        if (!this.skills.has(skillName)) {
          throw new Error(`Skill "${skillName}" not found`);
        }
      }
    }

    const updatedBundle: SkillBundle = {
      ...bundle,
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    this.bundles.set(name, updatedBundle);
    return updatedBundle;
  }

  /**
   * Delete a bundle.
   */
  deleteBundle(name: string): boolean {
    return this.bundles.delete(name);
  }

  /**
   * Get a bundle by name.
   */
  getBundle(name: string): SkillBundle | undefined {
    return this.bundles.get(name);
  }

  /**
   * Get all bundles.
   */
  getAllBundles(): SkillBundle[] {
    return Array.from(this.bundles.values());
  }

  /**
   * Get enabled bundles.
   */
  getEnabledBundles(): SkillBundle[] {
    return this.getAllBundles().filter(b => b.enabled);
  }

  /**
   * Get bundles containing a specific skill.
   */
  getBundlesForSkill(skillName: string): SkillBundle[] {
    return this.getAllBundles().filter(b => b.skills.includes(skillName));
  }

  /**
   * Enable/disable a bundle.
   */
  setBundleEnabled(name: string, enabled: boolean): void {
    const bundle = this.bundles.get(name);
    if (!bundle) {
      throw new Error(`Bundle "${name}" not found`);
    }

    bundle.enabled = enabled;
    bundle.updatedAt = new Date().toISOString();
  }

  /**
   * Create an execution plan for a bundle.
   * Determines execution order based on skill dependencies.
   */
  createExecutionPlan(
    bundleName: string,
    context: Record<string, unknown> = {},
  ): BundleExecutionPlan {
    const bundle = this.bundles.get(bundleName);
    if (!bundle) {
      throw new Error(`Bundle "${bundleName}" not found`);
    }

    if (!bundle.enabled) {
      throw new Error(`Bundle "${bundleName}" is disabled`);
    }

    // Get skill manifests
    const skills: UnifiedSkillManifest[] = [];
    for (const skillName of bundle.skills) {
      const skill = this.skills.get(skillName);
      if (skill) {
        skills.push(skill);
      }
    }

    // Determine execution order (simple: by type priority)
    const typePriority: Record<string, number> = {
      research: 0,
      analysis: 1,
      strategy: 2,
      risk: 3,
      utility: 4,
    };

    const executionOrder = skills
      .sort((a, b) => (typePriority[a.type] ?? 5) - (typePriority[b.type] ?? 5))
      .map(s => s.name);

    return {
      bundle,
      skills,
      sharedContext: context,
      executionOrder,
    };
  }

  /**
   * Get bundle statistics.
   */
  getStats(): {
    totalBundles: number;
    enabledBundles: number;
    totalSkillsInBundles: number;
    avgSkillsPerBundle: number;
    bundlesByTag: Record<string, number>;
  } {
    const bundles = this.getAllBundles();
    const enabled = bundles.filter(b => b.enabled);

    let totalSkills = 0;
    const bundlesByTag: Record<string, number> = {};

    for (const bundle of bundles) {
      totalSkills += bundle.skills.length;

      for (const tag of bundle.tags ?? []) {
        bundlesByTag[tag] = (bundlesByTag[tag] ?? 0) + 1;
      }
    }

    return {
      totalBundles: bundles.length,
      enabledBundles: enabled.length,
      totalSkillsInBundles: totalSkills,
      avgSkillsPerBundle: bundles.length > 0 ? totalSkills / bundles.length : 0,
      bundlesByTag,
    };
  }

  /**
   * Export bundles as JSON.
   */
  exportBundles(): string {
    return JSON.stringify(this.getAllBundles(), null, 2);
  }

  /**
   * Import bundles from JSON.
   */
  importBundles(json: string): number {
    const bundles: SkillBundle[] = JSON.parse(json);
    let imported = 0;

    for (const bundle of bundles) {
      try {
        this.bundles.set(bundle.name, bundle);
        imported++;
      } catch {
        // Skip invalid bundles
      }
    }

    return imported;
  }
}

// ---------------------------------------------------------------------------
// BundleTemplates (pre-defined bundles)
// ---------------------------------------------------------------------------

export const BUNDLE_TEMPLATES: Omit<SkillBundle, 'createdAt' | 'updatedAt'>[] = [
  {
    name: 'trading-research',
    description: 'Research and analysis skills for trading decisions',
    skills: ['market-analysis', 'technical-analysis', 'fundamental-analysis'],
    instruction: 'Conduct thorough research before making any trading decisions.',
    tags: ['trading', 'research'],
    enabled: true,
  },
  {
    name: 'risk-management',
    description: 'Risk assessment and management skills',
    skills: ['risk-assessment', 'portfolio-analysis', 'position-sizing'],
    instruction: 'Always assess risk before executing trades.',
    tags: ['trading', 'risk'],
    enabled: true,
  },
  {
    name: 'strategy-backtest',
    description: 'Strategy development and backtesting',
    skills: ['strategy-development', 'backtesting', 'performance-analysis'],
    instruction: 'Backtest strategies thoroughly before live deployment.',
    tags: ['trading', 'strategy'],
    enabled: true,
  },
];
