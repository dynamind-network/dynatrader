import React from 'react';
import { Box, Text, useInput } from 'ink';
import { COLORS, GLYPHS, SPACING } from '../design/tokens.js';

interface WelcomeScreenProps {
  onStart: () => void;
}

const APP_NAME = 'DynaMind Terminal';
const VERSION = '1.0.0';

const TIPS = [
  'Type a message to chat with the AI assistant',
  'Press Ctrl+K to open the command palette',
  'Press H for help and keyboard shortcuts',
];

export function WelcomeScreen({ onStart }: WelcomeScreenProps) {
  useInput((_input, key) => {
    if (key.return) {
      onStart();
    }
  });

  return (
    <Box
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      width="100%"
      height="100%"
    >
      <Box flexDirection="column" alignItems="center" gap={SPACING.lg}>
        {/* App name */}
        <Text color={COLORS.accent} bold>
          {APP_NAME}
        </Text>

        {/* Version */}
        <Text color={COLORS.muted}>
          v{VERSION}
        </Text>

        {/* Divider */}
        <Text color={COLORS.muted}>
          {GLYPHS.separator}
        </Text>

        {/* Quick-start tips */}
        <Box flexDirection="column" alignItems="flex-start" gap={SPACING.md}>
          <Text color={COLORS.muted}>Quick start:</Text>
          {TIPS.map((tip, i) => (
            <Box key={i} gap={SPACING.sm}>
              <Text color={COLORS.success}>{GLYPHS.check}</Text>
              <Text>{tip}</Text>
            </Box>
          ))}
        </Box>

        {/* Divider */}
        <Text color={COLORS.muted}>
          {GLYPHS.separator}
        </Text>

        {/* Enter hint */}
        <Text color={COLORS.muted} dimColor>
          Press Enter to start
        </Text>
      </Box>
    </Box>
  );
}

export default WelcomeScreen;
