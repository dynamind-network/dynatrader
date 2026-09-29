import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import stripAnsi from 'strip-ansi';
import type { Message, PositionCardArtifact } from '../types.js';
import { MarkdownRenderer } from './MarkdownRenderer.js';
import { DiffRenderer } from './DiffRenderer.js';
import { WriteArtifactRenderer } from './WriteArtifactRenderer.js';
import { createSymbolPattern } from './marketSymbols.js';
import { COLORS, GLYPHS, SPACING } from '../design/tokens.js';

interface ChatMessageItemProps {
  message: Message;
  contentWidth?: number;
  showThinking?: boolean;
  isTranscriptMode?: boolean;
}

const SYMBOL_PATTERN = createSymbolPattern();

/** Characters shown in collapsed thinking preview */
const THINKING_COLLAPSE_LENGTH = 200;

/** Lines threshold for collapsing shell output */
const SHELL_OUTPUT_LINE_THRESHOLD = 10;

function getCleanContent(content: string): string {
  return stripAnsi(content);
}

function detectSymbols(content: string): string[] {
  const matches = content.match(SYMBOL_PATTERN);
  if (!matches) return [];
  return [...new Set(matches.map((s) => s.toUpperCase()))];
}

function ChatMessageItemComponent({
  message,
  contentWidth,
  showThinking = true,
  isTranscriptMode = false,
}: ChatMessageItemProps) {
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [shellExpanded, setShellExpanded] = useState(false);

  // Tab toggles expandable blocks (thinking + shell output)
  useInput((input, key) => {
    if (key.tab) {
      const hasThinking = message.parts?.some((p) => p.type === 'thinking');
      const hasShellOutput = message.toolArtifact?.kind === 'shell_output';

      if (hasThinking) {
        setThinkingExpanded((prev) => !prev);
      }
      if (hasShellOutput) {
        setShellExpanded((prev) => !prev);
      }
    }
  });

  // --- User messages --------------------------------------------------------
  if (message.role === 'user') {
    const lines = message.content.split('\n');
    return (
      <Box flexDirection="column" width={contentWidth}>
        {lines.map((line, index) => (
          <Text key={index} color={COLORS.userMessage} bold wrap="wrap">
            {index === 0 ? `${GLYPHS.userPrompt} ` : '  '}
            {getCleanContent(line)}
          </Text>
        ))}
      </Box>
    );
  }

  // --- Assistant messages ---------------------------------------------------
  if (message.role === 'assistant') {
    if (message.parts?.length) {
      const visibleParts = message.parts.filter(
        (part) => part.type !== 'thinking' || isTranscriptMode || showThinking
      );

      return (
        <Box flexDirection="column">
          {visibleParts.map((part, index) => {
            if (part.type === 'thinking') {
              // Compact thinking block - OpenCode style
              // Only show header if showThinking is false, show content if true
              if (!showThinking) {
                return (
                  <Box key={`thinking-${index}`} flexDirection="column">
                    <Text color={COLORS.thinking} dimColor italic>
                      {GLYPHS.diamond} Thinking...
                    </Text>
                  </Box>
                );
              }

              const thinkingText = getCleanContent(part.text ?? '');
              const isLong = thinkingText.length > THINKING_COLLAPSE_LENGTH;
              const collapsed = !thinkingExpanded;

              return (
                <Box key={`thinking-${index}`} flexDirection="column">
                  <Text color={COLORS.thinking} dimColor italic>
                    {GLYPHS.diamond} Thinking...{collapsed && isLong ? ` ${GLYPHS.expandHint}` : ''}
                  </Text>
                  {showThinking && part.text && (
                    <Box marginLeft={2}>
                      <Text dimColor wrap="wrap">
                        {collapsed && isLong
                          ? `${thinkingText.slice(0, THINKING_COLLAPSE_LENGTH)}${GLYPHS.separator}...`
                          : thinkingText}
                      </Text>
                    </Box>
                  )}
                </Box>
              );
            }

            // Text content - render as markdown
            return (
              <MarkdownRenderer
                key={`text-${index}`}
                content={getCleanContent(part.text ?? '')}
                maxWidth={contentWidth}
              />
            );
          })}
        </Box>
      );
    }

    const symbols = detectSymbols(message.content);
    return (
      <Box flexDirection="column">
        <MarkdownRenderer content={getCleanContent(message.content)} maxWidth={contentWidth} />
        {symbols.length > 0 && (
          <Box flexDirection="row" marginTop={1} gap={SPACING.sm}>
            {symbols.map((symbol) => (
              <Box key={symbol} flexDirection="column">
                <Text color={COLORS.warning} bold>
                  {symbol}
                </Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    );
  }

  // --- Tool messages --------------------------------------------------------
  if (message.role === 'tool') {
    // Ensure status is always set - default to 'completed' if not specified
    const toolStatus = message.status || 'completed';
    const statusLabel =
      toolStatus === 'error'
        ? GLYPHS.cross
        : toolStatus === 'pending'
          ? GLYPHS.toolPending
          : GLYPHS.check;
    const statusColor =
      toolStatus === 'error'
        ? COLORS.toolError
        : toolStatus === 'pending'
          ? COLORS.toolRunning
          : COLORS.muted;

    // Use toolName if available, otherwise use content
    const toolDisplayName = message.toolName || getCleanContent(message.content) || 'tool';
    const previewContent = message.preview || message.content || '';

    return (
      <Box flexDirection="column" width={contentWidth}>
        <Text color={COLORS.primary} wrap="truncate">
          <Text color={statusColor} bold>{statusLabel}</Text>
          <Text color={COLORS.muted}>  </Text>
          <Text bold>{toolDisplayName}</Text>
          {toolStatus === 'pending' && <Text color={COLORS.toolRunning}>  running</Text>}
          {toolStatus === 'error' && <Text color={COLORS.toolError}>  failed</Text>}
        </Text>
        {previewContent && (
          <Text
            color={toolStatus === 'error' ? COLORS.toolError : COLORS.primary}
            dimColor={toolStatus !== 'pending'}
            italic={toolStatus === 'pending'}
            wrap="truncate"
          >
            {`${GLYPHS.separator}${GLYPHS.separator} ${getCleanContent(previewContent)}`}
          </Text>
        )}
        {message.toolArtifact?.kind === 'diff' ? (
          <DiffRenderer artifact={message.toolArtifact} maxWidth={contentWidth} />
        ) : null}
        {message.toolArtifact?.kind === 'write' ? (
          <WriteArtifactRenderer artifact={message.toolArtifact} maxWidth={contentWidth} />
        ) : null}
        {message.toolArtifact?.kind === 'position-card' ? (
          <PositionCardInline artifact={message.toolArtifact as PositionCardArtifact} />
        ) : null}
        {message.toolArtifact?.kind === 'shell_output' ? (
          <ShellOutputBlock artifact={message.toolArtifact} expanded={shellExpanded} />
        ) : null}
      </Box>
    );
  }

  // --- Thinking role messages -----------------------------------------------
  if (message.role === 'thinking') {
    // In transcript mode, show full thinking content
    if (isTranscriptMode) {
      return (
        <Box flexDirection="column">
          <Text color={message.status === 'error' ? COLORS.error : COLORS.thinking} bold>
            {GLYPHS.diamond} Thinking:
          </Text>
          <Box marginLeft={2}>
            <Text wrap="wrap">{message.content}</Text>
          </Box>
          {message.preview && (
            <Box marginLeft={2}>
              <Text dimColor>{`${GLYPHS.separator}${GLYPHS.separator} ${message.preview}`}</Text>
            </Box>
          )}
        </Box>
      );
    }

    // In chat mode, show compact indicator only if showThinking is true
    if (!showThinking) {
      return null;
    }

    return (
      <Box>
        <Text dimColor italic>
          {message.preview
            ? `${GLYPHS.diamond} Thinking: ${message.preview}`
            : `${GLYPHS.diamond} Thinking...`}
        </Text>
      </Box>
    );
  }

  // --- System / command output and other roles ------------------------------
  const lines = (message.content ?? '').split('\n');
  return (
    <Box flexDirection="column" width={contentWidth}>
      {lines.map((line, index) => (
        <Text key={index} color={COLORS.muted} wrap="wrap">
          {getCleanContent(line) || ' '}
        </Text>
      ))}
    </Box>
  );
}

// Memoize ChatMessageItem to prevent re-renders when props haven't changed
export const ChatMessageItem = React.memo(ChatMessageItemComponent, (prev, next) => {
  return (
    prev.message === next.message &&
    prev.contentWidth === next.contentWidth &&
    prev.showThinking === next.showThinking &&
    prev.isTranscriptMode === next.isTranscriptMode
  );
});

// =============================================================================
// Shell output block with expand/collapse
// =============================================================================

interface ShellOutputBlockProps {
  artifact: { stdout: string; stderr: string };
  expanded: boolean;
}

function ShellOutputBlock({ artifact, expanded }: ShellOutputBlockProps) {
  const stdoutLines = artifact.stdout ? artifact.stdout.split('\n') : [];
  const stderrLines = artifact.stderr ? artifact.stderr.split('\n') : [];
  const totalLines = stdoutLines.length + stderrLines.length;
  const isCollapsible = totalLines > SHELL_OUTPUT_LINE_THRESHOLD;

  return (
    <Box flexDirection="column" marginTop={SPACING.xs} marginLeft={SPACING.sm}>
      {artifact.stdout && (
        <Box flexDirection="column">
          {isCollapsible && !expanded
            ? stdoutLines.slice(0, 5).map((line, i) => (
                <Text key={i} dimColor>
                  {line}
                </Text>
              ))
            : stdoutLines.map((line, i) => (
                <Text key={i} dimColor>
                  {line}
                </Text>
              ))}
          {isCollapsible && (
            <Text dimColor italic>
              {expanded
                ? `${GLYPHS.check} ${totalLines} lines ${GLYPHS.separator} ${GLYPHS.expandHint} to collapse`
                : `[${totalLines} lines] ${GLYPHS.expandHint} to expand`}
            </Text>
          )}
        </Box>
      )}
      {artifact.stderr && (
        <Box flexDirection="column" marginTop={artifact.stdout ? SPACING.xs : 0}>
          <Text color={COLORS.error}>STDERR:</Text>
          {isCollapsible && !expanded
            ? stderrLines.slice(0, 5).map((line, i) => (
                <Text key={i} color={COLORS.error} dimColor>
                  {line}
                </Text>
              ))
            : stderrLines.map((line, i) => (
                <Text key={i} color={COLORS.error} dimColor>
                  {line}
                </Text>
              ))}
        </Box>
      )}
    </Box>
  );
}

// =============================================================================
// Position card inline widget
// =============================================================================

function PositionCardInline({ artifact }: { artifact: PositionCardArtifact }) {
  const pnlColor = artifact.pnl >= 0 ? COLORS.success : COLORS.error;
  const sideColor = artifact.side === 'long' ? COLORS.success : COLORS.error;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={COLORS.borderAccent}
      paddingX={1}
      marginTop={1}
    >
      <Box>
        <Text bold color={COLORS.primary}>
          {artifact.symbol}
        </Text>
        <Text color={COLORS.muted}> </Text>
        <Text color={sideColor}>{artifact.side.toUpperCase()}</Text>
        <Text color={COLORS.muted}> </Text>
        <Text dimColor>{artifact.leverage}x</Text>
      </Box>
      <Box>
        <Text color={COLORS.muted}>Size: </Text>
        <Text>{artifact.size}</Text>
      </Box>
      <Box>
        <Text color={COLORS.muted}>Entry: </Text>
        <Text>${artifact.entryPrice.toFixed(2)}</Text>
        <Text color={COLORS.muted}> | Current: </Text>
        <Text>${artifact.currentPrice.toFixed(2)}</Text>
      </Box>
      <Box>
        <Text color={COLORS.muted}>PnL: </Text>
        <Text color={pnlColor}>
          ${artifact.pnl.toFixed(2)} ({artifact.pnlPercent.toFixed(2)}%)
        </Text>
      </Box>
      {artifact.liquidationPrice && (
        <Box>
          <Text color={COLORS.muted}>Liq: </Text>
          <Text color={COLORS.error}>${artifact.liquidationPrice.toFixed(2)}</Text>
        </Box>
      )}
    </Box>
  );
}
