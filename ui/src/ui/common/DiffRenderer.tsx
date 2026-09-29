import React, { useState, useMemo, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { COLORS, GLYPHS } from '../design/tokens.js';
import type { DiffToolArtifact } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DiffOp = {
  type: 'context' | 'add' | 'remove';
  text: string;
  oldLine: number;
  newLine: number;
};

type DiffHunk = {
  header: string;
  lines: DiffOp[];
  oldStart: number;
  newStart: number;
  oldCount: number;
  newCount: number;
};

type RenderedDiffLine = {
  type: 'file' | 'hunk' | 'context' | 'add' | 'remove' | 'notice';
  text: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DIFF_CONTEXT_LINES = 2;
const MAX_RENDERED_DIFF_LINES = 120;

// ---------------------------------------------------------------------------
// Diff computation (unchanged from original)
// ---------------------------------------------------------------------------

function computeDiffOps(oldLines: string[], newLines: string[]): DiffOp[] {
  const oldLength = oldLines.length;
  const newLength = newLines.length;
  const dp: number[][] = Array.from({ length: oldLength + 1 }, () => Array(newLength + 1).fill(0));

  for (let oldIndex = oldLength - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLength - 1; newIndex >= 0; newIndex -= 1) {
      dp[oldIndex][newIndex] =
        oldLines[oldIndex] === newLines[newIndex]
          ? dp[oldIndex + 1][newIndex + 1] + 1
          : Math.max(dp[oldIndex + 1][newIndex], dp[oldIndex][newIndex + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  let oldLine = 1;
  let newLine = 1;

  while (oldIndex < oldLength && newIndex < newLength) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      ops.push({ type: 'context', text: oldLines[oldIndex], oldLine, newLine });
      oldIndex += 1;
      newIndex += 1;
      oldLine += 1;
      newLine += 1;
      continue;
    }

    if (dp[oldIndex + 1][newIndex] >= dp[oldIndex][newIndex + 1]) {
      ops.push({ type: 'remove', text: oldLines[oldLine - 1], oldLine, newLine });
      oldIndex += 1;
      oldLine += 1;
      continue;
    }

    ops.push({ type: 'add', text: newLines[newLine - 1], oldLine, newLine });
    newIndex += 1;
    newLine += 1;
  }

  while (oldIndex < oldLength) {
    ops.push({ type: 'remove', text: oldLines[oldIndex], oldLine, newLine });
    oldIndex += 1;
    oldLine += 1;
  }

  while (newIndex < newLength) {
    ops.push({ type: 'add', text: newLines[newIndex], oldLine, newLine });
    newIndex += 1;
    newLine += 1;
  }

  return ops;
}

// ---------------------------------------------------------------------------
// Hunk parsing
// ---------------------------------------------------------------------------

function parseHunks(ops: DiffOp[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let index = 0;

  while (index < ops.length) {
    // Skip context lines until we find a change
    while (index < ops.length && ops[index].type === 'context') {
      index += 1;
    }
    if (index >= ops.length) break;

    const hunkStart = Math.max(0, index - DIFF_CONTEXT_LINES);
    let cursor = index;
    let lastChange = index;

    while (cursor < ops.length) {
      if (ops[cursor].type !== 'context') lastChange = cursor;
      if (cursor - lastChange > DIFF_CONTEXT_LINES) break;
      cursor += 1;
    }

    const hunkEnd = Math.min(ops.length, lastChange + DIFF_CONTEXT_LINES + 1);
    const hunkLines = ops.slice(hunkStart, hunkEnd);
    const oldStart = hunkLines[0]?.oldLine ?? 1;
    const newStart = hunkLines[0]?.newLine ?? 1;
    const oldCount = hunkLines.filter((line) => line.type !== 'add').length;
    const newCount = hunkLines.filter((line) => line.type !== 'remove').length;

    hunks.push({
      header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
      lines: hunkLines,
      oldStart,
      newStart,
      oldCount,
      newCount,
    });

    index = hunkEnd;
  }

  return hunks;
}

// ---------------------------------------------------------------------------
// File extension extraction
// ---------------------------------------------------------------------------

function getFileExtension(path: string): string {
  const lastDot = path.lastIndexOf('.');
  if (lastDot === -1) return '';
  return path.slice(lastDot + 1).toLowerCase();
}

// ---------------------------------------------------------------------------
// Backward-compatible APIs (kept for external consumers)
// ---------------------------------------------------------------------------

export function createDiffLines(artifact: DiffToolArtifact): RenderedDiffLine[] {
  const oldLines = artifact.oldText.split('\n');
  const newLines = artifact.newText.split('\n');
  const ops = computeDiffOps(oldLines, newLines);
  const diffLines: RenderedDiffLine[] = [
    {
      type: 'file',
      text: artifact.isNewFile ? '--- /dev/null' : `--- ${artifact.path}`,
    },
    { type: 'file', text: `+++ ${artifact.path}` },
  ];

  let index = 0;
  while (index < ops.length) {
    while (index < ops.length && ops[index].type === 'context') {
      index += 1;
    }

    if (index >= ops.length) break;

    const hunkStart = Math.max(0, index - DIFF_CONTEXT_LINES);
    let cursor = index;
    let lastChange = index;

    while (cursor < ops.length) {
      if (ops[cursor].type !== 'context') lastChange = cursor;
      if (cursor - lastChange > DIFF_CONTEXT_LINES) break;
      cursor += 1;
    }

    const hunkEnd = Math.min(ops.length, lastChange + DIFF_CONTEXT_LINES + 1);
    const hunk = ops.slice(hunkStart, hunkEnd);
    const oldStart = hunk[0]?.oldLine ?? 1;
    const newStart = hunk[0]?.newLine ?? 1;
    const oldCount = hunk.filter((line) => line.type !== 'add').length;
    const newCount = hunk.filter((line) => line.type !== 'remove').length;

    diffLines.push({
      type: 'hunk',
      text: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    });

    for (const line of hunk) {
      diffLines.push({
        type: line.type,
        text:
          line.type === 'add'
            ? `+${line.text}`
            : line.type === 'remove'
              ? `-${line.text}`
              : ` ${line.text}`,
      });
    }

    index = hunkEnd;
  }

  if (diffLines.length > MAX_RENDERED_DIFF_LINES) {
    return [
      ...diffLines.slice(0, MAX_RENDERED_DIFF_LINES),
      { type: 'notice', text: '... diff truncated ...' },
    ];
  }

  if (artifact.isTruncated) {
    diffLines.push({ type: 'notice', text: '... diff truncated ...' });
  }

  return diffLines;
}

export function createDiffDisplayLines(artifact: DiffToolArtifact) {
  const diffLines = createDiffLines(artifact);

  return diffLines.map((line) => ({
    text: line.text,
    color:
      line.type === 'add'
        ? 'green'
        : line.type === 'remove'
          ? 'red'
          : line.type === 'hunk'
            ? 'cyan'
            : line.type === 'notice'
              ? 'yellow'
              : 'gray',
    dimColor: line.type === 'context' || line.type === 'file',
  }));
}

// ---------------------------------------------------------------------------
// Enhanced DiffRenderer component
// ---------------------------------------------------------------------------

/**
 * Renders a unified diff artifact with:
 * - Line numbers in a dim gray gutter
 * - Subtle tinted backgrounds for added/removed lines
 * - Summary line with addition/removal counts
 * - Per-hunk collapse/expand controls
 * - File extension badge in the title
 */
export const DiffRenderer: React.FC<{
  artifact: DiffToolArtifact;
  maxWidth?: number;
}> = ({ artifact, maxWidth }) => {
  const oldLines = artifact.oldText.split('\n');
  const newLines = artifact.newText.split('\n');
  const ops = computeDiffOps(oldLines, newLines);
  const hunks = useMemo(() => parseHunks(ops), [ops]);

  // Per-hunk expanded/collapsed state
  const [expandedHunks, setExpandedHunks] = useState<Record<number, boolean>>(() =>
    Object.fromEntries(hunks.map((_, i) => [i, true]))
  );

  const toggleHunk = useCallback((index: number) => {
    setExpandedHunks((prev) => ({ ...prev, [index]: !prev[index] }));
  }, []);

  // Wire Tab key to cycle through hunks (collapse/expand)
  useInput((input, key) => {
    if (key.tab) {
      // Find the first expanded hunk and collapse it, or expand the first collapsed
      const expandedIndices = Object.entries(expandedHunks)
        .filter(([, v]) => v)
        .map(([k]) => Number(k));
      const collapsedIndices = Object.entries(expandedHunks)
        .filter(([, v]) => !v)
        .map(([k]) => Number(k));

      if (expandedIndices.length > 0) {
        // Collapse the first expanded hunk
        toggleHunk(expandedIndices[0]);
      } else if (collapsedIndices.length > 0) {
        // Expand all collapsed hunks
        for (const idx of collapsedIndices) {
          toggleHunk(idx);
        }
      }
    }
  });

  // Compute summary counts across all ops
  const additions = ops.filter((op) => op.type === 'add').length;
  const removals = ops.filter((op) => op.type === 'remove').length;

  // Compute max line number width for gutter alignment
  const maxLineNum = Math.max(...ops.map((op) => Math.max(op.oldLine, op.newLine)), 1);
  const gutterWidth = String(maxLineNum).length;

  // File extension for badge
  const extension = getFileExtension(artifact.path);

  // Truncation check
  const totalLineCount = hunks.reduce((sum, h) => sum + h.lines.length, 0) + hunks.length;
  const isTruncated = artifact.isTruncated || totalLineCount > MAX_RENDERED_DIFF_LINES;

  const width = maxWidth ? Math.max(24, maxWidth) : undefined;

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle="single"
      borderColor={COLORS.border}
      paddingX={1}
      width={width}
    >
      {/* --- File header with extension badge --- */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="white">
          {artifact.isNewFile ? 'Write' : 'Edit'}
        </Text>
        <Text dimColor color={COLORS.muted}>
          {artifact.path}
          {extension ? (
            <>
              {' '}
              <Text color={COLORS.accent}>[{extension}]</Text>
            </>
          ) : null}
        </Text>
      </Box>

      {/* --- Diff hunks --- */}
      <Box flexDirection="column">
        {hunks.map((hunk, hunkIndex) => {
          const isExpanded = expandedHunks[hunkIndex] ?? true;

          return (
            <Box key={`hunk-${hunkIndex}`} flexDirection="column">
              {/* Hunk header */}
              <Text color="cyan" wrap="wrap">
                {hunk.header}
              </Text>

              {isExpanded ? (
                /* --- Expanded hunk: show all lines --- */
                hunk.lines.map((line, lineIndex) => {
                  const lineNum = line.type === 'remove' ? line.oldLine : line.newLine;
                  const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
                  const text = line.type === 'context' ? ` ${line.text}` : line.text;

                  return (
                    <Box key={`line-${hunkIndex}-${lineIndex}`}>
                      <Text color={COLORS.muted} dimColor>
                        {String(lineNum).padStart(gutterWidth, ' ')}
                        {' | '}
                      </Text>
                      <Text
                        color={
                          line.type === 'add'
                            ? '#7ee787'
                            : line.type === 'remove'
                              ? '#ff7b72'
                              : undefined
                        }
                        dimColor={line.type === 'context'}
                        backgroundColor={line.type === 'add' ? '#142a1b' : line.type === 'remove' ? '#301a1b' : undefined}
                        wrap="wrap"
                      >
                        {prefix}
                        {text}
                      </Text>
                    </Box>
                  );
                })
              ) : (
                /* --- Collapsed hunk: show first line + summary --- */
                <Box>
                  <Text color={COLORS.muted} dimColor>
                    {' '.repeat(gutterWidth)}
                    {' | '}
                  </Text>
                  <Text color={COLORS.muted} dimColor wrap="wrap">
                    {hunk.lines[0]
                      ? `${hunk.lines[0].type === 'remove' ? '-' : hunk.lines[0].type === 'add' ? '+' : ' '}${hunk.lines[0].text}`
                      : ''}
                    {' ... '}
                    <Text color={COLORS.accent}>{GLYPHS.expandHint}</Text>
                    {` (${hunk.lines.length} lines)`}
                  </Text>
                </Box>
              )}

              {/* Collapse/expand toggle for expanded hunks */}
              {isExpanded && (
                <Box>
                  <Text color={COLORS.accent}>{GLYPHS.expandHint}</Text>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>

      {/* --- Truncation notice --- */}
      {isTruncated ? (
        <Text color={COLORS.warning} dimColor>
          ... diff truncated ...
        </Text>
      ) : null}

      {/* --- Summary line --- */}
      <Box marginTop={1}>
        <Text color={COLORS.success}>+{additions}</Text>
        <Text color={COLORS.muted}> {GLYPHS.separator} </Text>
        <Text color={COLORS.error}>-{removals}</Text>
      </Box>
    </Box>
  );
};
