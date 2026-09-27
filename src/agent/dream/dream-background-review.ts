/**
 * Dream Cycle — Background Review Daemon
 *
 * Runs after every agent turn to check if skills/memory should be saved.
   * Forks an agent after every turn to check if skills/memory should be persisted.
   *
   * This is a non-blocking background operation that:
 * - Tracks tool call frequency
 * - Detects repeated patterns that should become skills
 * - Monitors memory entry quality
 * - Triggers skill creation when thresholds are met
 */

import { Logger } from '../../orchestration/workspace/logger';
import type { MemoryStoreImpl } from '@dyna/memory-core';
import type { SkillFactory } from '@dyna/agent-core';
import type { CrossSessionRecall } from '@dyna/agent-core';
import type { ShortTermRecallStore } from './dream-short-term-recall';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BackgroundReviewConfig {
  /** Minimum tool calls before considering skill creation. Default: 5. */
  minToolCallsForSkill: number;
  /** Maximum time window in ms to track tool calls. Default: 30 minutes. */
  toolCallWindowMs: number;
  /** Minimum unique tool types to trigger review. Default: 3. */
  minUniqueTools: number;
  /** Whether background review is enabled. Default: true. */
  enabled: boolean;
}

const DEFAULT_CONFIG: BackgroundReviewConfig = {
  minToolCallsForSkill: 5,
  toolCallWindowMs: 30 * 60 * 1000,
  minUniqueTools: 3,
  enabled: true,
};

export interface ToolCallRecord {
  toolName: string;
  timestamp: number;
  sessionId: string;
  success: boolean;
}

export interface BackgroundReviewResult {
  reviewed: boolean;
  skillCreated: boolean;
  skillName?: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// BackgroundReviewDaemon
// ---------------------------------------------------------------------------

export class BackgroundReviewDaemon {
  private config: BackgroundReviewConfig;
  private logger: Logger;
  private memory: MemoryStoreImpl;
  private skillFactory: SkillFactory;
  private crossSessionRecall: CrossSessionRecall;
  private shortTermRecall: ShortTermRecallStore | null;
  private toolCalls: ToolCallRecord[] = [];
  private lastReviewTime = 0;

  constructor(
    memory: MemoryStoreImpl,
    skillFactory: SkillFactory,
    crossSessionRecall: CrossSessionRecall,
    shortTermRecall?: ShortTermRecallStore,
    config: Partial<BackgroundReviewConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = new Logger('BackgroundReviewDaemon');
    this.memory = memory;
    this.skillFactory = skillFactory;
    this.crossSessionRecall = crossSessionRecall;
    this.shortTermRecall = shortTermRecall ?? null;
  }

  /**
   * Record a tool call for tracking.
   * Called after every tool execution.
   */
  recordToolCall(
    toolName: string,
    sessionId: string,
    success: boolean = true,
  ): void {
    if (!this.config.enabled) return;

    this.toolCalls.push({
      toolName,
      timestamp: Date.now(),
      sessionId,
      success,
    });

    // Prune old entries
    const cutoff = Date.now() - this.config.toolCallWindowMs;
    this.toolCalls = this.toolCalls.filter(tc => tc.timestamp >= cutoff);
  }

  /**
   * Run background review after a turn completes.
   * This is the main entry point called by the runtime.
   */
  async reviewAfterTurn(sessionId: string): Promise<BackgroundReviewResult> {
    if (!this.config.enabled) {
      return { reviewed: false, skillCreated: false, reason: 'Background review disabled' };
    }

    // Rate limit reviews
    const now = Date.now();
    if (now - this.lastReviewTime < 60_000) {
      return { reviewed: false, skillCreated: false, reason: 'Rate limited (last review < 1min ago)' };
    }
    this.lastReviewTime = now;

    // Get recent tool calls for this session
    const sessionCalls = this.toolCalls.filter(tc => tc.sessionId === sessionId);
    if (sessionCalls.length < this.config.minToolCallsForSkill) {
      return {
        reviewed: true,
        skillCreated: false,
        reason: `Only ${sessionCalls.length} tool calls (need ${this.config.minToolCallsForSkill})`,
      };
    }

    // Check for unique tool types
    const uniqueTools = new Set(sessionCalls.map(tc => tc.toolName));
    if (uniqueTools.size < this.config.minUniqueTools) {
      return {
        reviewed: true,
        skillCreated: false,
        reason: `Only ${uniqueTools.size} unique tools (need ${this.config.minUniqueTools})`,
      };
    }

    // Analyze patterns
    const pattern = this.analyzePattern(sessionCalls);
    if (!pattern) {
      return {
        reviewed: true,
        skillCreated: false,
        reason: 'No clear pattern detected',
      };
    }

    // Create skill from pattern
    try {
      const skill = await this.skillFactory.createSkillFromTask({
        title: pattern.name,
        description: pattern.description,
        outcome: pattern.outcome,
        steps: pattern.steps,
        evidence: pattern.evidence,
        tags: pattern.tags,
        successful: true,
      });

      if (skill) {
        this.logger.info(`Background review created skill: ${skill.name}`);

        // Index in cross-session recall
        await this.crossSessionRecall.index(
          `bg-review-${skill.id}`,
          `Background review created skill: ${skill.name} - ${pattern.description}`,
        );

        // Add to short-term recall
        if (this.shortTermRecall) {
          this.shortTermRecall.add(
            `Background review created skill: ${skill.name}`,
            'insight',
            { skillId: skill.name, pattern: pattern.name },
          );
        }

        return {
          reviewed: true,
          skillCreated: true,
          skillName: skill.name,
          reason: `Created skill from ${sessionCalls.length} tool calls`,
        };
      }
    } catch (error) {
      this.logger.warn('Failed to create skill from background review', error);
    }

    return {
      reviewed: true,
      skillCreated: false,
      reason: 'Pattern detected but skill creation failed',
    };
  }

  /**
   * Analyze tool call patterns to detect repeatable sequences.
   */
  private analyzePattern(calls: ToolCallRecord[]): {
    name: string;
    description: string;
    outcome: string;
    steps: string[];
    evidence: string[];
    tags: string[];
  } | null {
    if (calls.length < 3) return null;

    // Count tool frequency
    const toolFreq = new Map<string, number>();
    for (const call of calls) {
      toolFreq.set(call.toolName, (toolFreq.get(call.toolName) ?? 0) + 1);
    }

    // Find dominant tool sequence
    const sortedTools = Array.from(toolFreq.entries())
      .sort((a, b) => b[1] - a[1]);

    const dominantTool = sortedTools[0];
    if (!dominantTool || dominantTool[1] < 2) return null;

    // Build pattern from tool sequence
    const toolSequence = calls.map(c => c.toolName);
    const uniqueSequence = [...new Set(toolSequence)];

    return {
      name: `${uniqueSequence.join('-')}-pattern`,
      description: `Repeatable pattern using ${uniqueSequence.join(', ')} (${calls.length} calls)`,
      outcome: `Successfully executed ${uniqueSequence.join(' -> ')} sequence`,
      steps: uniqueSequence.map((tool, i) => `Step ${i + 1}: Use ${tool}`),
      evidence: calls.map(c => `${c.toolName} at ${new Date(c.timestamp).toISOString()}`),
      tags: [...uniqueSequence, 'background-review', 'auto-generated'],
    };
  }

  /**
   * Get current tool call statistics.
   */
  stats(): {
    totalCalls: number;
    uniqueTools: number;
    recentCalls: number;
  } {
    const cutoff = Date.now() - this.config.toolCallWindowMs;
    const recentCalls = this.toolCalls.filter(tc => tc.timestamp >= cutoff);
    const uniqueTools = new Set(recentCalls.map(tc => tc.toolName));

    return {
      totalCalls: this.toolCalls.length,
      uniqueTools: uniqueTools.size,
      recentCalls: recentCalls.length,
    };
  }

  /**
   * Clear tool call history.
   */
  clear(): void {
    this.toolCalls = [];
  }
}
