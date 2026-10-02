import { describe, expect, it } from 'vitest';
import { createQueuedPrompt, updateQueueForSession } from './useUIState.js';

describe('session message queues', () => {
  it('updates and clears one session without changing another session queue', () => {
    const first = createQueuedPrompt('finish this turn', 'session-a');
    const second = createQueuedPrompt('follow up', 'session-a');
    const other = createQueuedPrompt('keep this draft', 'session-b');
    const queues = { 'session-a': [first, second], 'session-b': [other] };

    const updated = updateQueueForSession(queues, 'session-a', (items) => items.slice(1));
    expect(updated['session-a']).toEqual([second]);
    expect(updated['session-b']).toEqual([other]);

    const cleared = updateQueueForSession(updated, 'session-a', []);
    expect(cleared).toEqual({ 'session-b': [other] });
  });
});
