import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Inbox } from './inbox';

describe('Inbox', () => {
  it('delivers, reads, marks read, and clears entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dyna-inbox-'));
    try {
      const inbox = new Inbox(dir);
      const entry = await inbox.deliver({ title: 'Backtest report', body: 'Results', source: 'cron', metadata: { symbol: 'BTC/USDT' } });
      expect((await inbox.list('unread'))).toHaveLength(1);
      expect((await inbox.read(entry.id))?.status).toBe('read');
      expect((await inbox.list('unread'))).toHaveLength(0);
      expect(await inbox.clear()).toBe(1);
      expect(await inbox.list()).toHaveLength(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
