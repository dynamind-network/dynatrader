import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { Message } from '../types.js';
import { getChatViewportMetrics, getScrollbarMetrics } from '../../utils/chatViewport.js';
import { ChatLineList } from './ChatLineList.js';
import { Scrollbar } from './Scrollbar.js';
import { COLORS, GLYPHS, SPACING } from '../design/tokens.js';
import type { DisplayLine } from '../../utils/chatViewport.js';

interface ChatViewportProps {
  messages: Message[];
  width: number;
  height: number;
  scrollOffset: number;
  showThinking?: boolean;
  bottomPadding?: number;
  onScrollOffsetChange?: (newOffset: number) => void;
}

/**
 * When content is shorter than the viewport, prepend blank spacer lines
 * so the latest content sits at the bottom (standard chat UX).
 */
export function bottomAlignLines(lines: DisplayLine[], pageSize: number): DisplayLine[] {
  if (lines.length >= pageSize || lines.length === 0) return lines;
  const spacerCount = pageSize - lines.length;
  const spacers: DisplayLine[] = Array.from({ length: spacerCount }, (_, i) => ({
    key: `spacer-${i}`,
    text: '',
    messageIndex: -1,
  }));
  return [...spacers, ...lines];
}

export function ChatViewportComponent({
  messages,
  width,
  height,
  scrollOffset,
  showThinking = true,
  bottomPadding = 0,
  onScrollOffsetChange,
}: ChatViewportProps) {
  if (messages.length === 0) {
    return (
      <Box
        flexDirection="column"
        height={height}
        overflow="hidden"
        justifyContent="center"
        alignItems="center"
      >
        <Text color={COLORS.accent} bold>
          DynaMind Terminal
        </Text>
        <Box marginTop={SPACING.sm} flexDirection="column" alignItems="flex-start">
          <Text color={COLORS.muted}>{GLYPHS.arrow} Type a message to start chatting</Text>
          <Text color={COLORS.muted}>{GLYPHS.arrow} Press Ctrl+K to open the command palette</Text>
          <Text color={COLORS.muted}>{GLYPHS.arrow} Press / for slash commands</Text>
          <Text color={COLORS.muted}>{GLYPHS.arrow} Press ? for keyboard shortcuts</Text>
        </Box>
      </Box>
    );
  }

  // When user has scrolled up and there are newer messages below, reserve 1 row
  // for the "jump to bottom" indicator
  const showJumpIndicator = scrollOffset > 0;
  const effectiveBottomPadding = bottomPadding + (showJumpIndicator ? 1 : 0);

  const metrics = useMemo(
    () => getChatViewportMetrics(messages, width, height, effectiveBottomPadding, scrollOffset, showThinking),
    [messages, width, height, effectiveBottomPadding, scrollOffset, showThinking]
  );

  const alignedLines = useMemo(
    () => bottomAlignLines(metrics.visibleLines, metrics.pageSize),
    [metrics.visibleLines, metrics.pageSize]
  );

  const scrollbarMetrics = useMemo(
    () => getScrollbarMetrics(metrics.totalRows, metrics.pageSize, metrics.scrollOffset, metrics.maxScrollOffset),
    [metrics.totalRows, metrics.pageSize, metrics.scrollOffset, metrics.maxScrollOffset]
  );

  const showScrollbar = scrollbarMetrics.show;
  const contentWidth = Math.max(20, width - 1);
  const messageAreaHeight = Math.max(1, height - effectiveBottomPadding);

  return (
    <Box flexDirection="column" height={height} overflow="hidden" width={width} flexShrink={0}>
      <Box
        flexDirection="row"
        height={messageAreaHeight}
        overflow="hidden"
        width={width}
        flexShrink={0}
      >
        <ChatLineList lines={alignedLines} contentWidth={contentWidth} height={messageAreaHeight} />
        {showScrollbar && (
          <Scrollbar
            metrics={scrollbarMetrics}
            onOffsetChange={onScrollOffsetChange ?? (() => {})}
          />
        )}
      </Box>
      {showJumpIndicator && metrics.hasNewer && (
        <Box flexShrink={0} height={1} width={width} justifyContent="center">
          <Text color={COLORS.accent}>↓ New messages</Text>
        </Box>
      )}
    </Box>
  );
}

export function chatViewportPropsEqual(prev: ChatViewportProps, next: ChatViewportProps): boolean {
  return (
    prev.messages === next.messages &&
    prev.width === next.width &&
    prev.height === next.height &&
    prev.scrollOffset === next.scrollOffset &&
    prev.showThinking === next.showThinking &&
    prev.bottomPadding === next.bottomPadding &&
    prev.onScrollOffsetChange === next.onScrollOffsetChange
  );
}

export const ChatViewport = React.memo(ChatViewportComponent, chatViewportPropsEqual);
