import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from '@dynatrader/ink/terminal';
import type { Message } from '../types.js';
import { getChatViewportMetrics, getMessageRenderWidth, getScrollbarMetrics } from '../../utils/chatViewport.js';
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

export function ChatViewportComponent({
  messages,
  width,
  height,
  scrollOffset,
  showThinking = true,
  bottomPadding = 0,
  onScrollOffsetChange,
}: ChatViewportProps) {
  const [findQuery, setFindQuery] = useState<string | null>(null);
  const [findIndex, setFindIndex] = useState(0);
  const [findActive, setFindActive] = useState(false);
  const metricsRef = React.useRef<{ visibleLines: DisplayLine[]; maxScrollOffset: number } | null>(null);
  const scrollToMessageIndex = (targetMessageIndex: number) => {
    const visible = metricsRef.current?.visibleLines ?? [];
    if (visible.some((line) => line.messageIndex === targetMessageIndex)) return;
    let low = 0;
    let high = metricsRef.current?.maxScrollOffset ?? 0;
    let targetOffset = scrollOffset;
    while (low <= high) {
      const candidateOffset = Math.floor((low + high) / 2);
      const candidate = getChatViewportMetrics(messages, width, Math.max(1, height - 1), bottomPadding + (candidateOffset > 0 ? 1 : 0), candidateOffset, showThinking);
      const indexes = candidate.visibleLines.map((line) => line.messageIndex);
      if (indexes.includes(targetMessageIndex)) { targetOffset = candidateOffset; break; }
      const newest = Math.max(-1, ...indexes);
      const oldest = Math.min(Number.MAX_SAFE_INTEGER, ...indexes);
      if (targetMessageIndex > newest) high = candidateOffset - 1;
      else if (targetMessageIndex < oldest) low = candidateOffset + 1;
      else { targetOffset = candidateOffset; break; }
    }
    onScrollOffsetChange?.(targetOffset);
  };
  useInput((input, key) => {
    if (findActive) {
      if (key.escape) { setFindActive(false); return; }
      if (key.return) {
        setFindActive(false);
        if (findQuery) {
          const first = messages.filter((message) => !message.hidden).findIndex((message) => message.content.toLocaleLowerCase().includes(findQuery.toLocaleLowerCase()));
          if (first >= 0) { setFindIndex(0); scrollToMessageIndex(first); }
        }
        return;
      }
      if (key.backspace) { setFindQuery((query) => query?.slice(0, -1) ?? ''); setFindIndex(0); return; }
      if (input && input.length === 1 && !key.ctrl && input >= ' ') { setFindQuery((query) => (query ?? '') + input); setFindIndex(0); }
      return;
    }
    if (key.ctrl && input.toLowerCase() === 'f') { setFindQuery(''); setFindActive(true); setFindIndex(0); return; }
    if ((input === 'n' || input === 'N') && findQuery) {
      const searchable = messages.filter((message) => !message.hidden);
      const matchingIndexes = searchable.flatMap((message, index) => message.content.toLocaleLowerCase().includes(findQuery.toLocaleLowerCase()) ? [index] : []);
      if (!matchingIndexes.length) return;
      const nextIndex = input === 'N' ? (findIndex - 1 + matchingIndexes.length) % matchingIndexes.length : (findIndex + 1) % matchingIndexes.length;
      const targetMessageIndex = matchingIndexes[nextIndex]!;
      setFindIndex(nextIndex);
      scrollToMessageIndex(targetMessageIndex);
    }
  });
  // When user has scrolled up and there are newer messages below, reserve 1 row
  // for the "jump to bottom" indicator
  const showJumpIndicator = scrollOffset > 0;
  const effectiveBottomPadding = bottomPadding + (showJumpIndicator ? 1 : 0);
  const topPadding = 1;
  const contentHeight = Math.max(1, height - topPadding - (findActive ? 1 : 0));

  const metrics = useMemo(
    () => messages.length === 0
      ? null
      : getChatViewportMetrics(messages, width, contentHeight, effectiveBottomPadding, scrollOffset, showThinking),
    [messages, width, contentHeight, effectiveBottomPadding, scrollOffset, showThinking]
  );
  metricsRef.current = metrics;
  const findMatchMessageIndexes = useMemo(
    () => {
      if (!findQuery || messages.length === 0) return [];
      const needle = findQuery.toLocaleLowerCase();
      const indexes: number[] = [];
      let visibleIndex = 0;
      for (const message of messages) {
        if (message.hidden) continue;
        if (message.content.toLocaleLowerCase().includes(needle)) indexes.push(visibleIndex);
        visibleIndex++;
      }
      return indexes;
    },
    [messages, findQuery]
  );

  const scrollbarMetrics = useMemo(
    () => metrics
      ? getScrollbarMetrics(metrics.totalRows, metrics.pageSize, metrics.scrollOffset, metrics.maxScrollOffset)
      : null,
    [metrics]
  );

  if (!metrics || !scrollbarMetrics) {
    return (
      <Box flexDirection="column" height={height} overflow="hidden" justifyContent="center" alignItems="center">
        <Text color={COLORS.accent} bold>DynaMind Terminal</Text>
        <Box marginTop={SPACING.sm} flexDirection="column" alignItems="flex-start">
          <Text color={COLORS.muted}>{GLYPHS.arrow} Type a message to start chatting</Text>
          <Text color={COLORS.muted}>{GLYPHS.arrow} Press Ctrl+K to open the command palette</Text>
          <Text color={COLORS.muted}>{GLYPHS.arrow} Press / for slash commands</Text>
          <Text color={COLORS.muted}>{GLYPHS.arrow} Press ? for keyboard shortcuts</Text>
        </Box>
      </Box>
    );
  }

  const showScrollbar = scrollbarMetrics.show && width >= 3;
  const contentWidth = getMessageRenderWidth(width);
  const messageAreaHeight = Math.max(1, contentHeight - effectiveBottomPadding);

  return (
    <Box flexDirection="column" height={height} overflow="hidden" width={width} flexShrink={0}>
      <Box height={topPadding} width={width} flexShrink={0} />
      <Box
        flexDirection="row"
        height={messageAreaHeight}
        overflow="hidden"
        width={width}
        flexShrink={0}
      >
        <ChatLineList lines={metrics.visibleLines} contentWidth={contentWidth} height={messageAreaHeight} findQuery={findQuery ?? ''} findIndex={findIndex} selectedMessageIndex={findQuery ? findMatchMessageIndexes[findIndex] : undefined} />
        {width >= 2 && <Box width={1} height={messageAreaHeight} flexShrink={0} />}
        {showScrollbar && (
          <Scrollbar
            metrics={scrollbarMetrics}
            onOffsetChange={onScrollOffsetChange ?? (() => {})}
          />
        )}
        {showScrollbar && width >= 4 && <Box width={1} height={messageAreaHeight} flexShrink={0} />}
      </Box>
      {showJumpIndicator && metrics.hasNewer && (
        <Box flexShrink={0} height={1} width={width} justifyContent="center">
          <Text color={COLORS.accent}>↓ New messages</Text>
        </Box>
      )}
      {(findActive || findQuery) && <Box height={1}><Text color={COLORS.highlight}>Find: {findActive ? findQuery || 'type to search' : `${findMatchMessageIndexes.length ? findIndex + 1 : 0}/${findMatchMessageIndexes.length}`}  Enter to search · Esc to close · n/N next/previous</Text></Box>}
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

