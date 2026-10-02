import React, { useMemo } from 'react';
import { Box, Static } from '@dynatrader/ink/terminal';
import type { Message } from '../types.js';
import { ChatMessageItem } from './ChatMessageItem.js';

interface ChatMessageListProps {
  messages: Message[];
  contentWidth?: number;
  showThinking?: boolean;
  isTranscriptMode?: boolean;
}

/**
 * Determines if a message is finalized (will never change again).
 *
 * A message is finalized when:
 *  - Its role is not 'assistant' (user, tool, thinking, system messages are
 *    appended to the array only after they are complete), OR
 *  - It IS an assistant message but is NOT the most recent assistant message
 *    in the array (i.e. a newer assistant message exists, meaning this one
 *    finished streaming before the next turn started).
 *
 * The one message that is NOT finalized is the latest assistant message --
 * it may still be receiving streaming deltas via message.delta events.
 */
function isMessageFinalized(
  message: Message,
  index: number,
  allMessages: Message[]
): boolean {
  if (message.role !== 'assistant') return true;

  // Find the index of the last assistant message in the array.
  let lastAssistantIdx = -1;
  for (let i = allMessages.length - 1; i >= 0; i--) {
    if (allMessages[i].role === 'assistant') {
      lastAssistantIdx = i;
      break;
    }
  }

  // The last assistant message is the live / streaming one.
  return index !== lastAssistantIdx;
}

/**
 * Stable key for a message used as a <Static> item.
 * Prefer the message id; fall back to a composite that is unique across the
 * finalized set (role + timestamp is guaranteed unique within a session).
 */
function messageKey(message: Message): string {
  return message.id ?? `${message.role}-${message.timestamp.toISOString()}`;
}

function ChatMessageListComponent({
  messages,
  contentWidth,
  showThinking = true,
  isTranscriptMode = false,
}: ChatMessageListProps) {
  // Partition messages into finalized (static) and live (normal render tree).
  const { finalized, live } = useMemo(() => {
    const f: Message[] = [];
    const l: Message[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (isMessageFinalized(msg, i, messages)) {
        f.push(msg);
      } else {
        l.push(msg);
      }
    }
    return { finalized: f, live: l };
  }, [messages]);

  return (
    <Box flexDirection="column">
      {/* Finalized messages are rendered once via <Static> and never
          re-rendered, even when newer messages arrive or streaming state
          changes. This avoids the O(n) re-render cost on every update. */}
      <Static items={finalized}>
        {(message) => (
          <ChatMessageItem
            key={messageKey(message)}
            message={message}
            contentWidth={contentWidth}
            showThinking={showThinking}
            isTranscriptMode={isTranscriptMode}
          />
        )}
      </Static>

      {/* Live / streaming messages stay in the normal React tree so they
          can re-render as content changes (e.g. text deltas, status updates). */}
      {live.map((message) => (
        <ChatMessageItem
          key={messageKey(message)}
          message={message}
          contentWidth={contentWidth}
          showThinking={showThinking}
          isTranscriptMode={isTranscriptMode}
        />
      ))}
    </Box>
  );
}

// Memoize the component to prevent re-renders when messages haven't changed
export const ChatMessageList = React.memo(ChatMessageListComponent, (prev, next) => {
  return (
    prev.messages === next.messages &&
    prev.contentWidth === next.contentWidth &&
    prev.showThinking === next.showThinking &&
    prev.isTranscriptMode === next.isTranscriptMode
  );
});

