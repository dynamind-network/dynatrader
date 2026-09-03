import { useCallback } from 'react';
import type { Message } from '../types.js';
import { createMessageId } from '../utils/chatHelpers.js';

/**
 * Provides message mutation helpers for the chat.
 */
export function useChatMessageHelpers(
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>
) {
  const appendChatMessage = useCallback(
    (message: Message) => {
      setMessages((prev) => [...prev, { ...message, id: message.id ?? createMessageId() }]);
    },
    [setMessages]
  );

  const updateChatMessage = useCallback(
    (messageId: string, updater: (message: Message) => Message) => {
      setMessages((prev) =>
        prev.map((message) => (message.id === messageId ? updater(message) : message))
      );
    },
    [setMessages]
  );

  return { appendChatMessage, updateChatMessage };
}
