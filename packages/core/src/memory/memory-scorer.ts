import type { MemoryEvent, SearchQuery } from "./core/memory-store";

export interface MemoryScoreBreakdown {
  relevance: number;
  frequency: number;
  queryDiversity: number;
  recency: number;
  consolidationCount: number;
  conceptualRichness: number;
  total: number;
}

export class MemoryScorer {
  score(event: MemoryEvent, query: SearchQuery = {}): MemoryScoreBreakdown {
    const metadata = event.metadata ?? {};
    const now = Date.now();
    const ageInDays = Math.max(0, (now - event.timestamp.getTime()) / (1000 * 60 * 60 * 24));
    const recency = Math.max(0, 1 - ageInDays / 30);

    const frequency = typeof metadata.frequency === "number" ? metadata.frequency : 1;
    const consolidationCount = typeof metadata.consolidationCount === "number" ? metadata.consolidationCount : 0;
    const accessCount = typeof metadata.accessCount === "number" ? metadata.accessCount : 1;
    const richness = typeof metadata.conceptualRichness === "number" ? metadata.conceptualRichness : 0.5;
    const diversity = typeof metadata.queryDiversity === "number" ? metadata.queryDiversity : 0.5;

    let relevance = 0.35;
    if (query.kind && event.kind === query.kind) relevance += 0.25;
    if (query.scope && event.scope === query.scope) relevance += 0.15;
    if (query.text) {
      const needle = query.text.toLowerCase();
      const searchable = `${event.kind} ${JSON.stringify(event.payload)}`.toLowerCase();
      if (searchable.includes(needle)) {
        relevance += 0.25;
      }
    }

    const total =
      relevance * 0.30 +
      Math.min(1, Math.log2(frequency + 1) / 4) * 0.24 +
      Math.min(1, diversity) * 0.15 +
      recency * 0.15 +
      Math.min(1, consolidationCount / 10) * 0.10 +
      Math.min(1, richness) * 0.06 +
      Math.min(1, Math.log2(accessCount + 1) / 5) * 0.05;

    return {
      relevance,
      frequency,
      queryDiversity: diversity,
      recency,
      consolidationCount,
      conceptualRichness: richness,
      total,
    };
  }

  shouldArchive(event: MemoryEvent, query: SearchQuery = {}): boolean {
    const score = this.score(event, query);
    const ageInDays = Math.max(0, (Date.now() - event.timestamp.getTime()) / (1000 * 60 * 60 * 24));
    const metadata = event.metadata ?? {};
    const lowSignal =
      (typeof metadata.frequency === "number" ? metadata.frequency : 1) <= 1 &&
      (typeof metadata.consolidationCount === "number" ? metadata.consolidationCount : 0) === 0 &&
      (typeof metadata.accessCount === "number" ? metadata.accessCount : 1) <= 1;
    return ageInDays > 30 && (score.total < 0.2 || lowSignal);
  }

  isNearDuplicate(a: MemoryEvent, b: MemoryEvent): boolean {
    if (a.scope !== b.scope || a.kind !== b.kind) {
      return false;
    }

    const left = this.tokenSet(JSON.stringify(a.payload));
    const right = this.tokenSet(JSON.stringify(b.payload));
    if (left.size === 0 || right.size === 0) {
      return false;
    }

    let intersection = 0;
    for (const token of left) {
      if (right.has(token)) intersection++;
    }

    const union = new Set([...left, ...right]).size;
    return union > 0 && intersection / union >= 0.95;
  }

  // -----------------------------------------------------------------------
  // Shared scoring primitives (used by dream scorer and context compaction)
  // -----------------------------------------------------------------------

  /**
   * Score recency: 1.0 = just now, 0.0 = maxAgeMs ago.
   */
  static scoreAge(timestampMs: number, maxAgeMs: number): number {
    const ageMs = Date.now() - timestampMs;
    return Math.max(0, 1 - ageMs / maxAgeMs);
  }

  /**
   * Score metadata richness: 0.0 = empty, 1.0 = 5+ keys.
   */
  static scoreMetadataRichness(metadata: Record<string, unknown>): number {
    return Math.min(1, Object.keys(metadata).length / 5);
  }

  /**
   * Score content importance based on keyword signals.
   * Returns 0-1 where higher = more important.
   */
  static scoreContentImportance(content: string): number {
    const lower = content.toLowerCase();
    let score = 0.5;

    if (lower.includes('error') || lower.includes('failed')) score += 0.2;
    if (lower.includes('decision') || lower.includes('strategy')) score += 0.15;
    if (lower.includes('risk') || lower.includes('warning')) score += 0.1;
    if (lower.includes('learned') || lower.includes('insight')) score += 0.15;
    if (lower.includes('important') || lower.includes('critical')) score += 0.1;

    if (lower.includes('debug') || lower.includes('trace')) score -= 0.1;
    if (content.length < 50) score -= 0.1;

    return Math.max(0, Math.min(1, score));
  }

  private tokenSet(value: string): Set<string> {
    const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const tokens = normalized.split(/\s+/).filter(Boolean);
    return new Set(tokens.length > 0 ? tokens : [normalized]);
  }
}

export const memoryScorer = new MemoryScorer();
