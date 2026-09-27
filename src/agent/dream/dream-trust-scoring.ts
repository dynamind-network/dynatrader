/**
 * Dream Cycle — Trust Scoring
 *
 * Tracks helpful/unhelpful feedback for strategies and knowledge.
   */

import type { TrustScoring, TrustLevel } from './dream-enhanced-types.js';
import { TRUST_WEIGHTS } from './dream-enhanced-types.js';
import { randomUUID } from 'crypto';

export interface TrustScoreEntry {
  id: string;
  targetId: string;
  targetType: 'strategy' | 'knowledge' | 'claim' | 'pattern';
  score: number;
  history: TrustScoring[];
  level: TrustLevel;
  createdAt: string;
  updatedAt: string;
}

export class TrustScoringSystem {
  private entries: Map<string, TrustScoreEntry> = new Map();

  recordFeedback(
    targetId: string,
    targetType: TrustScoreEntry['targetType'],
    helpful: boolean,
  ): TrustScoreEntry {
    let entry = this.entries.get(targetId);

    if (!entry) {
      entry = {
        id: randomUUID(),
        targetId,
        targetType,
        score: 0.5,
        history: [],
        level: 'observed',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.entries.set(targetId, entry);
    }

    const delta = helpful ? TRUST_WEIGHTS.helpful : TRUST_WEIGHTS.unhelpful;
    entry.score = Math.max(0, Math.min(1, entry.score + delta));
    entry.level = this.calculateLevel(entry.score);
    entry.updatedAt = new Date().toISOString();

    entry.history.push({
      targetId,
      helpful,
      timestamp: new Date().toISOString(),
    });

    return entry;
  }

  recordTradeOutcome(
    targetId: string,
    targetType: TrustScoreEntry['targetType'],
    profitable: boolean,
  ): TrustScoreEntry {
    let entry = this.entries.get(targetId);

    if (!entry) {
      entry = {
        id: randomUUID(),
        targetId,
        targetType,
        score: 0.5,
        history: [],
        level: 'observed',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.entries.set(targetId, entry);
    }

    const delta = profitable ? TRUST_WEIGHTS.verifiedTrade : TRUST_WEIGHTS.failedTrade;
    entry.score = Math.max(0, Math.min(1, entry.score + delta));
    entry.level = this.calculateLevel(entry.score);
    entry.updatedAt = new Date().toISOString();

    return entry;
  }

  getTrustScore(targetId: string): TrustScoreEntry | null {
    return this.entries.get(targetId) || null;
  }

  getTrustLevel(targetId: string): TrustLevel {
    const entry = this.entries.get(targetId);
    return entry?.level || 'untrusted';
  }

  isTrusted(targetId: string, minScore: number = 0.6): boolean {
    const entry = this.entries.get(targetId);
    return entry ? entry.score >= minScore : false;
  }

  private calculateLevel(score: number): TrustLevel {
    if (score >= 0.8) return 'verified';
    if (score >= 0.5) return 'observed';
    if (score >= 0.2) return 'untrusted';
    return 'system';
  }

  getAll(): TrustScoreEntry[] {
    return Array.from(this.entries.values());
  }

  getTopStrategies(limit: number = 10): TrustScoreEntry[] {
    return this.getAll()
      .filter(e => e.targetType === 'strategy')
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
