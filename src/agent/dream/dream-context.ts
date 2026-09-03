/**
 * Dream Cycle — Shared Context
 *
 * Common context object passed to all extracted dream modules,
 * avoiding the need to thread individual dependencies everywhere.
 */

import { Logger } from '../../orchestration/workspace/logger';

import type { MemoryStoreImpl } from '@dyna/memory-core';
import type { SkillFactory, CrossSessionRecall } from '@dyna/agent-core';

import type { DreamConfig } from './dream-types';
import type { TrustScoringSystem } from './dream-trust-scoring';
import type { TwoLayerKnowledge } from './dream-two-layer';
import type { ShortTermRecallStore } from './dream-short-term-recall';
import type { DriftDetector } from './dream-drift-detection';
import type { MemoryConsolidation } from '../core/memory-consolidation';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DREAM_SCOPE = 'dream';
export const LEARNING_SCOPE = 'learning_engine';
export const AGENT_MEMORY_SCOPE = 'agent_memory';
export const SEARCH_TOP_K = 500;
export const MIN_PATTERN_EVIDENCE = 3;
export const WIN_RATE_THRESHOLD_HIGH = 0.6;
export const WIN_RATE_THRESHOLD_LOW = 0.35;
export const PATTERN_CONFIDENCE_BASE = 0.5;

// ---------------------------------------------------------------------------
// Shared Context
// ---------------------------------------------------------------------------

export interface DreamContext {
  memoryStore: MemoryStoreImpl;
  skillFactory: SkillFactory;
  crossSessionRecall: CrossSessionRecall;
  config: DreamConfig;
  logger: Logger;
  trustScoring?: TrustScoringSystem;
  twoLayerKnowledge?: TwoLayerKnowledge;
  /** Short-term recall store for dreaming candidates */
  shortTermRecall?: ShortTermRecallStore;
  /** Drift detector for round-trip mismatch checks (Hermes pattern) */
  driftDetector?: DriftDetector;
  /** Memory consolidation — geometry-aware clustering of memories */
  memoryConsolidation?: MemoryConsolidation;
}
