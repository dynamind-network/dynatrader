import React from 'react';
import { Box, Text } from 'ink';
import { COLORS } from './tokens.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface DividerProps {
  /** Optional title displayed in the center of the divider line. */
  title?: string;
  /** Character used to draw the divider line. Defaults to horizontal bar. */
  char?: string;
  /** Color of the divider line and title. Defaults to COLORS.muted. */
  color?: string;
  /** Total width of the divider in columns. If omitted, fills available width. */
  width?: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * A horizontal divider line with an optional centered title.
 *
 * Used for visual separation between sections in the UI.
 *
 * @example
 * <Divider />
 * <Divider title="Section Header" />
 * <Divider title="Details" color="cyan" char="-" />
 */
export const Divider: React.FC<DividerProps> = ({
  title,
  char = '\u2500', // ─ horizontal bar
  color = COLORS.muted,
  width,
}) => {
  if (title && width) {
    // Title centered with lines on both sides
    const padding = 3; // spaces around title: " ─ Title ─ "
    const lineLen = Math.max(0, Math.floor((width - title.length - padding) / 2));
    const leftLine = char.repeat(lineLen);
    const rightLine = char.repeat(Math.max(0, width - lineLen - title.length - padding));
    return (
      <Box width={width}>
        <Text color={color}>
          {leftLine}{' '}
        </Text>
        <Text color={COLORS.primary} bold>
          {title}
        </Text>
        <Text color={color}>
          {' '}{rightLine}
        </Text>
      </Box>
    );
  }

  if (title) {
    // Title centered with padding, no fixed width
    return (
      <Box>
        <Text color={color}>
          {char}{' '}{title}{' '}{char}
        </Text>
      </Box>
    );
  }

  // Simple line (no title)
  return (
    <Box width={width}>
      <Text color={color}>{char.repeat(width ?? 40)}</Text>
    </Box>
  );
};

export default Divider;
