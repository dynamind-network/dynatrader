import React from 'react';
import { Box, Text } from '@dynatrader/ink/terminal';
import type { Message, MessageRole, ToolArtifact } from '../types.js';
import { MarkdownRenderer } from './MarkdownRenderer.js';
import { DiffRenderer } from './DiffRenderer.js';
import { WriteArtifactRenderer } from './WriteArtifactRenderer.js';
import { Sparkline } from '../screens/Sparkline.js';
import { createSymbolPattern } from './marketSymbols.js';

interface MessageBubbleProps {
  message: Message;
  contentWidth?: number;
  isStreaming?: boolean;
}

const ROLE_COLORS: Record<MessageRole, string> = {
  user: 'green',
  assistant: 'white',
  system: 'yellow',
  tool: 'gray',
  thinking: 'cyan',
};

const ROLE_PREFIXES: Record<MessageRole, string> = {
  user: '>',
  assistant: '',
  system: '[system]',
  tool: '',
  thinking: 'thinking',
};

const SYMBOL_PATTERN = createSymbolPattern();

function detectSymbols(content: string): string[] {
  const matches = content.match(SYMBOL_PATTERN);
  if (!matches) return [];
  return [...new Set(matches.map((s) => s.toUpperCase()))];
}

function generateMockSparklineData(seed: string): number[] {
  const data: number[] = [];
  let value = 100;
  for (let i = 0; i < 20; i++) {
    const hash = seed.charCodeAt(i % seed.length) + i * 7;
    const change = (hash % 10) - 4;
    value += change;
    data.push(value);
  }
  return data;
}

export function MessageBubble({ message, contentWidth, isStreaming = false }: MessageBubbleProps) {
  const roleColor = ROLE_COLORS[message.role] || 'white';
  const prefix = ROLE_PREFIXES[message.role] || '';

  if (message.role === 'user') {
    return (
      <Box marginBottom={1}>
        <Text color={roleColor}>
          {prefix} {message.content}
          {isStreaming && <Text color="yellow">▊</Text>}
        </Text>
      </Box>
    );
  }

  if (message.role === 'assistant') {
    const symbols = detectSymbols(message.content);
    return (
      <Box marginBottom={1} flexDirection="column">
        <MarkdownRenderer content={message.content} />
        {symbols.length > 0 && (
          <Box flexDirection="row" marginTop={1} gap={2}>
            {symbols.map((symbol) => (
              <Box key={symbol} flexDirection="column">
                <Text color="yellow" bold>
                  {symbol}
                </Text>
                <Sparkline data={generateMockSparklineData(symbol)} width={16} color="auto" />
              </Box>
            ))}
          </Box>
        )}
        {isStreaming && (
          <Box marginTop={0}>
            <Text color="yellow" dimColor>
              ▊
            </Text>
          </Box>
        )}
      </Box>
    );
  }

  if (message.role === 'tool') {
    const statusColor =
      message.status === 'error' ? 'red' : message.status === 'pending' ? 'yellow' : 'gray';

    return (
      <Box marginBottom={1} flexDirection="column">
        <Text color="white">{message.toolName || 'tool'}</Text>
        <Text color={statusColor} dimColor={message.status !== 'pending'}>
          {`└── ${message.preview || message.content}`}
        </Text>
        {message.toolArtifact && (
          <ToolArtifactRenderer artifact={message.toolArtifact} contentWidth={contentWidth} />
        )}
      </Box>
    );
  }

  if (message.role === 'thinking') {
    return (
      <Box marginBottom={1}>
        <Text color="cyan" italic>
          {isStreaming ? '💭 Thinking...' : '≈ Thinking...'}
        </Text>
        {message.preview && <Text dimColor>{` (${message.preview})`}</Text>}
      </Box>
    );
  }

  return (
    <Box marginBottom={1}>
      <Text color={roleColor}>{message.content}</Text>
    </Box>
  );
}

function ToolArtifactRenderer({
  artifact,
  contentWidth,
}: {
  artifact: ToolArtifact;
  contentWidth?: number;
}) {
  switch (artifact.kind) {
    case 'diff':
      return <DiffRenderer artifact={artifact} maxWidth={contentWidth} />;
    case 'write':
      return <WriteArtifactRenderer artifact={artifact} maxWidth={contentWidth} />;
    case 'position-card':
      return <PositionCardArtifact artifact={artifact} />;
    case 'order-preview':
      return <OrderPreviewArtifact artifact={artifact} />;
    case 'chart-preview':
      return <ChartPreviewArtifact artifact={artifact} />;
    default:
      return null;
  }
}

interface PositionCardArtifact {
  kind: 'position-card';
  symbol: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
  leverage: number;
  liquidationPrice?: number;
}

interface OrderPreviewArtifact {
  kind: 'order-preview';
  symbol: string;
  side: 'buy' | 'sell';
  orderType: 'market' | 'limit';
  size: number;
  price?: number;
  totalValue: number;
  fees: number;
  slippage?: number;
}

interface ChartPreviewArtifact {
  kind: 'chart-preview';
  symbol: string;
  timeframe: string;
  data: string;
}

function PositionCardArtifact({ artifact }: { artifact: PositionCardArtifact }) {
  const pnlColor = artifact.pnl >= 0 ? 'green' : 'red';
  const sideColor = artifact.side === 'long' ? 'green' : 'red';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1} marginTop={1}>
      <Box>
        <Text bold color="white">
          {artifact.symbol}
        </Text>
        <Text color="gray"> </Text>
        <Text color={sideColor}>{artifact.side.toUpperCase()}</Text>
        <Text color="gray"> </Text>
        <Text dimColor>{artifact.leverage}x</Text>
      </Box>
      <Box>
        <Text color="gray">Size: </Text>
        <Text>{artifact.size}</Text>
      </Box>
      <Box>
        <Text color="gray">Entry: </Text>
        <Text>${artifact.entryPrice.toFixed(2)}</Text>
        <Text color="gray"> | Current: </Text>
        <Text>${artifact.currentPrice.toFixed(2)}</Text>
      </Box>
      <Box>
        <Text color="gray">PnL: </Text>
        <Text color={pnlColor}>
          ${artifact.pnl.toFixed(2)} ({artifact.pnlPercent.toFixed(2)}%)
        </Text>
      </Box>
      {artifact.liquidationPrice && (
        <Box>
          <Text color="gray">Liq: </Text>
          <Text color="red">${artifact.liquidationPrice.toFixed(2)}</Text>
        </Box>
      )}
    </Box>
  );
}

function OrderPreviewArtifact({ artifact }: { artifact: OrderPreviewArtifact }) {
  const sideColor = artifact.side === 'buy' ? 'green' : 'red';

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={sideColor}
      paddingX={1}
      marginTop={1}
    >
      <Box>
        <Text bold color="white">
          {artifact.symbol}
        </Text>
        <Text color="gray"> </Text>
        <Text color={sideColor}>
          {artifact.side.toUpperCase()} {artifact.orderType.toUpperCase()}
        </Text>
      </Box>
      <Box>
        <Text color="gray">Size: </Text>
        <Text>{artifact.size}</Text>
      </Box>
      {artifact.price && (
        <Box>
          <Text color="gray">Price: </Text>
          <Text>${artifact.price.toFixed(2)}</Text>
        </Box>
      )}
      <Box>
        <Text color="gray">Total: </Text>
        <Text>${artifact.totalValue.toFixed(2)}</Text>
      </Box>
      <Box>
        <Text color="gray">Fees: </Text>
        <Text>${artifact.fees.toFixed(2)}</Text>
        {artifact.slippage !== undefined && (
          <>
            <Text color="gray"> | Slippage: </Text>
            <Text color="yellow">{artifact.slippage.toFixed(2)}%</Text>
          </>
        )}
      </Box>
    </Box>
  );
}

function ChartPreviewArtifact({ artifact }: { artifact: ChartPreviewArtifact }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginTop={1}>
      <Box>
        <Text bold>{artifact.symbol}</Text>
        <Text dimColor> {artifact.timeframe}</Text>
      </Box>
      <Box>
        <Text color="cyan">{artifact.data}</Text>
      </Box>
    </Box>
  );
}

