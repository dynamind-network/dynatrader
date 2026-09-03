import { describe, expect, it } from 'vitest';
import { filterCommandItems, scoreCommandItem, type CommandItem } from './CommandPalette.js';

const items: CommandItem[] = [
  {
    id: 'help',
    label: 'Run /help',
    description: 'Show command reference',
    group: 'command',
    action: () => {},
  },
  {
    id: 'transcript',
    label: 'Open Transcript',
    description: 'Inspect full history',
    group: 'session',
    action: () => {},
  },
  {
    id: 'chat',
    label: 'Open Chat',
    description: 'Main conversation',
    group: 'screen',
    action: () => {},
  },
  {
    id: 'agent',
    label: '@name',
    description: 'Delegate a task',
    group: 'agent',
    action: () => {},
  },
];

describe('CommandPalette helpers', () => {
  it('scores direct matches above fuzzy matches', () => {
    expect(scoreCommandItem(items[0], 'help')).toBeGreaterThan(scoreCommandItem(items[3], 'help'));
  });

  it('filters and prioritizes results by intent', () => {
    const filtered = filterCommandItems(items, 'transcript');
    expect(filtered[0]?.id).toBe('transcript');
    expect(filtered.some((item) => item.id === 'help')).toBe(false);
  });

  it('keeps grouped order when no query is present', () => {
    const filtered = filterCommandItems(items, '');
    expect(filtered.map((item) => item.group)).toEqual(['command', 'screen', 'session', 'agent']);
  });
});
