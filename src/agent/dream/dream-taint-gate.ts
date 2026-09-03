/**
 * Dream Cycle — Taint Gating
 *
 * Filters candidates by trust level before promotion.
 * Only verified/trusted entries can promote to durable knowledge.
 */

import type {
  TrustableEntry,
  TaintGateConfig,
  TrustLevel,
} from './dream-enhanced-types.js';
import { DEFAULT_TAINT_GATE_CONFIG } from './dream-enhanced-types.js';

const TRUST_HIERARCHY: Record<TrustLevel, number> = {
  system: 0,
  untrusted: 1,
  observed: 2,
  verified: 3,
};

export function isTaintGated(
  entry: TrustableEntry,
  config: TaintGateConfig = DEFAULT_TAINT_GATE_CONFIG,
): boolean {
  const entryLevel = TRUST_HIERARCHY[entry.trustLevel] ?? 0;
  const minLevel = TRUST_HIERARCHY[config.minTrustLevel] ?? 0;

  if (entryLevel < minLevel) return true;
  if (entry.trustScore < config.minTrustScore) return true;

  return false;
}

export function filterTaintGated(
  entries: TrustableEntry[],
  config: TaintGateConfig = DEFAULT_TAINT_GATE_CONFIG,
): { accepted: TrustableEntry[]; rejected: TrustableEntry[] } {
  const accepted: TrustableEntry[] = [];
  const rejected: TrustableEntry[] = [];

  for (const entry of entries) {
    if (isTaintGated(entry, config)) {
      rejected.push(entry);
    } else {
      accepted.push(entry);
    }
  }

  return { accepted, rejected };
}

export function updateTrustScore(
  currentScore: number,
  helpful: boolean,
  config: TaintGateConfig = DEFAULT_TAINT_GATE_CONFIG,
): number {
  const delta = helpful ? config.taintBoost : config.taintPenalty;
  return Math.max(0, Math.min(1, currentScore + delta));
}
