import { Box, Text } from '@dynatrader/ink/terminal';
import React, { useEffect, useState } from 'react';
import { Spinner } from '../design/Spinner.js';
import { COLORS, GLYPHS, SPACING } from '../design/tokens.js';
import type { QueuedPrompt } from '../hooks/useState/useUIState.js';
import { MouseRegion } from '../input/MouseInputProvider.js';

type ApprovalState = 'pending' | 'approved' | 'denied';

interface ChatStatusBannerProps {
  position: 'top' | 'bottom';
  terminalWidth?: number;
  terminalHeight?: number;
  compact?: boolean;
  pendingApprovalToolName?: string;
  pendingApprovalInput?: Record<string, unknown>;
  pendingApprovalReason?: string;
  approvalState?: ApprovalState;
  toolDescription?: string;
  toolArguments?: string;
  onApprovalSelect?: (choice: number) => void;
  pendingQuestion?: {
    question: string;
    options: Array<{
      label: string;
      value: string;
      description?: string;
    }>;
    allowCustomText?: boolean;
  };
  selectedQuestionIndex?: number;
  isProcessing: boolean;
  queuedMessages: QueuedPrompt[];
  onEditQueuedMessage?: (id: string) => void;
  onRemoveQueuedMessage?: (id: string) => void;
  onRetryQueuedMessage?: (id: string) => void;
}

const MAX_VISIBLE_QUEUE_MESSAGES = 2;
const QUEUE_PREVIEW_WIDTH = 42;
const MAX_QUESTION_BOX_WIDTH = 96;

function getMaxContentWidth(terminalWidth?: number): number {
  const available =
    typeof terminalWidth === 'number' ? Math.max(8, terminalWidth - 4) : MAX_QUESTION_BOX_WIDTH;
  return Math.min(MAX_QUESTION_BOX_WIDTH, available);
}

export function getApprovalLayout(terminalWidth: number, terminalHeight: number) {
  const compact = terminalWidth < 76 || terminalHeight < 15;
  return {
    compact,
    width: compact ? Math.max(1, terminalWidth) : getMaxContentWidth(terminalWidth),
    detailRows: Math.max(0, Math.min(4, terminalHeight - 17)),
  };
}

function calculateQuestionBoxWidth(
  question: string,
  options: Array<{ label: string; description?: string }>,
  terminalWidth?: number,
  allowCustomText?: boolean
): number {
  const maxContentWidth = getMaxContentWidth(terminalWidth);
  let maxLineLength = question.length;

  for (let i = 0; i < options.length; i += 1) {
    const optionLine = `${i + 1}. ${options[i].label}${options[i].description ? ` — ${options[i].description}` : ''}`;
    maxLineLength = Math.max(maxLineLength, optionLine.length);
  }

  if (allowCustomText) {
    maxLineLength = Math.max(maxLineLength, '5. Other (type your own)'.length);
  }

  maxLineLength += 2;
  maxLineLength = Math.max(
    maxLineLength,
    'Type a number, use arrows, or press Enter. Esc cancels.'.length
  );

  return Math.min(maxContentWidth, Math.max(8, maxLineLength + 4));
}

function truncatePreview(value: string, maxLength = QUEUE_PREVIEW_WIDTH): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function buildQueuedMessagePreviewLines(queuedMessages: Array<string | QueuedPrompt>): string[] {
  const visibleMessages = queuedMessages.slice(0, MAX_VISIBLE_QUEUE_MESSAGES);
  const lines = visibleMessages.map(
    (message, index) => `${index + 1}. ${truncatePreview(typeof message === 'string' ? message : message.text)}`
  );

  if (queuedMessages.length > MAX_VISIBLE_QUEUE_MESSAGES) {
    lines.push(`+${queuedMessages.length - MAX_VISIBLE_QUEUE_MESSAGES} more`);
  }

  return lines;
}

export function ChatStatusBanner({
  position,
  terminalWidth,
  terminalHeight,
  compact = false,
  pendingApprovalToolName,
  pendingApprovalInput,
  pendingApprovalReason,
  approvalState = 'pending',
  toolDescription,
  toolArguments,
  onApprovalSelect,
  pendingQuestion,
  selectedQuestionIndex = 0,
  isProcessing,
  queuedMessages,
  onEditQueuedMessage,
  onRemoveQueuedMessage,
  onRetryQueuedMessage,
}: ChatStatusBannerProps) {
  const maxWidth = getMaxContentWidth(terminalWidth);
  const [detailsOffset, setDetailsOffset] = useState(0);
  const [showCompactDetails, setShowCompactDetails] = useState(false);
  useEffect(() => {
    setDetailsOffset(0);
    setShowCompactDetails(false);
  }, [pendingApprovalToolName]);

  if (position === 'top') {
    if (pendingQuestion) {
      const { question, options, allowCustomText } = pendingQuestion;
      const questionWidth = calculateQuestionBoxWidth(
        question,
        options,
        terminalWidth,
        allowCustomText
      );

      return (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="cyan"
          paddingX={1}
          width={questionWidth}
        >
          <Text color="cyan" bold>
            {question}
          </Text>
          <Box flexDirection="column" marginTop={1}>
            {options.map((option, index) => {
              const isSelected = index === selectedQuestionIndex;
              const radio = isSelected ? GLYPHS.radioSelected : GLYPHS.radio;
              return (
                <Text
                  key={`${option.value}-${index}`}
                  color={isSelected ? COLORS.highlight : undefined}
                  bold={isSelected}
                  dimColor={!isSelected}
                >
                  {radio} {`${option.label}${option.description ? ` — ${option.description}` : ''}`}
                </Text>
              );
            })}
            {allowCustomText &&
              (() => {
                const isSelected = options.length === selectedQuestionIndex;
                const radio = isSelected ? GLYPHS.radioSelected : GLYPHS.radio;
                return (
                  <Text
                    color={isSelected ? COLORS.highlight : undefined}
                    bold={isSelected}
                    dimColor={!isSelected}
                  >
                    {radio} Other (type your own)
                  </Text>
                );
              })()}
          </Box>
          <Text dimColor>Type a number, use arrows, or press Enter. Esc cancels.</Text>
        </Box>
      );
    }

    if (pendingApprovalToolName) {
      const approvalBadge =
        approvalState === 'approved'
          ? { text: '[APPROVED]', color: COLORS.success }
          : approvalState === 'denied'
            ? { text: '[DENIED]', color: COLORS.error }
            : { text: '[PENDING]', color: COLORS.warning };

      const details = [toolDescription || pendingApprovalReason, toolArguments || formatApprovalInput(pendingApprovalInput)]
        .filter((value): value is string => Boolean(value))
        .flatMap((value) => wrapText(value, Math.max(12, maxWidth - 6)));
      const approvalLayout = getApprovalLayout(terminalWidth ?? 80, terminalHeight ?? 30);
      const { compact, width: approvalWidth, detailRows } = approvalLayout;
      const visibleDetails = details.slice(detailsOffset, detailsOffset + Math.max(1, detailRows));

      return (
        <Box
          flexDirection="column"
          borderStyle={compact ? undefined : 'single'}
          borderColor={approvalBadge.color}
          paddingX={compact ? 0 : 1}
          width={approvalWidth}
        >
          <Text color={approvalBadge.color} bold>
            {GLYPHS.separator} Permission request: {pendingApprovalToolName} {GLYPHS.separator}{' '}
            {approvalBadge.text}
          </Text>
          {details.length > 0 && (detailRows > 0 ? (
            <MouseRegion
              onWheel={(direction) => setDetailsOffset((offset) => Math.max(0, Math.min(details.length - detailRows, offset + (direction === 'up' ? -1 : direction === 'down' ? 1 : 0))))}
            >
              <Box flexDirection="column" height={detailRows} overflow="hidden">
                {visibleDetails.map((line, index) => <Text key={`${detailsOffset}-${index}`} dimColor wrap="truncate">{line}</Text>)}
              </Box>
            </MouseRegion>
          ) : compact && showCompactDetails ? (
            <MouseRegion
              onClick={() => setShowCompactDetails(false)}
              onWheel={(direction) => setDetailsOffset((offset) => Math.max(0, Math.min(details.length - 1, offset + (direction === 'up' ? -1 : direction === 'down' ? 1 : 0))))}
            >
              <Text dimColor wrap="truncate">{visibleDetails[0]} · scroll for more / click back</Text>
            </MouseRegion>
          ) : compact ? (
            <MouseRegion onClick={() => setShowCompactDetails(true)} onWheel={() => setShowCompactDetails(true)}>
              <Text dimColor wrap="truncate">Request details · click or scroll to inspect</Text>
            </MouseRegion>
          ) : null)}
          {compact && showCompactDetails ? (
            <MouseRegion flexDirection="row" flexGrow={0} onClick={() => setShowCompactDetails(false)} onWheel={() => setShowCompactDetails(false)}>
              <Text dimColor>Scroll for approval choices</Text>
            </MouseRegion>
          ) : (
            <Box flexDirection="column" marginTop={1}>
              <MouseRegion flexDirection="row" flexGrow={0} onClick={() => onApprovalSelect?.(1)}><Text bold color={approvalState === 'pending' ? COLORS.highlight : COLORS.muted}>1 (●) {compact ? 'Always approve' : 'Yes, and don\'t ask again (always-approve mode)'}</Text></MouseRegion>
              <MouseRegion flexDirection="row" flexGrow={0} onClick={() => onApprovalSelect?.(2)}><Text dimColor>2 (○) {compact ? 'Proceed once' : 'Yes, proceed once'}</Text></MouseRegion>
              <MouseRegion flexDirection="row" flexGrow={0} onClick={() => onApprovalSelect?.(3)}><Text dimColor>3 (○) {compact ? 'Reject' : 'No, reject (type to add feedback)'}</Text></MouseRegion>
            </Box>
          )}
          <Text dimColor wrap="truncate">{compact ? '1/2/3 select · Esc cancel' : '1/2/3: select  |  Ctrl+o: auto mode  |  Ctrl+c: cancel'}</Text>
        </Box>
      );
    }

    return null;
  }

  if (!isProcessing && queuedMessages.length === 0) {
    return null;
  }

  const queuePreviewLines = buildQueuedMessagePreviewLines(queuedMessages);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={COLORS.border}
      paddingX={1}
      paddingY={0}
      width={maxWidth}
    >
      <Text dimColor>
        {queuedMessages.length > 0
          ? `${GLYPHS.separator} Queued ${queuedMessages.length} message${queuedMessages.length === 1 ? '' : 's'}${isProcessing ? ' waiting to run' : ' ready to send'}.`
          : `${GLYPHS.separator} Press Enter to queue the next message. Esc stops the current turn.`}
      </Text>

      {isProcessing && (
        <Box flexDirection="row" alignItems="center" gap={SPACING.xs}>
          <Spinner running={isProcessing} color={COLORS.thinking} label="Processing" />
        </Box>
      )}

      {queuedMessages.slice(0, MAX_VISIBLE_QUEUE_MESSAGES).map((message, index) => (
        <Box key={message.id} flexDirection="row" alignItems="center" width={maxWidth}>
          <MouseRegion flexDirection="row" flexGrow={1} onClick={() => onEditQueuedMessage?.(message.id)}>
            <Text
              color={message.status === 'failed' ? COLORS.error : undefined}
              dimColor={message.status === 'sending'}
              wrap="truncate"
            >
              {index + 1}. {message.status === 'sending' ? '[sending] ' : message.status === 'failed' ? '[failed] ' : ''}
              {truncatePreview(message.text, Math.max(12, QUEUE_PREVIEW_WIDTH - 12))} · click to edit
            </Text>
          </MouseRegion>
          {message.status === 'failed' && onRetryQueuedMessage && (
            <MouseRegion onClick={() => onRetryQueuedMessage(message.id)}>
              <Text color={COLORS.warning}> retry </Text>
            </MouseRegion>
          )}
          {message.status !== 'sending' && onRemoveQueuedMessage && (
            <MouseRegion onClick={() => onRemoveQueuedMessage(message.id)}>
              <Text dimColor> × </Text>
            </MouseRegion>
          )}
        </Box>
      ))}
      {queuePreviewLines.length === 0 && queuedMessages[0]?.status === 'sending' && (
        <Text dimColor>Sending queued prompt…</Text>
      )}
      {queuedMessages[0]?.error && (
        <Text color={COLORS.error} wrap="truncate">{queuedMessages[0].error}</Text>
      )}

      {!isProcessing && queuedMessages.length > 0 && (
        <Text dimColor>Esc stops the current turn.</Text>
      )}
    </Box>
  );
}

function formatApprovalInput(input?: Record<string, unknown>): string {
  if (!input) return '';
  const preferred = input.command ?? input.path ?? input.file_path ?? input.url ?? input.task;
  if (typeof preferred === 'string') return preferred.replace(/\s+/g, ' ');
  return Object.keys(input).length ? JSON.stringify(input) : '';
}

export function wrapText(value: string, width: number): string[] {
  const lines: string[] = [];
  for (const sourceLine of value.split(/\r?\n/)) {
    let line = '';
    for (const word of sourceLine.split(/\s+/)) {
      if (!word) continue;
      if (word.length > width) {
        if (line) lines.push(line);
        line = '';
        for (let index = 0; index < word.length; index += width) lines.push(word.slice(index, index + width));
      } else if (line && line.length + word.length + 1 > width) {
        lines.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line || sourceLine === '') lines.push(line);
  }
  return lines;
}

