/**
 * Skill Feedback Loop
 *
 * Records skill execution outcomes and feeds them back into the
 * memory system and skill metadata. Enables self-improving skills.
 *
 * Pattern from Hermes: learning graph + curator.
 *
 * Features:
 * - Track execution success/failure
 * - Update skill confidence based on outcomes
 * - Record execution history for trend analysis
 * - Feed outcomes into dream system for review
 */

import type { MemoryStoreBackend, MemoryEvent } from '@dyna/memory-core';
import type { UnifiedSkillManifest } from './unified-skill-manifest';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecutionOutcome {
  /** Skill name. */
  skillName: string;
  /** Execution result. */
  success: boolean;
  /** Performance score (0-1). */
  performanceScore?: number;
  /** Duration in ms. */
  durationMs: number;
  /** Input context. */
  inputContext: Record<string, unknown>;
  /** Output results. */
  outputResults: Record<string, unknown>;
  /** Error message if failed. */
  error?: string;
  /** Mode executed in. */
  mode: string;
  /** Actor who executed. */
  actor: string;
  /** Correlation ID. */
  correlationId: string;
}

export interface FeedbackConfig {
  /** Minimum executions before updating confidence. Default: 5. */
  minExecutionsForUpdate: number;
  /** Decay factor for old outcomes. Default: 0.95. */
  decayFactor: number;
  /** Weight for success rate in confidence. Default: 0.6. */
  successWeight: number;
  /** Weight for performance score in confidence. Default: 0.4. */
  performanceWeight: number;
  /** Maximum history entries to keep per skill. Default: 100. */
  maxHistoryPerSkill: number;
}

const DEFAULT_CONFIG: FeedbackConfig = {
  minExecutionsForUpdate: 5,
  decayFactor: 0.95,
  successWeight: 0.6,
  performanceWeight: 0.4,
  maxHistoryPerSkill: 100,
};

// ---------------------------------------------------------------------------
// SkillFeedbackLoop
// ---------------------------------------------------------------------------

export class SkillFeedbackLoop {
  private backend: MemoryStoreBackend;
  private config: FeedbackConfig;
  private skillMetadata: Map<string, UnifiedSkillManifest> = new Map();

  constructor(
    backend: MemoryStoreBackend,
    config: Partial<FeedbackConfig> = {},
  ) {
    this.backend = backend;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Register skill metadata for feedback updates.
   */
  registerSkill(manifest: UnifiedSkillManifest): void {
    this.skillMetadata.set(manifest.name, manifest);
  }

  /**
   * Register multiple skills.
   */
  registerSkills(manifests: UnifiedSkillManifest[]): void {
    for (const manifest of manifests) {
      this.registerSkill(manifest);
    }
  }

  /**
   * Record an execution outcome.
   * Updates skill metadata and stores in memory.
   */
  async recordOutcome(outcome: ExecutionOutcome): Promise<void> {
    // 1. Store outcome in memory
    const event: MemoryEvent = {
      id: `feedback-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      scope: 'skill_feedback',
      kind: 'execution_outcome',
      payload: {
        skillName: outcome.skillName,
        success: outcome.success,
        performanceScore: outcome.performanceScore,
        durationMs: outcome.durationMs,
        inputContext: outcome.inputContext,
        outputResults: outcome.outputResults,
        error: outcome.error,
        mode: outcome.mode,
        actor: outcome.actor,
        correlationId: outcome.correlationId,
        recordedAt: new Date().toISOString(),
      },
      timestamp: new Date(),
      metadata: {
        addedBy: 'skill_feedback_loop',
        source: 'execution_recording',
      },
    };

    await this.backend.put(event);

    // 2. Update skill metadata
    const manifest = this.skillMetadata.get(outcome.skillName);
    if (manifest) {
      this.updateSkillMetadata(manifest, outcome);
    }
  }

  /**
   * Record multiple outcomes in batch.
   */
  async recordOutcomes(outcomes: ExecutionOutcome[]): Promise<void> {
    for (const outcome of outcomes) {
      await this.recordOutcome(outcome);
    }
  }

  /**
   * Get execution history for a skill.
   */
  async getExecutionHistory(
    skillName: string,
    limit: number = 50,
  ): Promise<ExecutionOutcome[]> {
    const results = await this.backend.search({
      scope: 'skill_feedback',
      kind: 'execution_outcome',
      limit,
    });

    const outcomes: ExecutionOutcome[] = [];
    for (const result of results) {
      const event = await this.backend.get(result.id);
      if (event) {
        const payload = event.payload as Record<string, unknown>;
        if (payload.skillName === skillName) {
          outcomes.push({
            skillName: payload.skillName as string,
            success: payload.success as boolean,
            performanceScore: payload.performanceScore as number | undefined,
            durationMs: payload.durationMs as number,
            inputContext: (payload.inputContext as Record<string, unknown>) ?? {},
            outputResults: (payload.outputResults as Record<string, unknown>) ?? {},
            error: payload.error as string | undefined,
            mode: payload.mode as string,
            actor: payload.actor as string,
            correlationId: payload.correlationId as string,
          });
        }
      }
    }

    return outcomes;
  }

  /**
   * Calculate success rate for a skill.
   */
  async getSuccessRate(skillName: string): Promise<number> {
    const history = await this.getExecutionHistory(skillName, this.config.maxHistoryPerSkill);
    if (history.length === 0) return 0.5; // Default neutral

    const successes = history.filter(o => o.success).length;
    return successes / history.length;
  }

  /**
   * Calculate average performance score for a skill.
   */
  async getAvgPerformance(skillName: string): Promise<number> {
    const history = await this.getExecutionHistory(skillName, this.config.maxHistoryPerSkill);
    if (history.length === 0) return 0.5; // Default neutral

    const scored = history.filter(o => o.performanceScore !== undefined);
    if (scored.length === 0) return 0.5;

    const sum = scored.reduce((acc, o) => acc + (o.performanceScore ?? 0.5), 0);
    return sum / scored.length;
  }

  /**
   * Get trend analysis for a skill.
   */
  async getTrendAnalysis(skillName: string): Promise<{
    successRate: number;
    avgPerformance: number;
    recentSuccessRate: number;
    trend: 'improving' | 'stable' | 'declining';
    recommendation: string;
  }> {
    const history = await this.getExecutionHistory(skillName, this.config.maxHistoryPerSkill);

    if (history.length < this.config.minExecutionsForUpdate) {
      return {
        successRate: 0.5,
        avgPerformance: 0.5,
        recentSuccessRate: 0.5,
        trend: 'stable',
        recommendation: 'Insufficient data for trend analysis',
      };
    }

    // Overall metrics
    const successRate = history.filter(o => o.success).length / history.length;
    const scored = history.filter(o => o.performanceScore !== undefined);
    const avgPerformance = scored.length > 0
      ? scored.reduce((acc, o) => acc + (o.performanceScore ?? 0.5), 0) / scored.length
      : 0.5;

    // Recent metrics (last 10 executions)
    const recent = history.slice(0, 10);
    const recentSuccessRate = recent.filter(o => o.success).length / recent.length;

    // Trend detection
    let trend: 'improving' | 'stable' | 'declining' = 'stable';
    if (recentSuccessRate > successRate + 0.1) {
      trend = 'improving';
    } else if (recentSuccessRate < successRate - 0.1) {
      trend = 'declining';
    }

    // Generate recommendation
    let recommendation: string;
    if (trend === 'declining') {
      recommendation = `Consider reviewing skill "${skillName}" - recent performance is declining`;
    } else if (trend === 'improving') {
      recommendation = `Skill "${skillName}" is improving - consider increasing confidence`;
    } else if (successRate < 0.5) {
      recommendation = `Skill "${skillName}" has low success rate (${(successRate * 100).toFixed(1)}%) - may need review`;
    } else {
      recommendation = `Skill "${skillName}" is performing adequately`;
    }

    return {
      successRate,
      avgPerformance,
      recentSuccessRate,
      trend,
      recommendation,
    };
  }

  /**
   * Update skill metadata based on execution outcome.
   */
  private updateSkillMetadata(
    manifest: UnifiedSkillManifest,
    outcome: ExecutionOutcome,
  ): void {
    const feedback = manifest.feedback;

    // Update counts
    feedback.executionCount++;
    if (outcome.success) {
      feedback.successCount++;
    }

    // Update recent outcomes (keep last N)
    feedback.recentOutcomes.push(outcome.success ? 'success' : 'failure');
    if (feedback.recentOutcomes.length > 20) {
      feedback.recentOutcomes = feedback.recentOutcomes.slice(-20);
    }

    // Update average performance with exponential moving average
    if (outcome.performanceScore !== undefined) {
      const alpha = 0.3; // EMA weight
      feedback.avgPerformance = feedback.avgPerformance * (1 - alpha) + outcome.performanceScore * alpha;
    }

    // Update timestamp
    feedback.lastExecutedAt = new Date().toISOString();

    // Update confidence based on success rate
    if (feedback.executionCount >= this.config.minExecutionsForUpdate) {
      const successRate = feedback.successCount / feedback.executionCount;
      const newConfidence = successRate * this.config.successWeight + feedback.avgPerformance * this.config.performanceWeight;

      // Apply decay for old data
      const decayedConfidence = newConfidence * Math.pow(this.config.decayFactor, Math.max(0, feedback.executionCount - 20) / 20);

      // Clamp to [0, 1]
      manifest.gating.confidenceThreshold = Math.max(0, Math.min(1, decayedConfidence));
    }
  }

  /**
   * Get summary statistics for all registered skills.
   */
  async getSummary(): Promise<Array<{
    skillName: string;
    executionCount: number;
    successRate: number;
    avgPerformance: number;
    trend: 'improving' | 'stable' | 'declining';
  }>> {
    const summaries: Array<{
      skillName: string;
      executionCount: number;
      successRate: number;
      avgPerformance: number;
      trend: 'improving' | 'stable' | 'declining';
    }> = [];

    for (const [skillName] of this.skillMetadata) {
      const analysis = await this.getTrendAnalysis(skillName);
      const history = await this.getExecutionHistory(skillName, 1);

      summaries.push({
        skillName,
        executionCount: history.length,
        successRate: analysis.successRate,
        avgPerformance: analysis.avgPerformance,
        trend: analysis.trend,
      });
    }

    return summaries;
  }
}
