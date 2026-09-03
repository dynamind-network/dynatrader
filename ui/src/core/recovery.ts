import type { Message, ContentBlock } from './types.js';

/**
 * Strip thinking blocks from conversation messages.
 * Used during recovery to reduce context size by removing thinking content.
 */
export function stripThinkingBlocks(messages: Message[]): Message[] {
  return messages.map((msg) => {
    if (Array.isArray(msg.content)) {
      return {
        ...msg,
        content: msg.content.filter((block: ContentBlock) => block.type !== 'thinking'),
      };
    }
    return msg;
  });
}
