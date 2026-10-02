import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionManager } from './context-manager.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('SessionManager.searchUserPrompts', () => {
  it('searches saved user messages case-insensitively and returns recent sessions first', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dynatrader-prompt-search-'));
    tempDirs.push(directory);
    const sessions = new SessionManager(directory);
    await sessions.saveSession('older', {
      messages: [{ role: 'user', content: 'Plan an ETF portfolio' }],
      metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
    });
    await sessions.saveSession('newer', {
      messages: [
        { role: 'assistant', content: 'ETF risk is moderate' },
        { role: 'user', content: 'Review my ETF allocation' },
      ],
      metadata: { createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-02T00:00:00.000Z' },
    });

    const results = await sessions.searchUserPrompts('eTf');
    expect(results.map(({ sessionId }) => sessionId)).toEqual(['newer', 'older']);
    expect(results.map(({ prompt }) => prompt)).toEqual(['Review my ETF allocation', 'Plan an ETF portfolio']);
  });

  it('returns no entries for a blank query', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dynatrader-prompt-search-'));
    tempDirs.push(directory);
    expect(await new SessionManager(directory).searchUserPrompts('   ')).toEqual([]);
  });
});
