import React, { useEffect, useState, useCallback } from 'react';
import { Box, Text, useInput } from '@dynatrader/ink/terminal';
import { TerminalTextInput as TextInput } from './TerminalTextInput.js';
import { COLORS, GLYPHS, SPACING } from '../design/tokens.js';
import { MouseRegion } from '../input/MouseInputProvider.js';

interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
}

interface SessionPickerModalProps {
  sessions: SessionSummary[];
  onSelect: (sessionId: string) => void;
  onClose: () => void;
  onDelete?: (sessionId: string) => void;
  onLoadSessions?: () => Promise<void>;
  height: number;
  width: number;
  selectedIndex: number;
  onSelectedIndexChange: (index: number) => void;
}

function formatTimeAgo(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins} min ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  return date.toLocaleDateString();
}

export function SessionPickerModal({
  sessions,
  onSelect,
  onClose,
  onDelete,
  onLoadSessions,
  height,
  width,
  selectedIndex,
  onSelectedIndexChange,
}: SessionPickerModalProps) {
  const [filterText, setFilterText] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (onLoadSessions) {
      onLoadSessions();
    }
  }, [onLoadSessions]);

  // Filter sessions by name
  const filteredSessions = filterText.trim()
    ? sessions.filter((s) => s.title.toLowerCase().includes(filterText.toLowerCase()))
    : sessions;

  const maxTitleWidth = Math.max(30, width - 20);
  const boxWidth = Math.min(maxTitleWidth + 10, width - 4);
  const visibleSessions = height - 10; // account for search input + borders
  const displaySessions = filteredSessions.slice(0, visibleSessions);

  // Reset selection index when filter changes
  useEffect(() => {
    if (selectedIndex >= filteredSessions.length) {
      onSelectedIndexChange(Math.max(0, filteredSessions.length - 1));
    }
  }, [filteredSessions.length, selectedIndex, onSelectedIndexChange]);

  const handleDeleteConfirm = useCallback(
    (input: string) => {
      if (input === 'y' || input === 'Y') {
        const sessionToDelete = filteredSessions[selectedIndex];
        if (sessionToDelete && onDelete) {
          onDelete(sessionToDelete.id);
          setConfirmDelete(false);
          // Adjust selection if needed
          if (selectedIndex >= filteredSessions.length - 1) {
            onSelectedIndexChange(Math.max(0, filteredSessions.length - 2));
          }
        }
      } else {
        setConfirmDelete(false);
      }
    },
    [filteredSessions, selectedIndex, onDelete, onSelectedIndexChange]
  );

  // Handle filter text changes - no-op during delete confirmation
  const handleFilterChange = useCallback(
    (value: string) => {
      if (!confirmDelete) {
        setFilterText(value);
      }
    },
    [confirmDelete]
  );

  useInput((input, key) => {
    // If showing delete confirmation, handle y/n
    if (confirmDelete) {
      handleDeleteConfirm(input);
      return;
    }

    // Navigate sessions
    if (key.upArrow) {
      onSelectedIndexChange(Math.max(0, selectedIndex - 1));
    } else if (key.downArrow) {
      onSelectedIndexChange(Math.min(displaySessions.length - 1, selectedIndex + 1));
    } else if (key.return) {
      // Enter to select
      const session = displaySessions[selectedIndex];
      if (session) {
        onSelect(session.id);
      }
    } else if (key.escape) {
      onClose();
    } else if (key.delete && onDelete) {
      // Del key to delete
      setConfirmDelete(true);
    }
  });

  const truncateId = (id: string): string => id.slice(0, 6);

  return (
    <Box flexDirection="column" padding={SPACING.xs} height={height} width={width}>
      {/* Header */}
      <Box marginBottom={SPACING.xs}>
        <Text color={COLORS.accent} bold>
          {GLYPHS.arrow} RESUME SESSION
        </Text>
      </Box>

      {/* Search filter input */}
      <Box marginBottom={SPACING.xs} width={boxWidth}>
        <TextInput
          value={filterText}
          onChange={handleFilterChange}
          placeholder="Type to filter sessions..."
        />
      </Box>

      {/* Session list */}
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={COLORS.border}
        paddingX={SPACING.xs}
        paddingY={SPACING.xs}
        width={boxWidth}
      >
        {displaySessions.length === 0 ? (
          <Box paddingY={SPACING.xs}>
            <Text color={COLORS.muted}>
              {filterText ? 'No matching sessions.' : 'No saved sessions yet.'}
            </Text>
          </Box>
        ) : (
          displaySessions.map((session, index) => {
            const isSelected = index === selectedIndex;
            return (
              <MouseRegion key={session.id} flexDirection="row" onClick={() => onSelectedIndexChange(index)}>
                <Text color={isSelected ? COLORS.accent : COLORS.primary}>
                  {isSelected ? `${GLYPHS.arrow} ` : '  '}
                </Text>
                <Text color={isSelected ? COLORS.accent : COLORS.primary} bold={isSelected}>
                  {session.title.slice(0, maxTitleWidth)}
                </Text>
                <Text color={COLORS.muted}> ({truncateId(session.id)})</Text>
                <Text color={COLORS.muted}>
                  {' '}
                  {GLYPHS.separator} {formatTimeAgo(session.updatedAt)}
                </Text>
              </MouseRegion>
            );
          })
        )}
      </Box>

      {/* Delete confirmation prompt */}
      {confirmDelete && (
        <Box marginTop={SPACING.xs} width={boxWidth}>
          <Text color={COLORS.warning} bold>
            Delete session? (y/n)
          </Text>
        </Box>
      )}

      {/* Footer */}
      <Box marginTop={SPACING.xs}>
        <Text color={COLORS.accent} bold>
          {GLYPHS.arrow}
        </Text>
        <Text color={COLORS.muted}>
          {GLYPHS.separator} Navigate{GLYPHS.separator} Enter: Select{GLYPHS.separator} Esc: Cancel
        </Text>
        {onDelete && <Text color={COLORS.muted}>{GLYPHS.separator} Del: Delete</Text>}
      </Box>
    </Box>
  );
}

export default SessionPickerModal;

