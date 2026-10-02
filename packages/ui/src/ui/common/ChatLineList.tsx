import React from 'react';
import { Box, Text } from '@dynatrader/ink/terminal';
import type { DisplayLine } from '../../utils/chatViewport.js';

interface ChatLineListProps {
  lines: DisplayLine[];
  contentWidth: number;
  height: number;
  findQuery?: string;
  findIndex?: number;
  selectedMessageIndex?: number;
}

/**
 * Renders a fixed window of pre-wrapped display lines.
 *
 * Each line is forced to height 1 with flexShrink 0 so Yoga cannot compress
 * multi-line message trees into overlapping terminal rows (the clumping bug).
 */
function ChatLineListComponent({ lines, contentWidth, height, findQuery = '', findIndex = 0, selectedMessageIndex }: ChatLineListProps) {
  let matchIndex = -1;
  return (
    <Box
      flexDirection="column"
      height={height}
      width={contentWidth}
      overflow="hidden"
      flexShrink={0}
    >
      {lines.map((line) => (
        (() => {
          const matches = Boolean(findQuery && line.text.toLocaleLowerCase().includes(findQuery.toLocaleLowerCase()));
          if (matches) matchIndex++;
          const selected = matches && (selectedMessageIndex === undefined ? matchIndex === findIndex : line.messageIndex === selectedMessageIndex);
          return (
        <Box key={line.key} height={1} width={contentWidth} flexShrink={0} overflow="hidden">
          <Text
            color={selected ? 'black' : matches ? 'yellow' : line.color as any}
            backgroundColor={selected ? 'yellow' : undefined}
            bold={line.bold}
            dimColor={line.dim}
            italic={line.italic}
            wrap="truncate"
          >
            {line.text.length > 0 ? line.text : ' '}
          </Text>
        </Box>
          );
        })()
      ))}
    </Box>
  );
}

export const ChatLineList = React.memo(ChatLineListComponent, (prev, next) => {
  return (
    prev.lines === next.lines &&
    prev.contentWidth === next.contentWidth &&
    prev.height === next.height
    && prev.findQuery === next.findQuery
    && prev.findIndex === next.findIndex
    && prev.selectedMessageIndex === next.selectedMessageIndex
  );
});

