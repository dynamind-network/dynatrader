/**
 * Dream Cycle — Procedural Memory Trigger
 *
 * Auto-creates skills after repeated tool call patterns.
 * Adapted from Hermes Agent's procedural memory pattern which
 * monitors tool usage and creates skills when thresholds are met.
 *
 * This module provides:
 * - Prompt guidance for skill creation
 * - Tool call pattern analysis
 * - Skill creation threshold management
 * - Integration with short-term recall
 */

import { Logger } from '../../orchestration/workspace/logger';
import type { SkillFactory } from '@dyna/agent-core';
import type { CrossSessionRecall } from '@dyna/agent-core';
import type { ShortTermRecallStore } from './dream-short-term-recall';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProceduralMemoryConfig {
  /** Minimum tool calls before triggering skill creation. Default: 5. */
  minToolCalls: number;
  /** Minimum unique tool types to trigger. Default: 2. */
  minUniqueTools: number;
  /** Maximum time window in ms. Default: 15 minutes. */
  windowMs: number;
  /** Whether procedural memory is enabled. Default: true. */
  enabled: boolean;
  /** Whether to generate prompt guidance. Default: true. */
  generatePromptGuidance: boolean;
}

const DEFAULT_CONFIG: ProceduralMemoryConfig = {
  minToolCalls: 5,
  minUniqueTools: 2,
  windowMs: 15 * 60 * 1000,
  enabled: true,
  generatePromptGuidance: true,
};

export interface ToolUsageRecord {
  toolName: string;
  timestamp: number;
  sessionId: string;
  args?: Record<string, unknown>;
  result?: unknown;
  success: boolean;
}

export interface ProceduralPattern {
  id: string;
  name: string;
  description: string;
  tools: string[];
  frequency: number;
  firstSeen: number;
  lastSeen: number;
  successRate: number;
}

export interface SkillCreationPrompt {
  shouldCreate: boolean;
  prompt: string;
  pattern: ProceduralPattern | null;
  reason: string;
}

// ---------------------------------------------------------------------------
// ProceduralMemoryTrigger
// ---------------------------------------------------------------------------

export class ProceduralMemoryTrigger {
  private config: ProceduralMemoryConfig;
  private logger: Logger;
  private skillFactory: SkillFactory;
  private crossSessionRecall: CrossSessionRecall;
  private shortTermRecall: ShortTermRecallStore | null;
  private toolUsages: ToolUsageRecord[] = [];
  private patterns: Map<string, ProceduralPattern> = new Map();

  constructor(
    skillFactory: SkillFactory,
    crossSessionRecall: CrossSessionRecall,
    shortTermRecall?: ShortTermRecallStore,
    config: Partial<ProceduralMemoryConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = new Logger('ProceduralMemoryTrigger');
    this.skillFactory = skillFactory;
    this.crossSessionRecall = crossSessionRecall;
    this.shortTermRecall = shortTermRecall ?? null;
  }

  /**
   * Record a tool usage event.
   */
  recordToolUsage(
    toolName: string,
    sessionId: string,
    args?: Record<string, unknown>,
    result?: unknown,
    success: boolean = true,
  ): void {
    if (!this.config.enabled) return;

    this.toolUsages.push({
      toolName,
      timestamp: Date.now(),
      sessionId,
      args,
      result,
      success,
    });

    // Prune old entries
    const cutoff = Date.now() - this.config.windowMs;
    this.toolUsages = this.toolUsages.filter(u => u.timestamp >= cutoff);

    // Update patterns
    this.updatePatterns(sessionId);
  }

  /**
   * Check if skill creation should be triggered.
   */
  shouldCreateSkill(sessionId: string): SkillCreationPrompt {
    if (!this.config.enabled) {
      return {
        shouldCreate: false,
        prompt: '',
        pattern: null,
        reason: 'Procedural memory disabled',
      };
    }

    const sessionUsages = this.toolUsages.filter(u => u.sessionId === sessionId);
    if (sessionUsages.length < this.config.minToolCalls) {
      return {
        shouldCreate: false,
        prompt: '',
        pattern: null,
        reason: `Only ${sessionUsages.length} tool calls (need ${this.config.minToolCalls})`,
      };
    }

    // Check for patterns
    const pattern = this.findRepeatingPattern(sessionUsages);
    if (!pattern) {
      return {
        shouldCreate: false,
        prompt: '',
        pattern: null,
        reason: 'No repeating pattern detected',
      };
    }

    // Generate prompt guidance
    const prompt = this.config.generatePromptGuidance
      ? this.generateSkillCreationPrompt(pattern, sessionUsages)
      : '';

    return {
      shouldCreate: true,
      prompt,
      pattern,
      reason: `Pattern "${pattern.name}" detected with ${pattern.frequency} occurrences`,
    };
  }

  /**
   * Create a skill from a detected pattern.
   */
  async createSkillFromPattern(pattern: ProceduralPattern): Promise<boolean> {
    try {
      const skill = await this.skillFactory.createSkillFromTask({
        title: pattern.name,
        description: pattern.description,
        outcome: `Successfully executed ${pattern.tools.join(' -> ')} sequence`,
        steps: pattern.tools.map((tool, i) => `Step ${i + 1}: Use ${tool}`),
        evidence: [
          `Pattern detected ${pattern.frequency} times`,
          `Success rate: ${(pattern.successRate * 100).toFixed(0)}%`,
          `First seen: ${new Date(pattern.firstSeen).toISOString()}`,
          `Last seen: ${new Date(pattern.lastSeen).toISOString()}`,
        ],
        tags: [...pattern.tools, 'procedural-memory', 'auto-generated'],
        successful: true,
      });

      if (skill) {
        this.logger.info(`Created procedural skill: ${skill.name}`);

        // Index in cross-session recall
        await this.crossSessionRecall.index(
          `proc-memory-${skill.id}`,
          `Procedural memory created skill: ${skill.name} - ${pattern.description}`,
        );

        // Add to short-term recall
        if (this.shortTermRecall) {
          this.shortTermRecall.add(
            `Procedural memory created skill: ${skill.name}`,
            'insight',
            { skillId: skill.name, pattern: pattern.name, frequency: pattern.frequency },
          );
        }

        return true;
      }
    } catch (error) {
      this.logger.warn('Failed to create procedural skill', error);
    }

    return false;
  }

  /**
   * Find repeating patterns in tool usage.
   */
  private findRepeatingPattern(usages: ToolUsageRecord[]): ProceduralPattern | null {
    if (usages.length < 3) return null;

    // Build tool sequence
    const sequence = usages.map(u => u.toolName);
    const uniqueTools = new Set(sequence);

    if (uniqueTools.size < this.config.minUniqueTools) return null;

    // Find most common subsequence
    const subsequences = this.findCommonSubsequences(sequence);
    if (subsequences.length === 0) return null;

    const best = subsequences[0];
    if (!best || best.frequency < 2) return null;

    // Calculate success rate
    const patternUsages = usages.filter(u => best.tools.includes(u.toolName));
    const successCount = patternUsages.filter(u => u.success).length;
    const successRate = patternUsages.length > 0 ? successCount / patternUsages.length : 1;

    return {
      id: `proc-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      name: best.tools.join('-'),
      description: `Repeating pattern: ${best.tools.join(' -> ')} (${best.frequency} times)`,
      tools: best.tools,
      frequency: best.frequency,
      firstSeen: Math.min(...patternUsages.map(u => u.timestamp)),
      lastSeen: Math.max(...patternUsages.map(u => u.timestamp)),
      successRate,
    };
  }

  /**
   * Find common subsequences in a tool sequence.
   */
  private findCommonSubsequences(sequence: string[]): Array<{
    tools: string[];
    frequency: number;
  }> {
    const subsequences = new Map<string, number>();

    // Check sequences of length 2-5
    for (let len = 2; len <= Math.min(5, sequence.length); len++) {
      for (let i = 0; i <= sequence.length - len; i++) {
        const sub = sequence.slice(i, i + len).join('->');
        subsequences.set(sub, (subsequences.get(sub) ?? 0) + 1);
      }
    }

    // Convert to array and sort by frequency
    return Array.from(subsequences.entries())
      .map(([key, frequency]) => ({
        tools: key.split('->'),
        frequency,
      }))
      .filter(s => s.frequency >= 2)
      .sort((a, b) => b.frequency - a.frequency);
  }

  /**
   * Update pattern tracking.
   */
  private updatePatterns(sessionId: string): void {
    const sessionUsages = this.toolUsages.filter(u => u.sessionId === sessionId);
    const pattern = this.findRepeatingPattern(sessionUsages);

    if (pattern) {
      this.patterns.set(pattern.id, pattern);
    }
  }

  /**
   * Generate prompt guidance for skill creation.
   */
  private generateSkillCreationPrompt(
    pattern: ProceduralPattern,
    usages: ToolUsageRecord[],
  ): string {
    const toolList = pattern.tools.join(', ');
    const successRate = (pattern.successRate * 100).toFixed(0);

    return [
      `I've detected a repeating pattern in your tool usage: ${toolList}`,
      `This pattern has been used ${pattern.frequency} times with a ${successRate}% success rate.`,
      '',
      'Would you like me to create a reusable skill from this pattern?',
      'This skill will:',
      `- Automate the ${toolList} sequence`,
      `- Be available for future sessions`,
      `- Help similar tasks run faster`,
      '',
      'To create the skill, I need your confirmation.',
      'Type "yes" to create the skill, or "no" to skip.',
    ].join('\n');
  }

  /**
   * Get all detected patterns.
   */
  getPatterns(): ProceduralPattern[] {
    return Array.from(this.patterns.values());
  }

  /**
   * Get statistics.
   */
  stats(): {
    totalUsages: number;
    patternsDetected: number;
    skillsCreated: number;
  } {
    return {
      totalUsages: this.toolUsages.length,
      patternsDetected: this.patterns.size,
      skillsCreated: 0, // Would need to track this separately
    };
  }

  /**
   * Clear all data.
   */
  clear(): void {
    this.toolUsages = [];
    this.patterns.clear();
  }
}
