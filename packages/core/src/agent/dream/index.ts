/**
 * Dream Cycle — barrel exports
 *
 * Periodic background reflection/consolidation system.
 */

export { DreamEngine } from './dream-engine';
export { DreamScheduler } from './dream-scheduler';
export {
  DEFAULT_DREAM_CONFIG,
} from './dream-types';

export type {
  DreamConfig,
  DreamReport,
  DreamAction,
  DreamMetrics,
  DreamPattern,
} from './dream-types';
