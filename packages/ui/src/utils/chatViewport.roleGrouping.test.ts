import { describe, it, expect } from 'vitest';
import { messagesToDisplayLines } from './chatViewport.js';

describe('messagesToDisplayLines - role grouping', () => {
  const makeMsg = (content: string, role: string, hidden = false) => ({
    content,
    role,
    timestamp: new Date(),
    hidden,
  });

  it('inserts role indicator line for 3+ consecutive same-role messages', () => {
    const msgs = [
      makeMsg('user1', 'user'),
      makeMsg('user2', 'user'),
      makeMsg('user3', 'user'),
      makeMsg('assistant1', 'assistant'),
    ];
    const lines = messagesToDisplayLines(msgs, 80, true);
    const lineTexts = lines.map((l) => l.text);
    // Should have a role indicator line before the user group
    expect(lineTexts).toContain('\u2500\u2500 User \u2500\u2500');
  });

  it('does not insert indicator for pairs or singles', () => {
    const msgs = [
      makeMsg('user1', 'user'),
      makeMsg('user2', 'user'),
      makeMsg('assistant1', 'assistant'),
    ];
    const lines = messagesToDisplayLines(msgs, 80, true);
    const lineTexts = lines.map((l) => l.text);
    expect(lineTexts).not.toContain('\u2500\u2500 User \u2500\u2500');
    expect(lineTexts).not.toContain('\u2500\u2500 Assistant \u2500\u2500');
  });

  it('handles multiple groups independently', () => {
    const msgs = [
      makeMsg('user1', 'user'),
      makeMsg('user2', 'user'),
      makeMsg('user3', 'user'),
      makeMsg('asst1', 'assistant'),
      makeMsg('asst2', 'assistant'),
      makeMsg('asst3', 'assistant'),
    ];
    const lines = messagesToDisplayLines(msgs, 80, true);
    const lineTexts = lines.map((l) => l.text);
    expect(lineTexts).toContain('\u2500\u2500 User \u2500\u2500');
    expect(lineTexts).toContain('\u2500\u2500 Assistant \u2500\u2500');
  });

  it('skips hidden messages in group detection', () => {
    const msgs = [
      makeMsg('user1', 'user'),
      makeMsg('hidden1', 'user', true),
      makeMsg('user2', 'user'),
      makeMsg('user3', 'user'),
    ];
    const lines = messagesToDisplayLines(msgs, 80, true);
    const lineTexts = lines.map((l) => l.text);
    // Only 3 non-hidden user messages, so should show indicator
    expect(lineTexts).toContain('\u2500\u2500 User \u2500\u2500');
  });

  it('does not show indicator when hidden messages break the group', () => {
    const msgs = [
      makeMsg('user1', 'user'),
      makeMsg('hidden1', 'user', true),
      makeMsg('hidden2', 'user', true),
      makeMsg('user2', 'user'),
      makeMsg('assistant1', 'assistant'),
    ];
    const lines = messagesToDisplayLines(msgs, 80, true);
    const lineTexts = lines.map((l) => l.text);
    // Only 2 non-hidden user messages, no indicator
    expect(lineTexts).not.toContain('\u2500\u2500 User \u2500\u2500');
  });

  it('capitalizes role names correctly', () => {
    const msgs = [makeMsg('sys1', 'system'), makeMsg('sys2', 'system'), makeMsg('sys3', 'system')];
    const lines = messagesToDisplayLines(msgs, 80, true);
    const lineTexts = lines.map((l) => l.text);
    expect(lineTexts).toContain('\u2500\u2500 System \u2500\u2500');
  });

  it('defaults role to system when role is undefined', () => {
    const msgs = [
      { content: 'msg1', timestamp: new Date() },
      { content: 'msg2', timestamp: new Date() },
      { content: 'msg3', timestamp: new Date() },
    ] as any[];
    const lines = messagesToDisplayLines(msgs, 80, true);
    const lineTexts = lines.map((l) => l.text);
    expect(lineTexts).toContain('\u2500\u2500 System \u2500\u2500');
  });

  it('role indicator line has dim styling', () => {
    const msgs = [makeMsg('user1', 'user'), makeMsg('user2', 'user'), makeMsg('user3', 'user')];
    const lines = messagesToDisplayLines(msgs, 80, true);
    const indicatorLine = lines.find((l) => l.text.includes('User'));
    expect(indicatorLine).toBeDefined();
    expect(indicatorLine!.dim).toBe(true);
    expect(indicatorLine!.color).toBe('gray');
  });

  it('exactly 3 messages in a group shows indicator', () => {
    const msgs = [
      makeMsg('a', 'tool'),
      makeMsg('b', 'tool'),
      makeMsg('c', 'tool'),
      makeMsg('d', 'user'),
    ];
    const lines = messagesToDisplayLines(msgs, 80, true);
    const lineTexts = lines.map((l) => l.text);
    expect(lineTexts).not.toContain('\u2500\u2500 Tool \u2500\u2500');
    expect(lineTexts.slice(0, 3)).toEqual(['● A', '● B', '● C']);
  });

  it('4+ messages in a group still only shows one indicator', () => {
    const msgs = [
      makeMsg('a', 'assistant'),
      makeMsg('b', 'assistant'),
      makeMsg('c', 'assistant'),
      makeMsg('d', 'assistant'),
      makeMsg('e', 'assistant'),
    ];
    const lines = messagesToDisplayLines(msgs, 80, true);
    const indicatorCount = lines.filter((l) => l.text.includes('Assistant')).length;
    expect(indicatorCount).toBe(1);
  });
});

