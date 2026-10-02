/**
 * Dream Cycle — DreamScheduler
 *
 * Schedules the dreaming cycle to run periodically using setInterval.
 * Supports start/stop lifecycle and manual triggering.
 */

import { Logger } from '../../orchestration/workspace/logger';

import type { DreamEngine } from './dream-engine';
import type { DreamConfig, DreamReport } from './dream-types';
import { DEFAULT_DREAM_CONFIG } from './dream-types';

// ---------------------------------------------------------------------------
// DreamScheduler
// ---------------------------------------------------------------------------

export class DreamScheduler {
  private dreamEngine: DreamEngine;
  private config: DreamConfig;
  private logger: Logger;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    dreamEngine: DreamEngine,
    config: DreamConfig = DEFAULT_DREAM_CONFIG,
  ) {
    this.dreamEngine = dreamEngine;
    this.config = { ...DEFAULT_DREAM_CONFIG, ...config };
    this.logger = new Logger('DreamScheduler');
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start the periodic dreaming cycle.
   * The dreaming cycle will run on the configured interval.
   */
  start(): void {
    if (this.running) {
      this.logger.warn('DreamScheduler is already running');
      return;
    }

    if (!this.config.enabled) {
      this.logger.info('Dreaming is disabled in config, scheduler will not run');
      return;
    }

    this.running = true;
    this.logger.info(
      `DreamScheduler started (interval: ${this.config.intervalMs / 1000 / 60} minutes)`,
    );

    this.timerId = setInterval(async () => {
      try {
        await this.dreamEngine.runDreamCycleIfNeeded();
      } catch (error) {
        this.logger.error('Scheduled dream cycle failed', error);
      }
    }, this.config.intervalMs);
  }

  /**
   * Stop the periodic dreaming cycle.
   * Safe to call even if not running.
   */
  stop(): void {
    if (!this.running || this.timerId === null) {
      return;
    }

    clearInterval(this.timerId);
    this.timerId = null;
    this.running = false;
    this.logger.info('DreamScheduler stopped');
  }

  /**
   * Check if the scheduler is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  // -------------------------------------------------------------------------
  // Manual triggering
  // -------------------------------------------------------------------------

  /**
   * Manually trigger a dreaming cycle immediately.
   * Returns the DreamReport regardless of whether enough learnings exist.
   */
  async triggerNow(): Promise<DreamReport> {
    this.logger.info('Manual dream cycle triggered');
    return this.dreamEngine.runDreamCycle();
  }
}
