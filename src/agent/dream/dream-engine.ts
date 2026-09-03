/**
 * Dream Cycle — DreamEngine
 *
 * The core dreaming engine that runs periodic background reflection cycles.
 * Acts as a thin orchestrator delegating to focused modules:
 *   - dream-data-loader:     loadSkills
 *   - dream-skill-review:    reviewAndArchiveSkills (90-day archiving + duplicate merging)
 *   - dream-memory:          compactMemory, finalizeReport, persistReport, getDreamHistory
 *
 * Three phases (Light → REM → Deep):
 * - Light: Load skills, review/archive old (>90 days), merge duplicates (Jaccard >= 0.95)
 * - REM: Cross-session synthesis, extract insights → MEMORY.md
 * - Deep: Full cluster analysis, theme extraction
 */

import { Logger } from '../../orchestration/workspace/logger';

import type { MemoryStoreImpl } from '@dyna/memory-core';
import type { SkillFactory, CrossSessionRecall } from '@dyna/agent-core';
import type { MemoryConsolidation } from '../core/memory-consolidation';

import type {
  DreamConfig,
  DreamReport,
  DreamAction,
  DreamMetrics,
  DreamPhaseName,
  DreamCycleState,
  DreamPhaseContext,
} from './dream-types';
import { DEFAULT_DREAM_CONFIG } from './dream-types';

import type { DreamContext } from './dream-context';
import { loadSkills } from './dream-data-loader';
import { reviewAndArchiveSkills } from './dream-skill-review';
import {
  compactMemory,
  finalizeReport,
  persistReport,
  getDreamHistory,
} from './dream-memory';

const DEFAULT_DREAM_PHASE_ORDER: DreamPhaseName[] = ['light', 'rem', 'deep'];

// ---------------------------------------------------------------------------
// DreamEngine
// ---------------------------------------------------------------------------

export class DreamEngine {
  private memoryStore: MemoryStoreImpl;
  private skillFactory: SkillFactory;
  private crossSessionRecall: CrossSessionRecall;
  private config: DreamConfig;
  private logger: Logger;
  private lastReport: DreamReport | null = null;
  private loopObserved = false;
  private memoryConsolidation?: MemoryConsolidation;

  constructor(
    memoryStore: MemoryStoreImpl,
    skillFactory: SkillFactory,
    crossSessionRecall: CrossSessionRecall,
    config: DreamConfig = DEFAULT_DREAM_CONFIG,
    memoryConsolidation?: MemoryConsolidation,
  ) {
    this.memoryStore = memoryStore;
    this.skillFactory = skillFactory;
    this.crossSessionRecall = crossSessionRecall;
    this.config = { ...DEFAULT_DREAM_CONFIG, ...config };
    this.logger = new Logger('DreamEngine');
    this.memoryConsolidation = memoryConsolidation;
  }

  /** Build a DreamContext for passing to extracted module functions. */
  private createContext(): DreamContext {
    return {
      memoryStore: this.memoryStore,
      skillFactory: this.skillFactory,
      crossSessionRecall: this.crossSessionRecall,
      config: this.config,
      logger: this.logger,
      memoryConsolidation: this.memoryConsolidation,
    };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Run a full dreaming cycle:
   * 1. Load all skills from memory
   * 2. Review each skill — archive old (>90 days), merge duplicates
   * 3. REM phase: cross-session synthesis, extract insights → MEMORY.md
   * 4. Deep phase: full cluster analysis, theme extraction
   * 5. Compact memory
   * 6. Persist DreamReport
   * 7. Return DreamReport
   */
  async runDreamCycle(): Promise<DreamReport> {
    const startTime = performance.now();
    const ctx = this.createContext();
    const state: DreamCycleState = {
      skills: [],
      patterns: [],
      actions: [],
      metrics: {
        skillsReviewed: 0,
        skillsArchived: 0,
        skillsCreated: 0,
        patternsFound: 0,
        insightsGenerated: 0,
      },
    };

    this.logger.info('Starting dreaming cycle');

    try {
      const phaseOrder = this.config.phases?.order ?? DEFAULT_DREAM_PHASE_ORDER;
      for (const phase of phaseOrder) {
        const handler = this.config.phases?.hooks?.[phase] ?? this.getDefaultPhaseHandler(phase);
        const result = await handler({ phase, state, config: this.config });
        if (result?.stop) {
          this.logger.debug(`Dream phase ${phase} requested stop`);
          break;
        }
      }
    } catch (error) {
      this.logger.error('Dream cycle failed', error);
      state.actions.push({
        type: 'skill_adjusted',
        description: 'Dream cycle encountered an error',
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    // Step 5-7: Persist and return DreamReport
    const report = finalizeReport(startTime, state.actions, state.metrics);
    await persistReport(ctx, report);
    this.lastReport = report;

    this.logger.info(
      `Dream cycle complete: ${state.metrics.skillsReviewed} skills reviewed, ` +
      `${state.metrics.skillsArchived} archived, ${state.metrics.skillsCreated} created`,
    );

    return report;
  }

  /**
   * Run a dreaming cycle only if conditions are met:
   * - Dreaming is enabled
   * - Enough learnings have been accumulated
   * - No previous cycle ran recently (config.intervalMs has elapsed)
   *
   * Returns the DreamReport if a cycle was run, or null if skipped.
   */
  async runDreamCycleIfNeeded(): Promise<DreamReport | null> {
    if (!this.config.enabled) {
      this.logger.debug('Dreaming is disabled, skipping');
      return null;
    }

    if (!this.loopObserved) {
      this.logger.debug('No completed loop observed yet, skipping dream cycle');
      return null;
    }

    // Check if enough time has passed since last report
    if (this.lastReport) {
      const elapsed = Date.now() - this.lastReport.timestamp.getTime();
      if (elapsed < this.config.intervalMs) {
        this.logger.debug(
          `Last dream cycle was ${Math.round(elapsed / 1000 / 60)}m ago, ` +
          `need ${Math.round(this.config.intervalMs / 1000 / 60)}m between cycles. Skipping.`,
        );
        return null;
      }
    }

    return this.runDreamCycle();
  }

  /** Mark that the runtime has completed at least one meaningful loop. */
  markLoopCompleted(): void {
    this.loopObserved = true;
  }

  /** Get the most recent DreamReport (null if none has been run). */
  getLastDreamReport(): DreamReport | null {
    return this.lastReport;
  }

  /** Get dream report history from memory. */
  async getDreamHistory(limit: number = 10): Promise<DreamReport[]> {
    return getDreamHistory(this.createContext(), limit);
  }

  private getDefaultPhaseHandler(phase: DreamPhaseName) {
    switch (phase) {
      case 'light':
        return this.runLightPhase.bind(this);
      case 'rem':
        return this.runRemPhase.bind(this);
      case 'deep':
        return this.runDeepPhase.bind(this);
    }
  }

  private async runLightPhase(context: DreamPhaseContext): Promise<void | { stop?: boolean }> {
    this.logger.debug('Running light dreaming phase');
    if (context.state.skills.length === 0) {
      context.state.skills = await loadSkills(this.createContext());
    }
    context.state.metrics.skillsReviewed = context.state.skills.length;
    this.logger.info(`Loaded ${context.state.skills.length} skills`);

    this.logger.debug('Reviewing and consolidating skills');
    const { actions: reviewActions, archivedCount } =
      await reviewAndArchiveSkills(this.createContext(), context.state.skills);
    context.state.actions.push(...reviewActions);
    context.state.metrics.skillsArchived = archivedCount;
    this.logger.info(`Reviewed skills: ${archivedCount} archived`);
  }

  private async runRemPhase(context: DreamPhaseContext): Promise<void | { stop?: boolean }> {
    this.logger.debug('Running REM dreaming phase');

    if (context.state.skills.length === 0) {
      context.state.skills = await loadSkills(this.createContext());
    }
    context.state.metrics.skillsReviewed = context.state.skills.length;
    this.logger.info(`Loaded ${context.state.skills.length} skills`);

    this.logger.debug('Reviewing skills');
    const { actions: reviewActions, archivedCount } =
      await reviewAndArchiveSkills(this.createContext(), context.state.skills);
    context.state.actions.push(...reviewActions);
    context.state.metrics.skillsArchived = archivedCount;
    this.logger.info(`Archived ${archivedCount} skills`);

    this.logger.debug('Cross-session synthesis and MEMORY.md extraction');
    // Synthesize insights from cross-session recall for recent skills
    if (this.crossSessionRecall && context.state.skills.length > 0) {
      const recentSkills = context.state.skills.slice(0, 5);
      const insights: string[] = [];
      for (const skill of recentSkills) {
        const results = await this.crossSessionRecall.search(skill.description);
        if (results.length > 0) {
          insights.push(...results.map(r => r.text));
        }
      }
      if (insights.length > 0) {
        await this.memoryStore.put({
          scope: 'memory_md',
          kind: 'rem_synthesis',
          payload: { insights, timestamp: new Date().toISOString() },
          ts: new Date(),
        });
        context.state.actions.push({
          type: 'insight_generated',
          description: `${insights.length} insights synthesized from cross-session recall`,
        });
        this.logger.info(`Synthesized ${insights.length} insights from cross-session recall`);
      }
    }
  }

  private async runDeepPhase(context: DreamPhaseContext): Promise<void | { stop?: boolean }> {
    this.logger.debug('Running deep dreaming phase');

    if (context.state.skills.length === 0) {
      context.state.skills = await loadSkills(this.createContext());
      context.state.metrics.skillsReviewed = context.state.skills.length;
    }

    this.logger.debug('Compacting memory');
    await compactMemory(this.createContext());

    // Run memory consolidation if available
    if (this.memoryConsolidation) {
      this.logger.debug('Running memory consolidation');
      const consolidationResult = await this.memoryConsolidation.runCycle();
      if (consolidationResult.memoriesConsolidated > 0) {
        context.state.actions.push({
          type: 'insight_generated',
          description: `Memory consolidation: ${consolidationResult.memoriesConsolidated} memories consolidated, ${consolidationResult.memoriesPruned} pruned`,
          detail: JSON.stringify({ consolidated: consolidationResult.memoriesConsolidated, pruned: consolidationResult.memoriesPruned }),
        });
        this.logger.info(`Memory consolidated ${consolidationResult.memoriesConsolidated} memories, pruned ${consolidationResult.memoriesPruned}`);
      }
    }
  }
}