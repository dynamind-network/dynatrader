/**
 * Skill Trigger & Matching System
 *
 * Dynamic skill selection based on query context, market conditions,
 * and skill metadata. Inspired by Hermes patterns.
 *
 * Features:
 * - Keyword/pattern matching against user messages
 * - Market condition evaluation
 * - Confidence-based filtering
 * - Top-N skill selection for prompt injection
 */

import type { UnifiedSkillManifest } from './unified-skill-manifest';
import { calculateTriggerScore, passesPlatformGates } from './unified-skill-manifest';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillMatchContext {
  /** User message to match against. */
  userMessage?: string;
  /** Current market data. */
  marketData?: Record<string, unknown>;
  /** Current runtime mode. */
  mode?: string;
  /** Available binaries on PATH. */
  availableBins?: string[];
  /** Environment variables. */
  envVars?: Record<string, string>;
  /** Config keys. */
  configKeys?: string[];
  /** Active environments (e.g., ["docker", "kanban"]). */
  activeEnvironments?: string[];
  /** Current OS. */
  os?: string;
}

export interface SkillMatchResult {
  manifest: UnifiedSkillManifest;
  triggerScore: number;
  platformPasses: boolean;
  confidencePasses: boolean;
  finalScore: number;
  reasons: string[];
}

export interface SkillSelectorConfig {
  /** Maximum skills to inject into prompt. Default: 15. */
  maxSkills: number;
  /** Minimum trigger score to include. Default: 0.1. */
  minTriggerScore: number;
  /** Minimum confidence to include. Default: 0.3. */
  minConfidence: number;
  /** Whether to include skills with no triggers (always include). Default: true. */
  includeUntriggered: boolean;
}

const DEFAULT_CONFIG: SkillSelectorConfig = {
  maxSkills: 15,
  minTriggerScore: 0.1,
  minConfidence: 0.3,
  includeUntriggered: true,
};

// ---------------------------------------------------------------------------
// SkillSelector
// ---------------------------------------------------------------------------

export class SkillSelector {
  private skills: UnifiedSkillManifest[] = [];
  private config: SkillSelectorConfig;

  constructor(config: Partial<SkillSelectorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Load skills for matching.
   */
  loadSkills(skills: UnifiedSkillManifest[]): void {
    this.skills = skills;
  }

  /**
   * Add a skill to the loaded set.
   */
  addSkill(skill: UnifiedSkillManifest): void {
    this.skills.push(skill);
  }

  /**
   * Remove a skill by name.
   */
  removeSkill(name: string): void {
    this.skills = this.skills.filter(s => s.name !== name);
  }

  /**
   * Select the best skills for the given context.
   * Returns skills sorted by final score (highest first).
   */
  select(context: SkillMatchContext): SkillMatchResult[] {
    const results: SkillMatchResult[] = [];

    for (const skill of this.skills) {
      // Platform gate check
      const platformResult = passesPlatformGates(skill, {
        os: context.os,
        availableBins: context.availableBins,
        envVars: context.envVars,
        configKeys: context.configKeys,
        activeEnvironments: context.activeEnvironments,
      });

      // Confidence check
      const confidence = skill.gating?.confidenceThreshold ?? 0.5;
      const confidencePasses = confidence >= this.config.minConfidence;

      // Trigger score
      const triggerScore = calculateTriggerScore(skill, {
        userMessage: context.userMessage,
        marketData: context.marketData,
      });

      // Determine if skill should be included
      const reasons: string[] = [];
      let finalScore = triggerScore;

      // Always include skills
      if (skill.gating?.alwaysInclude) {
        reasons.push('always_include');
        finalScore = Math.max(finalScore, 0.9);
      }

      // Include triggered skills
      if (triggerScore >= this.config.minTriggerScore) {
        reasons.push(`trigger_score:${triggerScore.toFixed(2)}`);
      }

      // Include untriggered if configured
      if (this.config.includeUntriggered && triggerScore === 0 && reasons.length === 0) {
        reasons.push('untriggered');
        finalScore = 0.05; // Low base score for untriggered skills
      }

      // Boost for high-confidence skills
      if (confidence > 0.7) {
        finalScore += (confidence - 0.7) * 0.5;
        reasons.push(`high_confidence:${confidence.toFixed(2)}`);
      }

      // Boost for frequently used skills
      if (skill.feedback?.executionCount && skill.feedback.executionCount > 10) {
        const usageBoost = Math.min(0.2, skill.feedback.executionCount / 100);
        finalScore += usageBoost;
        reasons.push(`frequent_use:${skill.feedback.executionCount}`);
      }

      results.push({
        manifest: skill,
        triggerScore,
        platformPasses: platformResult.passed,
        confidencePasses,
        finalScore,
        reasons,
      });
    }

    // Filter and sort
    return results
      .filter(r => r.platformPasses && r.confidencePasses)
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, this.config.maxSkills);
  }

  /**
   * Get all loaded skills.
   */
  getLoadedSkills(): UnifiedSkillManifest[] {
    return [...this.skills];
  }

  /**
   * Get skill count.
   */
  getSkillCount(): number {
    return this.skills.length;
  }
}

// ---------------------------------------------------------------------------
// SkillMatchAnalyzer (for debugging/explanation)
// ---------------------------------------------------------------------------

export class SkillMatchAnalyzer {
  /**
   * Explain why a skill was or wasn't selected.
   */
  static explain(
    manifest: UnifiedSkillManifest,
    context: SkillMatchContext,
  ): string[] {
    const lines: string[] = [];

    lines.push(`Skill: ${manifest.name}`);
    lines.push(`Type: ${manifest.type}`);
    lines.push(`Description: ${manifest.description}`);

    // Platform gates
    const platformResult = passesPlatformGates(manifest, {
      os: context.os,
      availableBins: context.availableBins,
      envVars: context.envVars,
      configKeys: context.configKeys,
      activeEnvironments: context.activeEnvironments,
    });
    lines.push(`Platform gates: ${platformResult.passed ? 'PASS' : `FAIL (${platformResult.reason})`}`);

    // Trigger scores
    const triggerScore = calculateTriggerScore(manifest, {
      userMessage: context.userMessage,
      marketData: context.marketData,
    });
    lines.push(`Trigger score: ${triggerScore.toFixed(3)}`);

    // Keyword matches
    if (manifest.triggers?.keywords && context.userMessage) {
      const messageLower = context.userMessage.toLowerCase();
      const matches = manifest.triggers.keywords.filter((kw: string) =>
        messageLower.includes(kw.toLowerCase()),
      );
      if (matches.length > 0) {
        lines.push(`Keyword matches: ${matches.join(', ')}`);
      }
    }

    // Pattern matches
    if (manifest.triggers?.patterns && context.userMessage) {
      const matches = manifest.triggers.patterns.filter((pattern: string) => {
        try {
          return new RegExp(pattern, 'i').test(context.userMessage!);
        } catch {
          return false;
        }
      });
      if (matches.length > 0) {
        lines.push(`Pattern matches: ${matches.join(', ')}`);
      }
    }

    // Confidence
    const confidence = manifest.gating?.confidenceThreshold ?? 0.5;
    lines.push(`Confidence threshold: ${confidence.toFixed(2)}`);

    // Feedback
    if (manifest.feedback?.executionCount) {
      lines.push(`Executions: ${manifest.feedback.executionCount}`);
      lines.push(`Success rate: ${manifest.feedback.executionCount > 0
        ? ((manifest.feedback.successCount / manifest.feedback.executionCount) * 100).toFixed(1)
        : 0}%`);
    }

    return lines;
  }

  /**
   * Get a summary of all skill matches for debugging.
   */
  static summarizeMatches(
    results: SkillMatchResult[],
    context: SkillMatchContext,
  ): string[] {
    const lines: string[] = [];

    lines.push('=== Skill Match Summary ===');
    lines.push(`Context: ${context.userMessage?.substring(0, 100) ?? 'N/A'}...`);
    lines.push(`Skills evaluated: ${results.length}`);
    lines.push('');

    for (const result of results) {
      const status = result.platformPasses && result.confidencePasses
        ? 'SELECTED'
        : 'EXCLUDED';
      lines.push(`[${status}] ${result.manifest.name}`);
      lines.push(`  Trigger: ${result.triggerScore.toFixed(3)} | Final: ${result.finalScore.toFixed(3)}`);
      if (result.reasons.length > 0) {
        lines.push(`  Reasons: ${result.reasons.join(', ')}`);
      }
      lines.push('');
    }

    return lines;
  }
}
