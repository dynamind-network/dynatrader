import React, { useMemo } from 'react';
import { Box, Text } from '@dynatrader/ink/terminal';
import { COLORS, GLYPHS, SPACING } from '../design/tokens.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import type { Message } from '../types.js';
import { MouseRegion } from '../input/MouseInputProvider.js';

interface TimelineSidebarProps {
  messages: Message[];
  width: number;
  height: number;
  selectedIndex?: number;
  onSelect?: (index: number, messageIndex?: number) => void;
}

interface TurnSummary {
  index: number;
  role: 'user' | 'assistant' | 'system';
  preview: string;
  timestamp?: Date;
  tokenEstimate: number;
  hasToolUse: boolean;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function getPreview(msg: Message): string {
  const content = msg.content as any;
  if (typeof content === 'string') {
    return content.slice(0, 50).replace(/\n/g, ' ');
  }
  if (Array.isArray(content)) {
    const textBlock = content.find((b: any) => b.type === 'text');
    if (textBlock && 'text' in textBlock) {
      return textBlock.text.slice(0, 50).replace(/\n/g, ' ');
    }
    const toolBlock = content.find((b: any) => b.type === 'tool_use');
    if (toolBlock && 'name' in toolBlock) {
      return `[tool: ${toolBlock.name}]`;
    }
  }
  return '...';
}

function sumTokens(msg: Message): number {
  const content = msg.content as any;
  if (typeof content === 'string') return estimateTokens(content);
  if (Array.isArray(content)) {
    return content.reduce((sum: number, block: any) => {
      if (block.type === 'text' && block.text) return sum + estimateTokens(block.text);
      if (block.type === 'tool_result' && block.content) return sum + estimateTokens(String(block.content));
      return sum;
    }, 0);
  }
  return 0;
}

function hasToolUse(msg: Message): boolean {
  const content = msg.content as any;
  if (!Array.isArray(content)) return false;
  return content.some((b: any) => b.type === 'tool_use');
}

export function TimelineSidebar({
  messages,
  width,
  height,
  selectedIndex = -1,
  onSelect,
}: TimelineSidebarProps) {
  const turns = useMemo(() => {
    const result: TurnSummary[] = [];
    let idx = 0;
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'system' && !msg.commandOutput) continue;
      result.push({
        index: i,
        role: msg.role as 'user' | 'assistant' | 'system',
        preview: getPreview(msg),
        timestamp: msg.timestamp,
        tokenEstimate: sumTokens(msg),
        hasToolUse: hasToolUse(msg),
      });
      idx++;
    }
    return result;
  }, [messages]);

  const visibleCount = Math.max(1, height - 4);
  const startIdx = Math.max(0, Math.min(selectedIndex - Math.floor(visibleCount / 2), turns.length - visibleCount));
  const visibleTurns = turns.slice(startIdx, startIdx + visibleCount);

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="single"
      borderColor={COLORS.borderAccent}
    >
      <Box paddingX={SPACING.xs} paddingY={0}>
        <Text bold color={COLORS.accent}>
          Timeline ({turns.length} turns)
        </Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {visibleTurns.map((turn, vi) => {
          const globalIdx = startIdx + vi;
          const isSelected = globalIdx === selectedIndex;
          const roleIcon =
            turn.role === 'user'
              ? '▸'
              : turn.role === 'assistant'
                ? turn.hasToolUse
                  ? '◆'
                  : '◈'
                : '•';
          const roleColor =
            turn.role === 'user'
              ? COLORS.highlight
              : turn.role === 'assistant'
                ? COLORS.accent
                : COLORS.muted;

          return (
            <MouseRegion
              key={`${turn.index}-${vi}`}
              flexDirection="row"
              flexGrow={0}
              onClick={() => onSelect?.(globalIdx, turn.index)}
              onWheel={(direction) => {
                if (direction === 'up') onSelect?.(Math.max(0, globalIdx - 1));
                if (direction === 'down') onSelect?.(Math.min(turns.length - 1, globalIdx + 1));
              }}
            >
              <Box paddingX={SPACING.xs} paddingY={0} flexDirection="row">
                <Text color={isSelected ? COLORS.warning : roleColor} bold={isSelected}>
                  {isSelected ? '>' : ' '} {roleIcon}{' '}
                </Text>
                <Text color={isSelected ? COLORS.primary : COLORS.muted} dimColor={!isSelected} wrap="truncate">
                  {turn.preview || '...'}
                </Text>
              </Box>
            </MouseRegion>
          );
        })}
      </Box>

      <Box paddingX={SPACING.xs} paddingY={0}>
        <Text color={COLORS.muted} dimColor>
          {GLYPHS.separator} {turns.length > 0 ? `${turns.reduce((s, t) => s + t.tokenEstimate, 0)} tok` : 'empty'}
        </Text>
      </Box>
    </Box>
  );
}

