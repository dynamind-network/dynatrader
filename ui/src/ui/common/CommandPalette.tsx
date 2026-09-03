import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Box, Text } from 'ink';
import { useInput } from 'ink';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { COLORS, SPACING } from '../design/tokens.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommandItem {
  id: string;
  label: string;
  description?: string;
  shortcut?: string;
  group: 'command' | 'agent' | 'screen' | 'session' | 'symbol' | 'setting';
  action: () => void;
}

export const COMMAND_GROUP_ORDER: CommandItem['group'][] = [
  'command',
  'screen',
  'session',
  'agent',
  'symbol',
  'setting',
];

const MAX_RECENT = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9@/]+/g, ' ')
    .trim();
}

function isSubsequence(query: string, target: string): boolean {
  let index = 0;
  for (const char of target) {
    if (char === query[index]) {
      index++;
      if (index === query.length) {
        return true;
      }
    }
  }
  return query.length === 0;
}

/**
 * Return the set of character indices (in the original label) that match
 * the query as a case-insensitive substring.  Falls back to subsequence
 * matching when no contiguous substring match is found.
 */
function findMatchIndices(query: string, label: string): Set<number> {
  const q = query.toLowerCase().trim();
  if (!q) return new Set();

  const lower = label.toLowerCase();

  // Try contiguous substring match first
  const idx = lower.indexOf(q);
  if (idx !== -1) {
    const result = new Set<number>();
    for (let i = idx; i < idx + q.length; i++) {
      result.add(i);
    }
    return result;
  }

  // Fall back to subsequence matching
  const result = new Set<number>();
  let qi = 0;
  for (let i = 0; i < label.length; i++) {
    if (qi < q.length && lower[i] === q[qi]) {
      result.add(i);
      qi++;
    }
  }
  return result;
}

export function scoreCommandItem(item: CommandItem, query: string): number {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) {
    return 1;
  }

  const haystack = normalizeText([item.label, item.description ?? '', item.id].join(' '));
  if (!haystack) {
    return 0;
  }

  if (haystack === normalizedQuery) {
    return 1000;
  }
  if (haystack.startsWith(normalizedQuery)) {
    return 900;
  }
  if (haystack.includes(normalizedQuery)) {
    return 700;
  }
  if (normalizeText(item.label).startsWith(normalizedQuery)) {
    return 850;
  }
  if (normalizeText(item.description ?? '').includes(normalizedQuery)) {
    return 650;
  }
  if (isSubsequence(normalizedQuery, haystack)) {
    return 500;
  }

  return 0;
}

const CHROME_ROWS = 9; // +1 for the status line
const MIN_VISIBLE = 3;
const MAX_VISIBLE = 15;

export function calculateVisibleCount(rows: number): number {
  return Math.max(MIN_VISIBLE, Math.min(MAX_VISIBLE, rows - CHROME_ROWS));
}

export function buildMatchLabel(query: string, count: number): string {
  if (!query.trim()) return '';
  return `${count} match${count === 1 ? '' : 'es'}`;
}

export function filterCommandItems(items: CommandItem[], query: string): CommandItem[] {
  const ranked = items
    .map((item, index) => ({
      item,
      index,
      score: scoreCommandItem(item, query),
    }))
    .filter(({ score }) => score > 0 || !query.trim())
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      const groupDelta =
        COMMAND_GROUP_ORDER.indexOf(a.item.group) - COMMAND_GROUP_ORDER.indexOf(b.item.group);
      if (groupDelta !== 0) {
        return groupDelta;
      }

      return a.index - b.index;
    });

  return ranked.map(({ item }) => item);
}

export function groupCommandItems(items: CommandItem[]): Record<string, CommandItem[]> {
  const groups: Record<string, CommandItem[]> = {
    command: [],
    screen: [],
    session: [],
    agent: [],
    symbol: [],
    setting: [],
  };

  for (const item of items) {
    groups[item.group].push(item);
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Recent commands persistence (module-level store)
// ---------------------------------------------------------------------------

let _recentIds: string[] = [];

function loadRecentIds(): string[] {
  return [..._recentIds];
}

function saveRecentIds(ids: string[]): void {
  _recentIds = [...ids];
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/**
 * Renders a label with matched characters shown in bold.
 */
function HighlightLabel({
  label,
  query,
  color,
  bold,
}: {
  label: string;
  query: string;
  color: string;
  bold?: boolean;
}) {
  const matchIndices = useMemo(() => findMatchIndices(query, label), [query, label]);

  if (matchIndices.size === 0) {
    return (
      <Text color={color} bold={bold}>
        {label}
      </Text>
    );
  }

  // Build segments: unmatched (normal) and matched (bold)
  const segments: Array<{ text: string; matched: boolean }> = [];
  let current = '';
  let currentMatched = false;

  for (let i = 0; i < label.length; i++) {
    const isMatch = matchIndices.has(i);
    if (isMatch !== currentMatched && current.length > 0) {
      segments.push({ text: current, matched: currentMatched });
      current = '';
    }
    current += label[i];
    currentMatched = isMatch;
  }
  if (current.length > 0) {
    segments.push({ text: current, matched: currentMatched });
  }

  return (
    <Text color={color} bold={bold}>
      {segments.map((seg, i) => (
        <Text key={i} bold={seg.matched ? true : bold}>
          {seg.text}
        </Text>
      ))}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// CommandPalette component
// ---------------------------------------------------------------------------

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  items: CommandItem[];
  placeholder?: string;
}

export function CommandPalette({
  isOpen,
  onClose,
  items,
  placeholder = 'Type a command...',
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [recentIds, setRecentIds] = useState<string[]>(() => loadRecentIds());
  const { width: terminalWidth, height: terminalHeight } = useTerminalSize();

  // Persist recent ids when they change
  useEffect(() => {
    saveRecentIds(recentIds);
  }, [recentIds]);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
    }
  }, [isOpen]);

  const filteredItems = useMemo(() => filterCommandItems(items, query), [items, query]);

  // Build recent items from the top-level items list
  const recentItems = useMemo(() => {
    if (recentIds.length === 0) return [];
    const itemMap = new Map(items.map((item) => [item.id, item]));
    return recentIds
      .map((id) => itemMap.get(id))
      .filter((item): item is CommandItem => item !== undefined);
  }, [recentIds, items]);

  // When no query, show all items; when filtering, show filtered
  const totalCount = items.length;
  const filteredCount = filteredItems.length;

  const visibleCount = calculateVisibleCount(terminalHeight);

  // When there is a query, filtered items are shown; otherwise all items
  const visibleItems = useMemo(() => {
    const pool = query.trim() ? filteredItems : items;
    return pool.slice(0, visibleCount);
  }, [query, filteredItems, items, visibleCount]);

  const matchLabel = query.trim()
    ? `${filteredCount} of ${totalCount} commands`
    : `${totalCount} commands`;

  const groupedItems = useMemo(() => {
    if (query.trim()) {
      return groupCommandItems(visibleItems);
    }
    const recentIdSet = new Set(recentItems.map((r) => r.id));
    return groupCommandItems(visibleItems.filter((item) => !recentIdSet.has(item.id)));
  }, [visibleItems, query, recentItems]);

  const executeAndRecord = useCallback(
    (item: CommandItem) => {
      item.action();
      // Record as recent (keep last MAX_RECENT unique ids)
      setRecentIds((prev) => {
        const next = [item.id, ...prev.filter((id) => id !== item.id)].slice(0, MAX_RECENT);
        return next;
      });
      onClose();
    },
    [onClose]
  );

  useInput(
    useCallback(
      (
        input: string,
        key: {
          escape?: boolean;
          return?: boolean;
          upArrow?: boolean;
          downArrow?: boolean;
          backspace?: boolean;
        }
      ) => {
        if (!isOpen) return;

        if (key.escape) {
          onClose();
          return;
        }

        if (key.return) {
          if (visibleItems[selectedIndex]) {
            executeAndRecord(visibleItems[selectedIndex]);
          }
          return;
        }

        if (key.upArrow) {
          setSelectedIndex((prev) => (prev > 0 ? prev - 1 : visibleItems.length - 1));
          return;
        }

        if (key.downArrow) {
          setSelectedIndex((prev) => (prev < visibleItems.length - 1 ? prev + 1 : 0));
          return;
        }

        if (key.backspace) {
          setQuery((prev) => prev.slice(0, -1));
          setSelectedIndex(0);
          return;
        }

        if (input) {
          setQuery((prev) => prev + input);
          setSelectedIndex(0);
        }
      },
      [visibleItems, isOpen, onClose, selectedIndex, executeAndRecord]
    ),
    { isActive: isOpen }
  );

  useEffect(() => {
    if (selectedIndex >= visibleItems.length) {
      setSelectedIndex(Math.max(0, visibleItems.length - 1));
    }
  }, [visibleItems.length, selectedIndex]);

  if (!isOpen) return null;

  const groupLabels: Record<string, string> = {
    command: 'Commands',
    screen: 'Screens',
    session: 'Sessions',
    agent: 'Agents',
    symbol: 'Symbols',
    setting: 'Settings',
  };

  const groupIcons: Record<string, string> = {
    command: '/',
    screen: '@',
    session: '#',
    agent: '*',
    symbol: '$',
    setting: '~',
  };

  // Render a single command row
  const renderItem = (item: CommandItem, globalIdx: number) => {
    const isSelected = globalIdx === selectedIndex;
    const labelColor = isSelected ? COLORS.warning : COLORS.primary;
    const descColor = isSelected ? COLORS.accent : COLORS.muted;
    const queryText = query.trim();
    const icon = groupIcons[item.group] || '';

    return (
      <Box
        key={item.id}
        paddingX={SPACING.xs}
        paddingY={0}
        flexDirection="row"
        justifyContent="space-between"
      >
        <Box flexDirection="row" flexShrink={1}>
          <Text color={isSelected ? COLORS.warning : COLORS.muted} bold={isSelected}>
            {isSelected ? '>' : ' '}{' '}
          </Text>
          <Text color={COLORS.muted} dimColor={!isSelected}>{icon} </Text>
          <HighlightLabel
            label={item.label}
            query={queryText}
            color={labelColor}
            bold={isSelected}
          />
        </Box>
        <Box flexDirection="row" flexShrink={0}>
          {item.description && (
            <Text color={descColor} dimColor={!isSelected}>
              {' '}
              {item.description}
            </Text>
          )}
          {item.shortcut && <Text color={COLORS.muted}> {item.shortcut}</Text>}
        </Box>
      </Box>
    );
  };

  return (
    <Box
      flexDirection="column"
      width={Math.max(36, Math.min(60, terminalWidth - 2))}
      borderStyle="round"
      borderColor={COLORS.borderAccent}
    >
      {/* Header */}
      <Box paddingX={SPACING.xs} paddingY={0}>
        <Text bold color={COLORS.accent}>
          {placeholder}
        </Text>
      </Box>

      {/* Search input */}
      <Box paddingX={SPACING.xs} paddingY={0}>
        <Text color={COLORS.primary}>
          <Text color={COLORS.accent}>/</Text>
          <Text color={COLORS.muted}> </Text>
          {query || ' '}
        </Text>
      </Box>

      <Box height={1} borderStyle="single" borderColor={COLORS.borderAccent} />

      {/* Results */}
      <Box flexDirection="column" height={visibleCount} overflow="hidden">
        {visibleItems.length === 0 ? (
          <Box paddingX={SPACING.xs} paddingY={1}>
            <Text color={COLORS.muted}>No matching commands</Text>
          </Box>
        ) : (
          <>
            {/* Recent group (shown when no query is active) */}
            {!query.trim() && recentItems.length > 0 && (
              <Box flexDirection="column">
                <Box paddingX={SPACING.xs} paddingY={0}>
                  <Text bold color={COLORS.accent}>
                    Recent
                  </Text>
                </Box>
                {recentItems.map((item) => {
                  const globalIdx = visibleItems.indexOf(item);
                  // Only render recent items that are in the visible pool
                  if (globalIdx === -1) return null;
                  return renderItem(item, globalIdx);
                })}
              </Box>
            )}

            {/* Main groups */}
            {Object.entries(groupedItems).map(([group, groupItems]) => {
              if (groupItems.length === 0) return null;

              return (
                <Box key={group} flexDirection="column">
                  <Box paddingX={SPACING.xs} paddingY={0}>
                    <Text bold color={COLORS.muted}>
                      {groupLabels[group]}
                    </Text>
                  </Box>
                  {groupItems.map((item) => {
                    const globalIdx = visibleItems.indexOf(item);
                    return renderItem(item, globalIdx);
                  })}
                </Box>
              );
            })}
          </>
        )}
      </Box>

      {/* Status line */}
      <Box paddingX={SPACING.xs} paddingY={0}>
        <Text color={COLORS.muted}>{matchLabel}</Text>
      </Box>

      <Box height={1} borderStyle="single" borderColor={COLORS.borderAccent} />

      {/* Footer */}
      <Box paddingX={SPACING.xs} paddingY={0}>
        <Text color={COLORS.muted}>
          [UP/DN] Navigate [ENTER] Select [ESC] Close [CTRL+K] Toggle
        </Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useCommandPalette(items: CommandItem[]) {
  const [isOpen, setIsOpen] = useState(false);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((prev) => !prev), []);

  useInput(
    useCallback(
      (_input: string, key: { ctrl?: boolean; meta?: boolean; k?: boolean }) => {
        if ((key.ctrl || key.meta) && key.k) {
          toggle();
        }
      },
      [toggle]
    ),
    { isActive: true }
  );

  return {
    isOpen,
    open,
    close,
    toggle,
    CommandPalette: () => <CommandPalette isOpen={isOpen} onClose={close} items={items} />,
  };
}
