import { describe, expect, it } from 'vitest';
import { buildQueuedMessagePreviewLines } from './ChatStatusBanner.js';

describe('ChatStatusBanner', () => {
  it('caps the queue preview and summarizes overflow', () => {
    const lines = buildQueuedMessagePreviewLines([
      'first queued message that is intentionally a bit too long to fit nicely',
      'second queued message',
      'third queued message',
      'fourth queued message',
    ]);

    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^1\. first queued message/);
    expect(lines[0]).toContain('…');
    expect(lines[1]).toBe('2. second queued message');
    expect(lines[2]).toBe('+2 more');
  });
});

