/**
 * Dream Cycle — Drift Detection
 *
 * Detects round-trip mismatches when writing to memory files.
 * Adapted from Hermes Agent's drift detection pattern which verifies
 * that written content matches the intended intent.
 *
 * Prevents inconsistent memory state by checking:
 * - Semantic drift: does the written content match the original intent?
 * - Contradiction drift: does the new content contradict existing memory?
 * - Temporal drift: is the content stale or outdated?
 */

import type { MemoryStoreImpl } from '@dyna/memory-core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DriftDetectionConfig {
  /** Maximum allowed semantic similarity drift (0-1). Default: 0.3. */
  maxSemanticDrift: number;
  /** Whether to log drift events. Default: true. */
  logDriftEvents: boolean;
  /** Maximum drift events to track per session. Default: 50. */
  maxEventsPerSession: number;
}

const DEFAULT_CONFIG: DriftDetectionConfig = {
  maxSemanticDrift: 0.3,
  logDriftEvents: true,
  maxEventsPerSession: 50,
};

export interface DriftEvent {
  id: string;
  type: 'semantic' | 'contradiction' | 'temporal';
  intended: string;
  actual: string;
  driftScore: number;
  timestamp: number;
  resolved: boolean;
}

export interface DriftCheckResult {
  hasDrift: boolean;
  driftScore: number;
  events: DriftEvent[];
  recommendation: 'proceed' | 'review' | 'block';
}

// ---------------------------------------------------------------------------
// DriftDetector
// ---------------------------------------------------------------------------

export class DriftDetector {
  private config: DriftDetectionConfig;
  private events: DriftEvent[] = [];
  private memory: MemoryStoreImpl | null;

  constructor(
    memory?: MemoryStoreImpl,
    config: Partial<DriftDetectionConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.memory = memory ?? null;
  }

  /**
   * Check for drift between intended write and actual content.
   * This is the main entry point for drift detection.
   */
  async checkDrift(
    intended: string,
    actual: string,
    scope?: string,
  ): Promise<DriftCheckResult> {
    const events: DriftEvent[] = [];

    // 1. Semantic drift check
    const semanticDrift = this.checkSemanticDrift(intended, actual);
    if (semanticDrift.driftScore > this.config.maxSemanticDrift) {
      events.push(semanticDrift.event);
    }

    // 2. Contradiction drift check (if memory available)
    if (this.memory && scope) {
      const contradictionDrift = await this.checkContradictionDrift(actual, scope);
      if (contradictionDrift) {
        events.push(contradictionDrift);
      }
    }

    // 3. Temporal drift check
    const temporalDrift = this.checkTemporalDrift(actual);
    if (temporalDrift) {
      events.push(temporalDrift);
    }

    // Track events
    for (const event of events) {
      this.trackEvent(event);
    }

    // Determine recommendation
    const maxDrift = events.reduce((max, e) => Math.max(max, e.driftScore), 0);
    let recommendation: DriftCheckResult['recommendation'] = 'proceed';
    if (maxDrift > 0.7) {
      recommendation = 'block';
    } else if (maxDrift > this.config.maxSemanticDrift) {
      recommendation = 'review';
    }

    return {
      hasDrift: events.length > 0,
      driftScore: maxDrift,
      events,
      recommendation,
    };
  }

  /**
   * Check semantic drift between intended and actual content.
   * Uses token overlap scoring (Jaccard-like).
   */
  private checkSemanticDrift(
    intended: string,
    actual: string,
  ): { driftScore: number; event: DriftEvent } {
    const intendedTokens = this.tokenize(intended);
    const actualTokens = this.tokenize(actual);

    const intersection = intendedTokens.filter(t => actualTokens.includes(t));
    const union = new Set([...intendedTokens, ...actualTokens]);

    const jaccard = union.size > 0 ? intersection.length / union.size : 1;
    const driftScore = 1 - jaccard;

    return {
      driftScore,
      event: {
        id: `drift-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
        type: 'semantic',
        intended,
        actual,
        driftScore,
        timestamp: Date.now(),
        resolved: false,
      },
    };
  }

  /**
   * Check if new content contradicts existing memory.
   */
  private async checkContradictionDrift(
    content: string,
    scope: string,
  ): Promise<DriftEvent | null> {
    if (!this.memory) return null;

    try {
      const results = await this.memory.search({
        scope,
        text: content,
        topK: 5,
      });

      for (const result of results) {
        const existingContent = String(result.payload ?? '');
        if (this.hasContradiction(content, existingContent)) {
          return {
            id: `drift-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
            type: 'contradiction',
            intended: content,
            actual: existingContent,
            driftScore: 0.8,
            timestamp: Date.now(),
            resolved: false,
          };
        }
      }
    } catch {
      // Memory search failed; skip contradiction check
    }

    return null;
  }

  /**
   * Check if content is temporally stale.
   */
  private checkTemporalDrift(content: string): DriftEvent | null {
    const datePatterns = [
      /(\d{4})-(\d{2})-(\d{2})/g,
      /(\d{2})\/(\d{2})\/(\d{4})/g,
    ];

    for (const pattern of datePatterns) {
      const matches = content.match(pattern);
      if (matches) {
        for (const match of matches) {
          const date = new Date(match);
          if (!isNaN(date.getTime())) {
            const ageDays = (Date.now() - date.getTime()) / (1000 * 60 * 60 * 24);
            if (ageDays > 30) {
              return {
                id: `drift-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
                type: 'temporal',
                intended: content,
                actual: `Content references date ${match} which is ${Math.round(ageDays)} days old`,
                driftScore: Math.min(1, ageDays / 90),
                timestamp: Date.now(),
                resolved: false,
              };
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Check for contradiction between two text blocks.
   * Simple heuristic: looks for opposing sentiment terms.
   */
  private hasContradiction(text1: string, text2: string): boolean {
    const positive = ['profit', 'gain', 'increase', 'bullish', 'up', 'rise', 'success'];
    const negative = ['loss', 'decrease', 'bearish', 'down', 'fall', 'fail', 'error'];

    const text1Lower = text1.toLowerCase();
    const text2Lower = text2.toLowerCase();

    const text1Positive = positive.some(t => text1Lower.includes(t));
    const text1Negative = negative.some(t => text1Lower.includes(t));
    const text2Positive = positive.some(t => text2Lower.includes(t));
    const text2Negative = negative.some(t => text2Lower.includes(t));

    return (text1Positive && text2Negative) || (text1Negative && text2Positive);
  }

  /**
   * Tokenize text for comparison.
   */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2);
  }

  /**
   * Track a drift event.
   */
  private trackEvent(event: DriftEvent): void {
    this.events.push(event);

    // Trim if over limit
    if (this.events.length > this.config.maxEventsPerSession) {
      this.events = this.events.slice(-this.config.maxEventsPerSession);
    }

    if (this.config.logDriftEvents) {
      console.warn(
        `[DriftDetector] ${event.type} drift detected (score: ${event.driftScore.toFixed(2)}):`,
        event.intended.substring(0, 100),
        '->',
        event.actual.substring(0, 100),
      );
    }
  }

  /**
   * Get all tracked drift events.
   */
  getEvents(): DriftEvent[] {
    return [...this.events];
  }

  /**
   * Get drift statistics.
   */
  stats(): {
    total: number;
    byType: Record<string, number>;
    unresolved: number;
    avgDriftScore: number;
  } {
    const byType: Record<string, number> = {};
    let totalScore = 0;

    for (const event of this.events) {
      byType[event.type] = (byType[event.type] ?? 0) + 1;
      totalScore += event.driftScore;
    }

    return {
      total: this.events.length,
      byType,
      unresolved: this.events.filter(e => !e.resolved).length,
      avgDriftScore: this.events.length > 0 ? totalScore / this.events.length : 0,
    };
  }

  /**
   * Mark an event as resolved.
   */
  resolveEvent(eventId: string): boolean {
    const event = this.events.find(e => e.id === eventId);
    if (event) {
      event.resolved = true;
      return true;
    }
    return false;
  }

  /**
   * Clear all events.
   */
  clear(): void {
    this.events = [];
  }
}
