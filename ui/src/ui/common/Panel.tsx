import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { useLayout } from './LayoutProvider.js';
import { COLORS, GLYPHS, SPACING } from '../design/tokens.js';

interface PanelProps {
  id: string;
  title: string;
  children: React.ReactNode;
  defaultSize?: number;
  minSize?: number;
  maxSize?: number;
  collapsible?: boolean;
  borderColor?: string;
  borderAccentColor?: string;
}

export function Panel({
  id,
  title,
  children,
  defaultSize,
  minSize = 5,
  maxSize = 80,
  collapsible = true,
  borderColor = COLORS.border,
  borderAccentColor = COLORS.borderAccent,
}: PanelProps) {
  const { panelSizes, getPanelConfig } = useLayout();
  const config = getPanelConfig(id);
  const size = panelSizes[id] ?? defaultSize ?? config?.defaultSize ?? 20;
  const clampedSize = Math.max(minSize, Math.min(maxSize, size));
  const [collapsed, setCollapsed] = useState(false);

  const handleToggleCollapse = useCallback(() => {
    if (collapsible) {
      setCollapsed(prev => !prev);
    }
  }, [collapsible]);

  // Wire keyboard toggle: Enter key toggles collapsed/expanded
  useInput((input, key) => {
    if (collapsible && key.return) {
      handleToggleCollapse();
    }
  });

  const activeBorderColor = borderColor;

  // Collapsed: single-line format ┌─ Title ───── [Tab] ┐
  if (collapsed) {
    return (
      <Box flexDirection="column" width={clampedSize}>
        <Box
          flexDirection="row"
          justifyContent="space-between"
          alignItems="center"
          borderStyle="round"
          borderColor={activeBorderColor}
          paddingX={SPACING.xs}
          paddingY={0}
        >
          <Text bold color={COLORS.primary}>
            {title}
          </Text>
          {collapsible && (
            <Text dimColor color={COLORS.muted}>
              {GLYPHS.expandHint}
            </Text>
          )}
        </Box>
      </Box>
    );
  }

  // Expanded: header + content + bottom border
  return (
    <Box flexDirection="column" width={clampedSize}>
      <Box
        flexDirection="row"
        justifyContent="space-between"
        alignItems="center"
        borderStyle="round"
        borderColor={activeBorderColor}
        paddingX={SPACING.xs}
        paddingY={0}
      >
        <Text bold color={COLORS.primary}>
          {title}
        </Text>
        {collapsible && (
          <Text dimColor color={COLORS.muted}>
            {GLYPHS.expandHint}
          </Text>
        )}
      </Box>

      <Box flexDirection="column" flexGrow={1} overflow="hidden" paddingX={SPACING.xs} paddingY={0}>
        {children}
      </Box>
    </Box>
  );
}
