import React, { useCallback, useMemo, useState } from 'react';
import { Box, Text, useInput } from '@dynatrader/ink/terminal';
import type { Message } from '../types.js';
import { ChatLineList } from '../common/ChatLineList.js';
import { Scrollbar } from '../common/Scrollbar.js';
import {
  getChatViewportMetrics,
  getMessageRenderWidth,
  getScrollbarMetrics,
  clampScrollOffset,
} from '../../utils/chatViewport.js';

interface TranscriptScreenProps {
  messages: Message[];
  width: number;
  height: number;
  showAll: boolean;
  onScroll: (offset: number) => void;
}

export function TranscriptScreen({
  messages,
  width,
  height,
  showAll,
  onScroll,
}: TranscriptScreenProps) {
  const [scrollOffset, setScrollOffset] = useState(0);

  const visibleMessages = useMemo(
    () => (showAll ? messages : messages.slice(-100)),
    [messages, showAll]
  );

  const metrics = useMemo(
    () => getChatViewportMetrics(visibleMessages, width, height, 3, scrollOffset, true),
    [visibleMessages, width, height, scrollOffset]
  );

  const scrollbarMetrics = useMemo(
    () =>
      getScrollbarMetrics(
        metrics.totalRows,
        metrics.pageSize,
        metrics.scrollOffset,
        metrics.maxScrollOffset
      ),
    [metrics.totalRows, metrics.pageSize, metrics.scrollOffset, metrics.maxScrollOffset]
  );

  const handleScroll = useCallback(
    (newOffset: number) => {
      const clamped = clampScrollOffset(newOffset, metrics.maxScrollOffset);
      setScrollOffset(clamped);
      onScroll(clamped);
    },
    [metrics.maxScrollOffset, onScroll]
  );

  useInput((input, key) => {
    if (key.escape) return;
    if (key.ctrl && input === 'e') return;

    if (key.upArrow) {
      handleScroll(scrollOffset + 1);
      return;
    }

    if (key.downArrow) {
      handleScroll(scrollOffset - 1);
      return;
    }

    if (key.pageUp) {
      handleScroll(scrollOffset + metrics.pageSize);
      return;
    }

    if (key.pageDown) {
      handleScroll(scrollOffset - metrics.pageSize);
      return;
    }

    if (input === '\u0001' || (key as any).home) {
      handleScroll(metrics.maxScrollOffset);
      return;
    }

    if ((key as any).end) {
      handleScroll(0);
    }
  });

  const showScrollbar = scrollbarMetrics.show && width >= 3;
  const contentWidth = getMessageRenderWidth(width);
  const scrollPercent =
    metrics.maxScrollOffset > 0 ? Math.round((scrollOffset / metrics.maxScrollOffset) * 100) : 100;
  // Header (1) + footer percent (2) reserved via bottomPadding=3 in metrics
  const messageAreaHeight = Math.max(1, height - 3);

  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      <Box justifyContent="space-between" marginBottom={1} flexShrink={0} height={1}>
        <Text bold color="cyan">
          Transcript
        </Text>
        <Text dimColor>
          {visibleMessages.length} messages · {showAll ? 'full history' : 'recent 100'} · Ctrl+O
          back · Ctrl+E {showAll ? 'recent' : 'full'}
        </Text>
      </Box>

      <Box flexDirection="row" height={messageAreaHeight} width={width} overflow="hidden" flexShrink={0}>
        <ChatLineList
          lines={metrics.visibleLines}
          contentWidth={contentWidth}
          height={messageAreaHeight}
        />
        {width >= 2 && <Box width={1} height={messageAreaHeight} flexShrink={0} />}
        {showScrollbar && <Scrollbar metrics={scrollbarMetrics} onOffsetChange={handleScroll} />}
        {showScrollbar && width >= 4 && <Box width={1} height={messageAreaHeight} flexShrink={0} />}
      </Box>

      {metrics.maxScrollOffset > 0 && (
        <Box marginTop={1}>
          <Text dimColor>
            {scrollPercent < 100 ? '▲ ' : ''}
            {scrollPercent}% scrolled
            {scrollPercent > 0 ? ' ▼' : ''}
          </Text>
        </Box>
      )}
    </Box>
  );
}

