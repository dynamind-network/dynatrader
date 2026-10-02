import { describe, expect, it, vi } from 'vitest';
import { InMemoryStore } from '../core/memory-store';
import { MemoryConsolidation } from './memory-consolidation';

function event(id: string, payload: unknown, kind = 'observation', scope = 'agent_memory') {
  return { id, scope, kind, payload, timestamp: new Date(Date.now() - 60_000) };
}

describe('MemoryConsolidation', () => {
  it('deduplicates normalized exact records and archives sources idempotently', async () => {
    const backend = new InMemoryStore();
    await backend.put(event('one', { Content: 'BTC breakout', timestamp: 'a' }));
    await backend.put(event('two', { content: ' btc breakout ', timestamp: 'b' }));

    const consolidator = new MemoryConsolidation(backend, { cooldownMs: 0 });
    const first = await consolidator.consolidate();
    const second = await consolidator.consolidate(true);

    expect(first.duplicatesMerged).toBe(1);
    expect(first.archivedRecords).toBe(1);
    expect(second.duplicatesMerged).toBe(0);
    expect(second.archivedRecords).toBe(0);
    const active = await backend.search({ scope: 'agent_memory', limit: 20 });
    const archived = await backend.search({ scope: 'agent_memory', kind: 'observation:archived', limit: 20 });
    expect(active).toHaveLength(1);
    expect(archived).toHaveLength(1);
    expect((archived[0]?.payload as { originalId?: string }).originalId).not.toBe(active[0]!.id);
  });

  it('does not merge across scopes or kinds', async () => {
    const backend = new InMemoryStore();
    await backend.put(event('agent', { content: 'same market observation' }));
    await backend.put(event('writer', { content: 'same market observation' }, 'decision', 'memory_writer'));
    const consolidator = new MemoryConsolidation(backend, { cooldownMs: 0 });

    const result = await consolidator.consolidate();

    expect(result.duplicatesMerged).toBe(0);
    expect(result.archivedRecords).toBe(0);
  });

  it('uses the model router for semantic clusters and archives only after valid synthesis', async () => {
    const backend = new InMemoryStore();
    await backend.put(event('a', { content: 'BTC momentum breakout with rising volume' }));
    await backend.put(event('b', { content: 'BTC momentum breakout and volume expansion' }));
    const router = { call: vi.fn().mockResolvedValue({ content: JSON.stringify({ summary: 'BTC momentum breakout pattern', keyFacts: ['BTC momentum is recurring'], confidence: 0.91 }) }) } as any;
    const consolidator = new MemoryConsolidation(backend, { cooldownMs: 0, similarityThreshold: 0.5 }, router);

    const result = await consolidator.consolidate();
    const summaries = await backend.search({ scope: 'memory_consolidation', kind: 'cluster_summary', limit: 10 });

    expect(router.call).toHaveBeenCalledWith(expect.objectContaining({ temperature: 0 }), 'memory-consolidation');
    expect(result.summariesGenerated).toBe(1);
    expect(result.archivedRecords).toBe(1);
    expect(summaries).toHaveLength(1);
  });

  it('leaves semantic clusters untouched when synthesis is unavailable or invalid', async () => {
    const backend = new InMemoryStore();
    await backend.put(event('a', { content: 'risk warning for BTC leverage' }));
    await backend.put(event('b', { content: 'risk warning on BTC leverage exposure' }));
    const router = { call: vi.fn().mockResolvedValue({ content: '{not-json}' }) } as any;
    const consolidator = new MemoryConsolidation(backend, { cooldownMs: 0, similarityThreshold: 0.5 }, router);

    const result = await consolidator.consolidate();

    expect(result.summariesGenerated).toBe(0);
    expect(result.archivedRecords).toBe(0);
    expect(result.skippedClusters).toBe(1);
  });
});
