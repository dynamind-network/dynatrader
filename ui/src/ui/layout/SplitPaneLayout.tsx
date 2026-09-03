import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { COLORS, LAYOUT } from '../design/tokens.js';

interface SplitPaneLayoutProps {
  splitActive: boolean;
  leftPane: React.ReactNode;
  rightPane: React.ReactNode;
  terminalWidth: number;
  terminalHeight: number;
  /** Split ratio as a percentage (20-80). Default: 50 (50/50 split). */
  splitRatio?: number;
}

const DEFAULT_SPLIT_RATIO = 50;
const MIN_SPLIT_RATIO = 20;
const MAX_SPLIT_RATIO = 80;
const SPLIT_RATIO_STEP = 5;

/**
 * Pure rendering function for SplitPaneLayout. Extracted for testability.
 * Handles separator rendering and width calculation based on splitRatio.
 */
export function SplitPaneLayoutView({
  splitActive,
  leftPane,
  rightPane,
  terminalWidth,
  terminalHeight,
  splitRatio,
}: SplitPaneLayoutProps & { splitRatio: number }): React.ReactElement {
  if (!splitActive) {
    return (
      <Box flexDirection="column" width={terminalWidth} height={terminalHeight}>
        {leftPane}
      </Box>
    );
  }

  const leftWidth = Math.floor((terminalWidth * splitRatio) / 100);
  const rightWidth = terminalWidth - leftWidth - 1; // 1 for separator

  return (
    <Box flexDirection="row" width={terminalWidth} height={terminalHeight}>
      <Box flexDirection="column" width={leftWidth} flexGrow={0}>
        {leftPane}
      </Box>
      <Box flexDirection="column" width={1} flexGrow={0}>
        <Text color={COLORS.muted}>│</Text>
      </Box>
      <Box flexDirection="column" width={rightWidth} flexGrow={0}>
        {rightPane}
      </Box>
    </Box>
  );
}

export function SplitPaneLayout({
  splitActive,
  leftPane,
  rightPane,
  terminalWidth,
  terminalHeight,
  splitRatio: initialSplitRatio,
}: SplitPaneLayoutProps): React.ReactElement {
  const [splitRatio, setSplitRatio] = useState(initialSplitRatio ?? DEFAULT_SPLIT_RATIO);

  useInput((_input, key) => {
    if (!splitActive) return;

    if (key.ctrl && key.leftArrow) {
      setSplitRatio((prev) => Math.max(MIN_SPLIT_RATIO, prev - SPLIT_RATIO_STEP));
    } else if (key.ctrl && key.rightArrow) {
      setSplitRatio((prev) => Math.min(MAX_SPLIT_RATIO, prev + SPLIT_RATIO_STEP));
    }
  });

  return (
    <SplitPaneLayoutView
      splitActive={splitActive}
      leftPane={leftPane}
      rightPane={rightPane}
      terminalWidth={terminalWidth}
      terminalHeight={terminalHeight}
      splitRatio={splitRatio}
    />
  );
}
