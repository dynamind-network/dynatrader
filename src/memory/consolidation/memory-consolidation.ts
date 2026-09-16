/** Unified durable-memory deduplication and consolidation. */

import type { MemoryStoreBackend, MemoryStoreImpl, MemoryEvent } from '@dyna/memory-core';
import type { ModelRouter } from '@dyna/contracts';
import { MemoryScorer } from '../memory-scorer';

export type DreamPhase = 'light' | 'deep' | 'rem';

export interface ConsolidationConfig {
  minClusterSize: number;
  similarityThreshold: number;
  maxClusters: number;
  maxPerCycle: number;
  cooldownMs: number;
  minAgeMs: number;
  allowedScopes: string[];
}

export interface MemoryCluster {
  id: string;
  memories: MemoryEvent[];
  centroid: string;
  avgAge: number;
  avgScore: number;
  themes: string[];
}

export interface ConsolidationResult {
  clustersFound: number;
  memoriesConsolidated: number;
  summariesGenerated: number;
  duplicatesMerged: number;
  archivedRecords: number;
  skippedClusters: number;
  errors: string[];
  insightsExtracted: string[];
  timestamp: Date;
}

export interface DreamConsolidationResult extends ConsolidationResult {
  phase: DreamPhase;
  candidatesConsidered: number;
  memoriesPruned: number;
  themesExtracted: string[];
  durationMs: number;
}

export const DEFAULT_CONSOLIDATION_CONFIG: ConsolidationConfig = {
  minClusterSize: 2,
  similarityThreshold: 0.72,
  maxClusters: 10,
  maxPerCycle: 200,
  cooldownMs: 60 * 60 * 1000,
  minAgeMs: 0,
  allowedScopes: ['agent_memory', 'memory_writer', 'decision_journal', 'memory_fabric'],
};

const ARCHIVE_KIND_SUFFIX = ':archived';
const SYNTHESIS_SCOPE = 'memory_consolidation';

function emptyResult(timestamp = new Date()): ConsolidationResult {
  return { clustersFound: 0, memoriesConsolidated: 0, summariesGenerated: 0, duplicatesMerged: 0, archivedRecords: 0, skippedClusters: 0, errors: [], insightsExtracted: [], timestamp };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableNormalize);
  if (!isRecord(value)) return typeof value === 'string' ? value.trim().toLowerCase() : value;
  const volatile = new Set(['id', 'timestamp', 'createdat', 'updatedat', 'archivedat', 'lastaccessedat', 'lastmergedat', 'accesscount', 'frequency', 'consolidationcount']);
  return Object.fromEntries(Object.keys(value).filter((key) => !volatile.has(key.toLowerCase())).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())).map((key) => [key.toLowerCase(), stableNormalize(value[key])]));
}

function normalizedPayload(event: MemoryEvent): string {
  return JSON.stringify({ scope: event.scope, kind: event.kind, payload: stableNormalize(event.payload) });
}

export class MemoryConsolidation {
  private readonly backend: MemoryStoreBackend;
  private readonly modelRouter?: ModelRouter;
  private readonly scorer = new MemoryScorer();
  private readonly config: ConsolidationConfig;
  private lastConsolidationTime = 0;
  private running = false;

  constructor(memory: MemoryStoreImpl | MemoryStoreBackend, config: Partial<ConsolidationConfig> = {}, modelRouter?: ModelRouter) {
    this.backend = 'getBackend' in memory ? memory.getBackend() : memory;
    this.modelRouter = modelRouter;
    this.config = { ...DEFAULT_CONSOLIDATION_CONFIG, ...config };
  }

  shouldRun(): boolean {
    return !this.running && Date.now() - this.lastConsolidationTime >= this.config.cooldownMs;
  }

  async consolidate(force = false): Promise<ConsolidationResult> {
    if (this.running || (!force && !this.shouldRun())) return emptyResult();
    this.running = true;
    this.lastConsolidationTime = Date.now();
    try {
      const memories = await this.loadCandidates();
      const result = emptyResult();

      for (const group of this.groupExactDuplicates(memories)) {
        if (group.length < 2) continue;
        const canonical = this.chooseCanonical(group);
        for (const duplicate of group) {
          if (duplicate.id === canonical.id) continue;
          await this.archiveDuplicate(canonical, duplicate, 'exact_duplicate');
          result.duplicatesMerged++;
          result.archivedRecords++;
        }
      }

      const clusters = this.clusterMemories(memories).slice(0, this.config.maxClusters);
      result.clustersFound = clusters.length;
      for (const cluster of clusters) {
        if (cluster.memories.length < this.config.minClusterSize || !this.modelRouter) {
          if (!this.modelRouter) result.skippedClusters++;
          continue;
        }
        try {
          const synthesis = await this.synthesize(cluster);
          if (!synthesis) {
            result.skippedClusters++;
            continue;
          }
          const canonical = this.chooseCanonical(cluster.memories);
          const summary = await this.writeSynthesis(cluster, canonical, synthesis);
          result.summariesGenerated++;
          result.memoriesConsolidated += cluster.memories.length;
          for (const source of cluster.memories) {
            if (source.id !== canonical.id) {
              await this.archiveDuplicate(canonical, source, 'semantic_consolidation', cluster.id, summary.id);
              result.archivedRecords++;
            }
          }
        } catch (error) {
          result.skippedClusters++;
          result.errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      result.insightsExtracted = clusters.map((cluster) => cluster.themes.slice(0, 3).join(', ')).filter(Boolean);
      return result;
    } finally {
      this.running = false;
    }
  }

  /** Compatibility API used by DreamEngine. */
  async runCycle(phase: DreamPhase = 'light'): Promise<DreamConsolidationResult> {
    const started = Date.now();
    const candidates = await this.loadCandidates();
    const result = phase === 'light' ? await this.consolidate() : await this.consolidate(true);
    return { ...result, phase, candidatesConsidered: candidates.length, memoriesPruned: result.archivedRecords, themesExtracted: result.insightsExtracted, durationMs: Date.now() - started };
  }

  async runPhase(phase: DreamPhase): Promise<DreamConsolidationResult> {
    return this.runCycle(phase);
  }

  private async loadCandidates(): Promise<MemoryEvent[]> {
    const cutoff = Date.now() - this.config.minAgeMs;
    const events: MemoryEvent[] = [];
    for (const scope of this.config.allowedScopes) {
      const results = await this.backend.search({ scope, limit: this.config.maxPerCycle });
      const archivedIds = new Set<string>();
      for (const result of results) {
        if (isRecord(result.payload) && typeof result.payload.originalId === 'string') {
          archivedIds.add(result.payload.originalId);
        }
      }
      for (const result of results) {
        const event = await this.backend.get(result.id);
        if (event && event.timestamp.getTime() <= cutoff && !this.isArchived(event) && !archivedIds.has(event.id)) events.push(event);
      }
    }
    return events;
  }

  private isArchived(event: MemoryEvent): boolean {
    return event.kind.endsWith(ARCHIVE_KIND_SUFFIX) || (isRecord(event.payload) && event.payload.archived === true);
  }

  private groupExactDuplicates(memories: MemoryEvent[]): MemoryEvent[][] {
    const groups = new Map<string, MemoryEvent[]>();
    for (const memory of memories) groups.set(normalizedPayload(memory), [...(groups.get(normalizedPayload(memory)) ?? []), memory]);
    return [...groups.values()];
  }

  private chooseCanonical(memories: MemoryEvent[]): MemoryEvent {
    return [...memories].sort((a, b) => this.scorer.score(b).total - this.scorer.score(a).total || b.timestamp.getTime() - a.timestamp.getTime())[0]!;
  }

  private clusterMemories(memories: MemoryEvent[]): MemoryCluster[] {
    const clusters: MemoryCluster[] = [];
    const used = new Set<string>();
    for (const memory of memories) {
      if (used.has(memory.id)) continue;
      const cluster = [memory];
      used.add(memory.id);
      for (const other of memories) {
        if (used.has(other.id) || other.scope !== memory.scope || other.kind !== memory.kind) continue;
        if (this.similarity(memory, other) >= this.config.similarityThreshold) {
          cluster.push(other);
          used.add(other.id);
        }
      }
      if (cluster.length >= this.config.minClusterSize) clusters.push({ id: `cluster-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, memories: cluster, centroid: this.extractText(cluster[0]!), avgAge: cluster.reduce((sum, item) => sum + item.timestamp.getTime(), 0) / cluster.length, avgScore: cluster.reduce((sum, item) => sum + this.scorer.score(item).total, 0) / cluster.length, themes: this.extractThemes(cluster) });
    }
    return clusters.sort((a, b) => b.memories.length - a.memories.length);
  }

  private similarity(a: MemoryEvent, b: MemoryEvent): number {
    const left = new Set(this.extractText(a).toLowerCase().split(/\W+/).filter((word) => word.length > 3));
    const right = new Set(this.extractText(b).toLowerCase().split(/\W+/).filter((word) => word.length > 3));
    const union = new Set([...left, ...right]);
    return union.size ? [...left].filter((word) => right.has(word)).length / union.size : 0;
  }

  private extractText(memory: MemoryEvent): string {
    const payload = isRecord(memory.payload) ? memory.payload : { payload: memory.payload };
    const fields = ['text', 'content', 'description', 'summary'].filter((field) => typeof payload[field] === 'string').map((field) => String(payload[field]));
    return [memory.scope, memory.kind, ...(fields.length ? fields : [JSON.stringify(stableNormalize(payload))])].join(' ');
  }

  private extractThemes(memories: MemoryEvent[]): string[] {
    const counts = new Map<string, number>();
    for (const memory of memories) for (const word of this.extractText(memory).toLowerCase().split(/\W+/).filter((item) => item.length > 4)) counts.set(word, (counts.get(word) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([word]) => word);
  }

  private async synthesize(cluster: MemoryCluster): Promise<Record<string, unknown> | null> {
    const response = await this.modelRouter!.call({
      messages: [
        { role: 'system', content: 'Consolidate durable memories. Return JSON only: {"summary": string, "keyFacts": string[], "confidence": number}. Do not invent facts.' },
        { role: 'user', content: JSON.stringify({ clusterId: cluster.id, memories: cluster.memories.map((memory) => ({ id: memory.id, scope: memory.scope, kind: memory.kind, payload: memory.payload })) }) },
      ], maxTokens: 800, temperature: 0,
    }, 'memory-consolidation');
    const content = response.content.trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '');
    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed) || typeof parsed.summary !== 'string' || !Array.isArray(parsed.keyFacts) || typeof parsed.confidence !== 'number') return null;
    if (!parsed.keyFacts.every((fact) => typeof fact === 'string') || parsed.confidence < 0 || parsed.confidence > 1) return null;
    return parsed;
  }

  private async writeSynthesis(cluster: MemoryCluster, canonical: MemoryEvent, synthesis: Record<string, unknown>): Promise<MemoryEvent> {
    const summary: MemoryEvent = { id: `consolidated-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, scope: SYNTHESIS_SCOPE, kind: 'cluster_summary', payload: { clusterId: cluster.id, sourceIds: cluster.memories.map((memory) => memory.id), canonicalId: canonical.id, sourceScope: canonical.scope, sourceKind: canonical.kind, ...synthesis, themes: cluster.themes, createdAt: new Date().toISOString() }, timestamp: new Date(), metadata: { addedBy: 'memory_consolidation', source: 'model_router', confidence: synthesis.confidence } };
    await this.backend.put(summary);
    return summary;
  }

  private async archiveDuplicate(canonical: MemoryEvent, duplicate: MemoryEvent, reason: string, clusterId?: string, summaryId?: string): Promise<void> {
    await this.backend.put({ ...duplicate, id: `archive-${duplicate.id}-${Date.now()}`, kind: `${duplicate.kind}${ARCHIVE_KIND_SUFFIX}`, payload: { originalId: duplicate.id, keptId: canonical.id, clusterId, summaryId, archivedReason: reason, archivedAt: new Date().toISOString(), originalPayload: duplicate.payload }, timestamp: new Date(), metadata: { ...(duplicate.metadata ?? {}), archived: true, archivedReason: reason, keptId: canonical.id } });
  }
}
