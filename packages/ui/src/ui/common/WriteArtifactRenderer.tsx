import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from '@dynatrader/ink/terminal';
import type { WriteToolArtifact } from '../types.js';
import { COLORS, GLYPHS, SPACING } from '../design/tokens.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_LINES = 50;
const ABSOLUTE_MAX_LINES = 120;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a byte count into a human-readable file size string.
 */
function formatFileSize(contents: string): string {
  const bytes = Buffer.byteLength(contents, 'utf-8');
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Pad a line number to fit the gutter width, right-aligned.
 */
function formatLineNumber(num: number, width: number): string {
  return String(num).padStart(width, ' ');
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface WriteArtifactRendererProps {
  artifact: WriteToolArtifact;
  maxWidth?: number;
  /** Maximum number of lines to display before truncating (default: 50) */
  maxLines?: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Enhanced renderer for WriteToolArtifact.
 *
 * Features:
 *  - Line numbers in a dim gray gutter with pipe separator
 *  - Neutral source preview for newly created files
 *  - Diff-style markers for updates to existing files
 *  - File size indicator below the filename
 *  - Configurable truncation with expand/collapse via Tab
 */
export function WriteArtifactRenderer({
  artifact,
  maxWidth,
  maxLines = DEFAULT_MAX_LINES,
}: WriteArtifactRendererProps) {
  const [expanded, setExpanded] = useState(false);

  const toggleExpand = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  // Wire Tab key to expand/collapse
  useInput((input, key) => {
    if (key.tab) {
      toggleExpand();
    }
  });

  const allLines = artifact.contents.split('\n');
  const totalLines = allLines.length;
  const fileSize = formatFileSize(artifact.contents);

  // Determine truncation
  const effectiveMax = Math.min(maxLines, ABSOLUTE_MAX_LINES);
  const needsTruncation = totalLines > effectiveMax;
  const truncated = needsTruncation && !expanded;
  const visibleLines = truncated ? allLines.slice(0, effectiveMax) : allLines;
  const remainingLines = totalLines - effectiveMax;

  // Line number gutter width
  const maxLineNum = visibleLines.length;
  const gutterWidth = String(maxLineNum).length;

  // Whether this is a modification to an existing file
  const isModification = !artifact.isNewFile;

  const width = maxWidth ? Math.max(24, maxWidth) : undefined;

  return (
    <Box
      flexDirection="column"
      marginTop={SPACING.xs}
      borderStyle="single"
      borderColor={COLORS.border}
      paddingX={SPACING.xs}
      width={width}
    >
      {/* --- Title --- */}
      <Box flexDirection="column" marginBottom={SPACING.xs}>
        <Text bold color={COLORS.primary}>
          {artifact.isNewFile ? 'Write' : 'Write Preview'}
        </Text>
        {artifact.path ? (
          <Text dimColor color={COLORS.muted}>
            {artifact.path}
          </Text>
        ) : null}
      </Box>

      {/* --- File size indicator --- */}
      <Box marginBottom={SPACING.sm}>
        <Text color={COLORS.muted} dimColor>
          {fileSize}
          {` ${GLYPHS.separator} `}
          {totalLines} {totalLines === 1 ? 'line' : 'lines'}
        </Text>
      </Box>

      {/* --- Content lines with line numbers and diff markers --- */}
      <Box flexDirection="column">
        {visibleLines.map((line, index) => {
          const lineNum = index + 1;
          const prefix = isModification ? '+' : ' ';

          return (
            <Box key={`${line}-${index}`}>
              {/* Line number gutter */}
              <Text color={COLORS.muted} dimColor>
                {formatLineNumber(lineNum, gutterWidth)}
                {' | '}
              </Text>

              {/* Diff-style content */}
              <Text color={isModification ? '#7ee787' : COLORS.primary} backgroundColor={isModification ? '#142a1b' : undefined} wrap="wrap">
                {prefix}
                {line}
              </Text>
            </Box>
          );
        })}
      </Box>

      {/* --- Truncation indicator --- */}
      {truncated && (
        <Box marginTop={SPACING.xs}>
          <Text color={COLORS.muted} dimColor>
            ... {remainingLines} more {remainingLines === 1 ? 'line' : 'lines'}
            {` ${GLYPHS.separator} `}
          </Text>
          <Text color={COLORS.accent}>{GLYPHS.expandHint}</Text>
        </Box>
      )}

      {/* --- Collapse hint when expanded --- */}
      {expanded && needsTruncation && (
        <Box marginTop={SPACING.xs}>
          <Text color={COLORS.accent}>{GLYPHS.expandHint}</Text>
          <Text color={COLORS.muted} dimColor>
            {' '}
            {GLYPHS.separator} collapse
          </Text>
        </Box>
      )}
    </Box>
  );
}

