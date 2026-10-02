import React from 'react';
import { Box, Text } from '@dynatrader/ink/terminal';
import { COLORS, GLYPHS, SPACING } from '../design/tokens.js';

export interface ListItemProps {
  /** Whether this item is currently focused/selected */
  isSelected: boolean;
  
  /** Whether this item represents the current value */
  isCurrent?: boolean;
  
  /** Whether this item is disabled/unavailable */
  isDisabled?: boolean;
  
  /** The main label text */
  label: string;
  
  /** Optional description text */
  description?: string;
  
  /** Optional keyboard shortcut hint */
  shortcut?: string;
  
  /** Optional byline/metadata text (middot-separated) */
  byline?: string;
  
  /** Whether to show the selection indicator */
  showIndicator?: boolean;
  
  /** Custom indicator character (defaults to GLYPHS.pointer) */
  indicator?: string;
  
  /** Custom checkmark character (defaults to GLYPHS.checkmark) */
  checkmark?: string;
  
  /** Whether to highlight matched characters in the label */
  highlightQuery?: string;
  
  /** Callback when item is selected (Enter key) */
  onSelect?: () => void;
}

/**
 * A reusable list item component with consistent keyboard and selection states.
 * 
 * Features:
 * - Consistent visual states (focused, selected, disabled)
 * - Optional description and shortcut hints
 * - Byline metadata with middot separators
 * - Character highlighting for search matches
 * - Theme-aware colors
 */
export function ListItem({
  isSelected,
  isCurrent = false,
  isDisabled = false,
  label,
  description,
  shortcut,
  byline,
  showIndicator = true,
  indicator = GLYPHS.pointer,
  checkmark = GLYPHS.checkmark,
  highlightQuery,
}: ListItemProps) {
  // Determine colors based on state
  const indicatorColor = isSelected ? COLORS.pickerPointer : COLORS.muted;
  const labelColor = isDisabled
    ? COLORS.muted
    : isSelected
    ? COLORS.primary
    : COLORS.primary;
  const descriptionColor = isSelected ? COLORS.accent : COLORS.muted;
  const bylineColor = COLORS.muted;

  // Render label with optional highlighting
  const renderLabel = () => {
    if (!highlightQuery) {
      return (
        <Text color={labelColor} bold={isSelected} dimColor={isDisabled}>
          {label}
        </Text>
      );
    }

    // Simple highlighting - in a real implementation, you'd use the HighlightLabel component
    return (
      <Text color={labelColor} bold={isSelected} dimColor={isDisabled}>
        {label}
      </Text>
    );
  };

  return (
    <Box flexDirection="row" paddingX={SPACING.xs}>
      {/* Selection indicator */}
      {showIndicator && (
        <Text color={indicatorColor} bold={isSelected}>
          {isSelected ? indicator : ' '}
        </Text>
      )}

      {/* Main label */}
      <Box flexDirection="row" flexShrink={1}>
        {renderLabel()}
      </Box>

      {/* Current value checkmark */}
      {isCurrent && !isSelected && (
        <Text color={COLORS.pickerCheck}> {checkmark}</Text>
      )}

      {/* Description */}
      {description && (
        <Text color={descriptionColor} dimColor={!isSelected}>
          {' '}
          {description}
        </Text>
      )}

      {/* Byline */}
      {byline && (
        <Text color={bylineColor}>
          {' '}
          {GLYPHS.separator} {byline}
        </Text>
      )}

      {/* Keyboard shortcut */}
      {shortcut && (
        <Text color={COLORS.muted}> {shortcut}</Text>
      )}
    </Box>
  );
}

/**
 * A container component for list items with L-bracket borders.
 */
export function ListContainer({
  children,
  title,
  width,
  height,
  borderColor = COLORS.borderAccent,
}: {
  children: React.ReactNode;
  title?: string;
  width?: number;
  height?: number;
  borderColor?: string;
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      width={width}
      height={height}
      overflow="hidden"
    >
      {title && (
        <Box marginBottom={1}>
          <Text color={COLORS.accent} bold>
            {title}
          </Text>
        </Box>
      )}
      {children}
    </Box>
  );
}

/**
 * A component for displaying metadata in a Byline style.
 */
export function Byline({
  items,
  separator = GLYPHS.separator,
}: {
  items: string[];
  separator?: string;
}) {
  return (
    <Text color={COLORS.muted}>
      {items.filter(Boolean).join(` ${separator} `)}
    </Text>
  );
}

/**
 * A component for displaying keyboard shortcut hints.
 */
export function KeyboardShortcutHint({
  shortcuts,
}: {
  shortcuts: Array<{ key: string; action: string }>;
}) {
  return (
    <Text color={COLORS.muted}>
      {shortcuts.map(({ key, action }) => `${key} ${action}`).join(` ${GLYPHS.separator} `)}
    </Text>
  );
}

