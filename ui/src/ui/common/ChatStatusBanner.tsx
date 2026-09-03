import React from 'react';
import { Box, Text } from 'ink';
import { COLORS, GLYPHS, SPACING } from '../design/tokens.js';
import { Spinner } from '../design/Spinner.js';

type ApprovalState = 'pending' | 'approved' | 'denied';

interface ChatStatusBannerProps {
  position: 'top' | 'bottom';
  terminalWidth?: number;
  compact?: boolean;
  pendingApprovalToolName?: string;
  approvalState?: ApprovalState;
  toolDescription?: string;
  toolArguments?: string;
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
  queuedMessages: string[];
}

const MAX_VISIBLE_QUEUE_MESSAGES = 2;
const QUEUE_PREVIEW_WIDTH = 42;
const MIN_QUESTION_BOX_WIDTH = 56;
const MAX_QUESTION_BOX_WIDTH = 96;

function getMaxContentWidth(terminalWidth?: number): number {
  const available =
    typeof terminalWidth === 'number' ? Math.max(48, terminalWidth - 6) : MAX_QUESTION_BOX_WIDTH;
  return Math.max(MIN_QUESTION_BOX_WIDTH, Math.min(MAX_QUESTION_BOX_WIDTH, available));
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

  return Math.min(maxContentWidth, maxLineLength + 4);
}

function truncatePreview(value: string, maxLength = QUEUE_PREVIEW_WIDTH): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function buildQueuedMessagePreviewLines(queuedMessages: string[]): string[] {
  const visibleMessages = queuedMessages.slice(0, MAX_VISIBLE_QUEUE_MESSAGES);
  const lines = visibleMessages.map(
    (message, index) => `${index + 1}. ${truncatePreview(message)}`
  );

  if (queuedMessages.length > MAX_VISIBLE_QUEUE_MESSAGES) {
    lines.push(`+${queuedMessages.length - MAX_VISIBLE_QUEUE_MESSAGES} more`);
  }

  return lines;
}

export function ChatStatusBanner({
  position,
  terminalWidth,
  compact = false,
  pendingApprovalToolName,
  approvalState = 'pending',
  toolDescription,
  toolArguments,
  pendingQuestion,
  selectedQuestionIndex = 0,
  isProcessing,
  queuedMessages,
}: ChatStatusBannerProps) {
  const maxWidth = getMaxContentWidth(terminalWidth);

  if (position === 'top') {
    if (compact && pendingApprovalToolName) {
      return (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Text color="yellow" bold>
            {pendingApprovalToolName}
          </Text>
          <Text dimColor>(y/n)</Text>
        </Box>
      );
    }

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

      return (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={approvalBadge.color}
          paddingX={1}
          paddingY={0}
          width={maxWidth}
        >
          <Text color={approvalBadge.color} bold>
            {GLYPHS.separator} Approval needed: {pendingApprovalToolName} {GLYPHS.separator}{' '}
            {approvalBadge.text}
          </Text>
          {toolDescription && (
            <Text dimColor>
              {'  '}Description: {toolDescription}
            </Text>
          )}
          {toolArguments && (
            <Text dimColor>
              {'  '}Arguments: {toolArguments}
            </Text>
          )}
          <Text dimColor>Press y to approve, n to deny</Text>
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

      {queuePreviewLines.map((line) => (
        <Text key={line} dimColor>
          {line}
        </Text>
      ))}

      {!isProcessing && queuedMessages.length > 0 && (
        <Text dimColor>Esc stops the current turn.</Text>
      )}
    </Box>
  );
}
