import { describe, it, expect } from 'vitest';
import { stripThinkingBlocks } from '../src/core/recovery.js';
import type { Message, ContentBlock } from '../src/core/types.js';

function mkAssistant(blocks: ContentBlock[]): Message {
  return { role: 'assistant', content: blocks };
}

describe('stripThinkingBlocks', () => {
  it('strips thinking blocks from array-content messages', () => {
    const messages: Message[] = [
      mkAssistant([
        { type: 'thinking', text: 'Let me consider this' },
        { type: 'text', text: 'Final answer' },
      ]),
    ];
    const result = stripThinkingBlocks(messages);
    expect(result[0].content).toEqual([{ type: 'text', text: 'Final answer' }]);
  });

  it('removes every thinking block in a content array', () => {
    const messages: Message[] = [
      mkAssistant([
        { type: 'thinking', text: 'first' },
        { type: 'text', text: 'visible' },
        { type: 'thinking', text: 'second' },
      ]),
    ];
    const result = stripThinkingBlocks(messages);
    expect(result[0].content).toEqual([{ type: 'text', text: 'visible' }]);
  });

  it('leaves string-content messages untouched', () => {
    const messages: Message[] = [{ role: 'user', content: 'plain string' }];
    const result = stripThinkingBlocks(messages);
    expect(result[0]).toBe(messages[0]);
    expect(result[0].content).toBe('plain string');
  });

  it('returns an empty content array when only thinking blocks exist', () => {
    const messages: Message[] = [mkAssistant([{ type: 'thinking', text: 'only thinking' }])];
    const result = stripThinkingBlocks(messages);
    expect(result[0].content).toEqual([]);
  });

  it('preserves other block types and their order', () => {
    const messages: Message[] = [
      mkAssistant([
        { type: 'thinking', text: 'hidden' },
        { type: 'text', text: 't' },
        { type: 'tool_use', id: '1', name: 'read', input: { path: 'a.ts' } },
        { type: 'tool_result', tool_use_id: '1', content: 'file contents' },
      ]),
    ];
    const result = stripThinkingBlocks(messages);
    expect(result[0].content).toEqual([
      { type: 'text', text: 't' },
      { type: 'tool_use', id: '1', name: 'read', input: { path: 'a.ts' } },
      { type: 'tool_result', tool_use_id: '1', content: 'file contents' },
    ]);
  });

  it('handles multiple messages with mixed content types', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      mkAssistant([{ type: 'thinking', text: 'hmm' }, { type: 'text', text: 'ok' }]),
      { role: 'user', content: 'another string' },
    ];
    const result = stripThinkingBlocks(messages);
    expect(result[0].content).toBe('hello');
    expect(result[1].content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(result[2].content).toBe('another string');
  });

  it('handles an empty message list', () => {
    expect(stripThinkingBlocks([])).toEqual([]);
  });

  it('does not mutate the original messages or blocks', () => {
    const thinking: ContentBlock = { type: 'thinking', text: 'hidden' };
    const text: ContentBlock = { type: 'text', text: 'visible' };
    const messages: Message[] = [mkAssistant([thinking, text])];
    stripThinkingBlocks(messages);
    expect(messages[0].content).toEqual([thinking, text]);
  });
});