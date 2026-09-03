import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrackedEntityStore } from './tracked-entity';

describe('TrackedEntityStore', () => {
  it('extracts wikilinks and traverses the entity graph', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dyna-tracked-'));
    try {
      const store = new TrackedEntityStore(dir);
      await store.add('sector:tech', { kind: 'sector' });
      await store.add('TSLA', { kind: 'asset', body: 'Exposure to [[sector:tech]].' });
      await store.link('TSLA', 'sector:tech');
      const graph = await store.graph();
      expect(graph.nodes).toHaveLength(2);
      expect(graph.edges).toContainEqual({ source: 'TSLA', target: 'sector:tech' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
