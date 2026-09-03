/**
 * Dream Cycle — DreamEngine
 *
 * The core dreaming engine that runs periodic background reflection cycles.
 * Acts as a thin orchestrator delegating to focused modules:
 *   - dream-data-loader:     loadLearnings, loadSkills
 *   - dream-skill-review:    reviewAndArchiveSkills
 *   - dream-pattern-discovery: discoverPatterns
 *   - dream-insights:        generateInsights
 *   - dream-skill-creation:  createSkillsFromPatterns
 *   - dream-memory:          compactMemory, finalizeReport, persistReport, getDreamHistory
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

// Import from extracted modules
import type { DreamContext } from './dream-context';
import { loadLearnings, loadSkills } from './dream-data-loader';
import { reviewAndArchiveSkills } from './dream-skill-review';
import { discoverPatterns } from './dream-pattern-discovery';
import { generateInsights } from './dream-insights';
import { createSkillsFromPatterns } from './dream-skill-creation';
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
   * 1. Load all learnings from memory
   * 2. Load all skills from memory
   * 3. Review each skill — archive low-confidence ones
   * 4. Discover patterns from learnings
   * 5. Generate insights if enough learnings
   * 6. Create new skills from discovered patterns
   * 7. Compact memory
   * 8. Persist DreamReport
   * 9. Return DreamReport
   */
  async runDreamCycle(): Promise<DreamReport> {
    const startTime = performance.now();
    const ctx = this.createContext();
    const state: DreamCycleState = {
      learnings: [],
      skills: [],
      patterns: [],
      actions: [],
      metrics: {
        totalLearnings: 0,
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

    // Step 8-9: Persist and return DreamReport
    const report = finalizeReport(startTime, state.actions, state.metrics);
    await persistReport(ctx, report);
    this.lastReport = report;

    this.logger.info(
      `Dream cycle complete: ${state.metrics.skillsReviewed} skills reviewed, ` +
      `${state.metrics.skillsArchived} archived, ${state.metrics.skillsCreated} created, ` +
      `${state.metrics.patternsFound} patterns found, ${state.metrics.insightsGenerated} insights`,
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

    const ctx = this.createContext();
    const learnings = await loadLearnings(ctx);
    if (learnings.length < this.config.minLearningsForDream) {
      this.logger.debug(
        `Only ${learnings.length} learnings, need ${this.config.minLearningsForDream}. Skipping.`,
      );
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
    if (context.state.learnings.length === 0) {
      context.state.learnings = await loadLearnings(this.createContext());
    }
    context.state.metrics.totalLearnings = context.state.learnings.length;
    this.logger.info(`Loaded ${context.state.learnings.length} learnings`);

    if (context.state.learnings.length < this.config.minLearningsForDream) {
      this.logger.info(
        `Not enough learnings (${context.state.learnings.length} < ${this.config.minLearningsForDream}), skipping remaining phases`,
      );
      return { stop: true };
    }
  }

  private async runRemPhase(context: DreamPhaseContext): Promise<void | { stop?: boolean }> {
    this.logger.debug('Running REM dreaming phase');
    if (context.state.learnings.length === 0) {
      context.state.learnings = await loadLearnings(this.createContext());
      context.state.metrics.totalLearnings = context.state.learnings.length;
    }

    if (context.state.learnings.length < this.config.minLearningsForDream) {
      this.logger.info(
        `Not enough learnings (${context.state.learnings.length} < ${this.config.minLearningsForDream}), skipping REM phase`,
      );
      return { stop: true };
    }

    if (context.state.skills.length === 0) {
      context.state.skills = await loadSkills(this.createContext());
    }
    context.state.metrics.skillsReviewed = context.state.skills.length;
    this.logger.info(`Loaded ${context.state.skills.length} skills`);

    this.logger.debug('Reviewing skills');
    const { actions: reviewActions, archivedCount } =
      await reviewAndArchiveSkills(this.createContext(), context.state.skills, context.state.learnings);
    context.state.actions.push(...reviewActions);
    context.state.metrics.skillsArchived = archivedCount;

    this.logger.debug('Discovering patterns');
    const { patterns, actions: patternActions } =
      await discoverPatterns(this.createContext(), context.state.learnings);
    context.state.actions.push(...patternActions);
    context.state.patterns = patterns;
    context.state.metrics.patternsFound = patterns.length;
    this.logger.info(`Discovered ${patterns.length} patterns`);

    this.logger.debug('Generating insights');
    const { actions: insightActions } =
      await generateInsights(this.createContext(), context.state.learnings, patterns);
    context.state.actions.push(...insightActions);
    context.state.metrics.insightsGenerated = insightActions.length;
    this.logger.info(`Generated ${insightActions.length} insights`);
  }

  private async runDeepPhase(context: DreamPhaseContext): Promise<void | { stop?: boolean }> {
    this.logger.debug('Running deep dreaming phase');
    if (context.state.learnings.length === 0) {
      context.state.learnings = await loadLearnings(this.createContext());
      context.state.metrics.totalLearnings = context.state.learnings.length;
    }

    if (context.state.learnings.length < this.config.minLearningsForDream) {
      this.logger.info(
        `Not enough learnings (${context.state.learnings.length} < ${this.config.minLearningsForDream}), skipping deep phase`,
      );
      return { stop: true };
    }

    if (context.state.patterns.length === 0) {
      this.logger.debug('No staged patterns available, deriving patterns in deep phase');
      const { patterns, actions } = await discoverPatterns(this.createContext(), context.state.learnings);
      context.state.patterns = patterns;
      context.state.actions.push(...actions);
      context.state.metrics.patternsFound = patterns.length;
    }

    if (context.state.patterns.length > 0) {
      this.logger.debug('Creating skills from patterns');
      const { actions: skillActions } =
        await createSkillsFromPatterns(this.createContext(), context.state.patterns, context.state.learnings);
      context.state.actions.push(...skillActions);
      context.state.metrics.skillsCreated = skillActions.length;
      this.logger.info(`Created ${skillActions.length} new skills`);
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
