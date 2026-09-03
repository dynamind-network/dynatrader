/**
 * Dream Cycle — Type Definitions
 *
 * Types for the background reflection/consolidation system that runs
 * periodically to analyze past trades, consolidate learnings, prune
 * weak skills, and generate new insights.
 */

import type { Learning } from '@dyna/agent-core';
import type { SkillEntry } from './dream-data-loader';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type DreamPhaseName = 'light' | 'rem' | 'deep';

export * from './dream-enhanced-types.js';

export interface DreamCycleState {
  learnings: Learning[];
  skills: SkillEntry[];
  patterns: DreamPattern[];
  actions: DreamAction[];
  metrics: DreamMetrics;
}

export interface DreamPhaseContext {
  phase: DreamPhaseName;
  state: DreamCycleState;
  config: DreamConfig;
}

export interface DreamPhaseHookResult {
  stop?: boolean;
}

export type DreamPhaseHook =
  (context: DreamPhaseContext) => Promise<DreamPhaseHookResult | void> | DreamPhaseHookResult | void;

export interface DreamPhaseConfig {
  order?: DreamPhaseName[];
  hooks?: Partial<Record<DreamPhaseName, DreamPhaseHook>>;
}

export interface DreamConfig {
  /** Interval between dreaming cycles in ms (default: 24h = 86400000) */
  intervalMs: number;
  /** Minimum learnings required to run a full dreaming cycle */
  minLearningsForDream: number;
  /** Skills with confidence below this threshold get archived */
  skillConfidenceThreshold: number;
  /** Maximum number of skills to keep per type */
  maxSkillsPerType: number;
  /** Whether the dreaming system is enabled */
  enabled: boolean;
  /** Optional phase order and hooks for hybrid/custom dreaming loops. */
  phases?: DreamPhaseConfig;
}

export const DEFAULT_DREAM_CONFIG: DreamConfig = {
  intervalMs: 86_400_000, // 24 hours
  minLearningsForDream: 5,
  skillConfidenceThreshold: 0.3,
  maxSkillsPerType: 10,
  enabled: true,
};

// ---------------------------------------------------------------------------
// Dream Report
// ---------------------------------------------------------------------------

export interface DreamReport {
  /** Unique report identifier */
  id: string;
  /** When the dreaming cycle ran */
  timestamp: Date;
  /** How long the cycle took in milliseconds */
  durationMs: number;
  /** Human-readable summary of this dreaming cycle */
  summary: string;
  /** All actions taken during this dreaming cycle */
  actions: DreamAction[];
  /** Aggregate metrics for this dreaming cycle */
  metrics: DreamMetrics;
}

// ---------------------------------------------------------------------------
// Dream Action
// ---------------------------------------------------------------------------

export interface DreamAction {
  /** Type of action taken */
  type:
    | 'skill_created'
    | 'skill_proposed'
    | 'skill_archived'
    | 'skill_adjusted'
    | 'insight_generated'
    | 'pattern_discovered';
  /** Short description of the action */
  description: string;
  /** Optional detailed information */
  detail?: string;
  /** Name of the skill affected (if applicable) */
  skillName?: string;
  /** Confidence level associated with this action */
  confidence?: number;
}

// ---------------------------------------------------------------------------
// Dream Metrics
// ---------------------------------------------------------------------------

export interface DreamMetrics {
  /** Total number of learnings reviewed */
  totalLearnings: number;
  /** Number of skills reviewed */
  skillsReviewed: number;
  /** Number of skills archived */
  skillsArchived: number;
  /** Number of new skills created */
  skillsCreated: number;
  /** Number of patterns discovered */
  patternsFound: number;
  /** Number of insights generated */
  insightsGenerated: number;
}

// ---------------------------------------------------------------------------
// Dream Pattern
// ---------------------------------------------------------------------------

export interface DreamPattern {
  /** Unique pattern identifier */
  id: string;
  /** Type of pattern discovered */
  type: 'recurring_win' | 'recurring_loss' | 'regime_shift' | 'timing_pattern' | 'general_pattern';
  /** Human-readable description of the pattern */
  description: string;
  /** Confidence in this pattern (0-1) */
  confidence: number;
  /** IDs of learnings that support this pattern */
  evidence: string[];
  /** Symbol the pattern applies to (optional) */
  symbol?: string;
  /** Timeframe the pattern applies to (optional) */
  timeframe?: string;
  /** Non-trading domain or task category for general-purpose patterns. */
  domain?: string;
}
