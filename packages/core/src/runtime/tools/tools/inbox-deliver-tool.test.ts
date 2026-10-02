import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InboxDeliverTool } from './inbox-deliver-tool';

describe('InboxDeliverTool', () => {
  it('persists an entry and emits the delivery callback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dyna-inbox-tool-'));
    try {
      const onDelivered = vi.fn();
      const tool = new InboxDeliverTool({ workspacePath: dir, onDelivered });
      const result = await tool.execute({ tool: 'inbox_deliver', args: { title: 'Report', body: 'Done', source: 'cron' } });
      expect(result.success).toBe(true);
      expect(onDelivered).toHaveBeenCalledWith(expect.objectContaining({ title: 'Report', source: 'cron' }));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
