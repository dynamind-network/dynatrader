import { startTransition, useCallback, useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { AgentEvent } from '../../core/types.js';
import type { Message, ToolArtifact } from '../types.js';
import {
  createMessageId,
  summarizeToolInput,
  summarizeToolOutput,
  getToolArtifact,
  extractCodeBlocks,
} from '../utils/chatHelpers.js';

/**
 * Options for the timeline event handler.
 */
interface TimelineHandlerOpts {
  /** Append a new message to the chat. */
  appendChatMessage: (message: Message) => void;
  /** Update an existing message by ID. */
  updateChatMessage: (messageId: string, updater: (message: Message) => Message) => void;
  /** Ref for the current agent run ID. */
  activeRunIdRef: React.MutableRefObject<string | null>;
  /** Ref for the active thinking message ID. */
  activeThinkingMessageIdRef: React.MutableRefObject<string | null>;
  /** Ref for the active thinking content. */
  activeThinkingContentRef: React.MutableRefObject<string | null>;
  /** Ref mapping toolName -> pending message IDs. */
  pendingToolMessageIdsRef: React.MutableRefObject<Map<string, string[]>>;
}

/**
 * Hook that creates a stable handleTimelineEvent callback and syncs it
 * to the provided ref.
 *
 * Extracted from App.tsx to reduce the main component size.
 */
export function useTimelineEventHandler(
  options: TimelineHandlerOpts & {
    /** Ref that should always point to the latest handler. */
    handleTimelineEventRef: React.MutableRefObject<(event: AgentEvent) => void>;
  }
): void {
  const {
    appendChatMessage,
    updateChatMessage,
    activeRunIdRef,
    activeThinkingMessageIdRef,
    activeThinkingContentRef,
    pendingToolMessageIdsRef,
  } = options;

  const handleTimelineEvent = useCallback(
    (event: AgentEvent) => {
      startTransition(() => {
        switch (event.type) {
          case 'thinking': {
            activeRunIdRef.current = createMessageId();
            if (event.content === 'Processing...') {
              activeThinkingMessageIdRef.current = null;
              activeThinkingContentRef.current = null;
              return;
            }

            activeThinkingContentRef.current = null;
            const preview = 'Thinking…';
            if (activeThinkingMessageIdRef.current) {
              updateChatMessage(activeThinkingMessageIdRef.current, (message) => ({
                ...message,
                content: 'Thinking…',
                preview,
                timestamp: new Date(),
              }));
              return;
            }

            const messageId = createMessageId();
            activeThinkingMessageIdRef.current = messageId;
            appendChatMessage({
              id: messageId,
              role: 'thinking',
              content: 'Thinking…',
              preview,
              timestamp: new Date(),
              runId: activeRunIdRef.current,
            });
            return;
          }
          case 'tool_start': {
            const runId = activeRunIdRef.current ?? createMessageId();
            activeRunIdRef.current = runId;
            const messageId = createMessageId();
            const pendingIds = pendingToolMessageIdsRef.current.get(event.toolName) ?? [];
            pendingIds.push(messageId);
            pendingToolMessageIdsRef.current.set(event.toolName, pendingIds);
            appendChatMessage({
              id: messageId,
              role: 'tool',
              content: event.toolName,
              toolName: event.toolName,
              preview: summarizeToolInput(event.input),
              inputPreview: summarizeToolInput(event.input),
              timestamp: new Date(),
              status: 'pending',
              runId,
            });
            return;
          }
          case 'tool_end': {
            const pendingIds = pendingToolMessageIdsRef.current.get(event.toolName) ?? [];
            const messageId = pendingIds.shift();
            if (pendingIds.length > 0) {
              pendingToolMessageIdsRef.current.set(event.toolName, pendingIds);
            } else {
              pendingToolMessageIdsRef.current.delete(event.toolName);
            }
            if (messageId) {
              updateChatMessage(messageId, (message) => ({
                ...message,
                status: event.result.success ? 'completed' : 'error',
                resultPreview: summarizeToolOutput(event.result.output),
                toolArtifact: event.result.success
                  ? getToolArtifact(event.toolName, event.result.artifacts)
                  : undefined,
                timestamp: new Date(),
              }));
            }
            return;
          }
          case 'text': {
            appendChatMessage({ role: 'system', content: event.content, timestamp: new Date() });
            return;
          }
          case 'partial': {
            // Streaming partial updates — the partial event carries the FULL
            // accumulated text so far. We don't create messages here because
            // the final 'done' event will handle the complete response with
            // proper code block extraction. This handler exists for future
            // real-time streaming UI support.
            return;
          }
          case 'error': {
            activeThinkingMessageIdRef.current = null;
            activeThinkingContentRef.current = null;
            appendChatMessage({
              role: 'system',
              content: `Error: ${event.error}`,
              timestamp: new Date(),
              commandOutput: true,
            });
            return;
          }
          case 'done': {
            const thinkingMessageId = activeThinkingMessageIdRef.current;
            const thinkingContent = activeThinkingContentRef.current;
            activeThinkingMessageIdRef.current = null;
            activeThinkingContentRef.current = null;
            activeRunIdRef.current = null;
            pendingToolMessageIdsRef.current.clear();
            if (event.finalResponse) {
              // CRITICAL FIX: Extract code blocks from the response to prevent
              // mixing display text with generation payload. Code blocks are
              // emitted as separate artifact messages.
              const { textParts, codeBlocks } = extractCodeBlocks(event.finalResponse);

              // Emit explanation text as regular assistant message
              if (textParts) {
                if (thinkingMessageId) {
                  updateChatMessage(thinkingMessageId, (message) => ({
                    ...message,
                    hidden: true,
                  }));
                }

                appendChatMessage({
                  role: 'assistant',
                  content: textParts,
                  parts: [
                    ...(thinkingContent
                      ? [{ type: 'thinking' as const, text: thinkingContent }]
                      : []),
                    { type: 'text' as const, text: textParts },
                  ],
                  timestamp: new Date(),
                });
              }

              // Emit each code block as a write artifact
              for (const block of codeBlocks) {
                appendChatMessage({
                  role: 'assistant',
                  content: `\`\`\`${block.language}\n${block.code}\n\`\`\``,
                  timestamp: new Date(),
                  toolArtifact: {
                    kind: 'write',
                    path: block.suggestedPath,
                    contents: block.code,
                    isNewFile: true,
                  },
                });
              }

              // If there was no text and no code blocks, fall back to raw content
              if (!textParts && codeBlocks.length === 0) {
                appendChatMessage({
                  role: 'assistant',
                  content: event.finalResponse,
                  timestamp: new Date(),
                });
              }
            } else {
              appendChatMessage({
                role: 'system',
                content: 'The model finished without a visible response.',
                timestamp: new Date(),
              });
            }
            return;
          }
          default:
            return;
        }
      });
    },
    [
      appendChatMessage,
      updateChatMessage,
      activeRunIdRef,
      activeThinkingMessageIdRef,
      activeThinkingContentRef,
      pendingToolMessageIdsRef,
    ]
  );

  const handleTimelineEventRef = useRef<(event: AgentEvent) => void>(() => {});
  useEffect(() => {
    handleTimelineEventRef.current = handleTimelineEvent;
  }, [handleTimelineEvent]);

  // Sync to the caller-provided ref
  const { handleTimelineEventRef: callerRef } = options;
  useEffect(() => {
    callerRef.current = handleTimelineEvent;
  }, [handleTimelineEvent, callerRef]);
}
