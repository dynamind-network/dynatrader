/**
 * Dream Cycle — Contradiction Detection
 *
 * Detects conflicting claims across knowledge entries.
 * Adapted from Holographic's algebraic contradiction pattern.
 */

import type { Claim, Contradiction } from './dream-enhanced-types.js';

export interface ContradictionDetectorConfig {
  enabled: boolean;
  entityKey: string;
  predicateKey: string;
  valueKey: string;
}

const DEFAULT_CONFIG: ContradictionDetectorConfig = {
  enabled: true,
  entityKey: 'symbol',
  predicateKey: 'kind',
  valueKey: 'content',
};

export function detectContradictions(
  claims: Claim[],
  config: ContradictionDetectorConfig = DEFAULT_CONFIG,
): Contradiction[] {
  if (!config.enabled || claims.length < 2) return [];

  const contradictions: Contradiction[] = [];
  const activeClaims = claims.filter(c => c.status === 'active');

  for (let i = 0; i < activeClaims.length; i++) {
    for (let j = i + 1; j < activeClaims.length; j++) {
      const c1 = activeClaims[i];
      const c2 = activeClaims[j];

      const contradiction = checkContradiction(c1, c2, config);
      if (contradiction) {
        contradictions.push(contradiction);
      }
    }
  }

  return contradictions;
}

function checkContradiction(
  c1: Claim,
  c2: Claim,
  config: ContradictionDetectorConfig,
): Contradiction | null {
  const text1 = c1.text.toLowerCase();
  const text2 = c2.text.toLowerCase();

  const hasOppositeSentiment = checkOppositeSentiment(text1, text2);
  if (hasOppositeSentiment) {
    return {
      claimId1: c1.id,
      claimId2: c2.id,
      type: 'direct',
      description: `Conflicting claims: "${c1.text}" vs "${c2.text}"`,
      detectedAt: new Date().toISOString(),
      resolved: false,
    };
  }

  const hasTemporalConflict = checkTemporalConflict(c1, c2);
  if (hasTemporalConflict) {
    return {
      claimId1: c1.id,
      claimId2: c2.id,
      type: 'temporal',
      description: `Temporal conflict: older claim contradicts newer evidence`,
      detectedAt: new Date().toISOString(),
      resolved: false,
    };
  }

  return null;
}

function checkOppositeSentiment(text1: string, text2: string): boolean {
  const bullishTerms = ['bullish', 'positive', 'increase', 'gain', 'profit', 'up', 'rise'];
  const bearishTerms = ['bearish', 'negative', 'decrease', 'loss', 'down', 'fall', 'drop'];

  const hasBullish1 = bullishTerms.some(t => text1.includes(t));
  const hasBearish1 = bearishTerms.some(t => text1.includes(t));
  const hasBullish2 = bullishTerms.some(t => text2.includes(t));
  const hasBearish2 = bearishTerms.some(t => text2.includes(t));

  return (hasBullish1 && hasBearish2) || (hasBearish1 && hasBullish2);
}

function checkTemporalConflict(c1: Claim, c2: Claim): boolean {
  const d1 = new Date(c1.updatedAt);
  const d2 = new Date(c2.updatedAt);
  const daysDiff = Math.abs(d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24);

  if (daysDiff < 7 && c1.confidence > 0.7 && c2.confidence > 0.7) {
    const text1 = c1.text.toLowerCase();
    const text2 = c2.text.toLowerCase();

    if (text1.includes('will') && text2.includes('will not')) return true;
    if (text1.includes('will not') && text2.includes('will')) return true;
  }

  return false;
}
