import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { Box, Text } from '@dynatrader/ink/terminal';
import { ChatMessageItem } from './ChatMessageItem.js';
import type { Message, MessagePart } from '../types.js';

vi.mock('./MarkdownRenderer.js', () => ({
  MarkdownRenderer: vi.fn(({ content }: { content: string }) => {
    return React.createElement(Text, {}, content);
  }),
}));

/**
 * Deep-render a React element tree by expanding function components.
 */
function renderDeep(element: any): any {
  if (typeof element === 'string' || typeof element === 'number') {
    return element;
  }
  if (!element || typeof element !== 'object') return element;

  if (typeof element.type === 'function') {
    const rendered = element.type(element.props);
    return renderDeep(rendered);
  }

  const children = element.props?.children;
  let renderedChildren: any;
  if (Array.isArray(children)) {
    renderedChildren = children.map(renderDeep);
  } else if (children && typeof children === 'object') {
    renderedChildren = renderDeep(children);
  } else {
    renderedChildren = children;
  }

  return {
    ...element,
    props: {
      ...element.props,
      children: renderedChildren,
    },
  };
}

/** Recursively find all elements matching a given type in a React element tree */
function findByType(element: any, type: any): any[] {
  const results: any[] = [];
  if (!element || typeof element !== 'object') return results;
  if (element.type === type) results.push(element);
  const children = element.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      results.push(...findByType(child, type));
    }
  } else if (children && typeof children === 'object') {
    results.push(...findByType(children, type));
  }
  return results;
}

/** Find elements by a custom predicate */
function findAll(element: any, predicate: (el: any) => boolean): any[] {
  const results: any[] = [];
  if (!element || typeof element !== 'object') return results;
  if (predicate(element)) results.push(element);
  const children = element.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      results.push(...findAll(child, predicate));
    }
  } else if (children && typeof children === 'object') {
    results.push(...findAll(children, predicate));
  }
  return results;
}

/** Extract text content from a React element tree */
function getTextContent(element: any): string {
  if (typeof element === 'string' || typeof element === 'number') {
    return String(element);
  }
  if (!element || typeof element !== 'object') return '';
  const children = element.props?.children;
  if (Array.isArray(children)) {
    return children.map(getTextContent).join('');
  }
  return getTextContent(children);
}

function createMessage(
  role: Message['role'],
  content: string,
  overrides?: Partial<Message>
): Message {
  return {
    id: 'test-msg',
    role,
    content,
    timestamp: new Date(),
    ...overrides,
  };
}

describe('ChatMessageItem - Thinking Block Rendering', () => {
  describe('compact thinking block rendering', () => {
    it('renders compact "≈ Thinking..." header for assistant thinking parts', () => {
      const parts: MessagePart[] = [
        { type: 'thinking', text: 'This is the thinking content that should be compact.' },
        { type: 'text', text: 'Final response' },
      ];
      const message: Message = {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Final response',
        parts,
        timestamp: new Date(),
      };

      const result = ChatMessageItem({ message, contentWidth: 80, showThinking: true });
      const texts = findByType(result, Text).map(getTextContent).join(' ');

      expect(texts).toContain('Thinking');
      expect(texts).toContain('≈');
    });

    it('truncates thinking content preview to 500 chars max', () => {
      const longThinkingText = 'x'.repeat(600);
      const parts: MessagePart[] = [
        { type: 'thinking', text: longThinkingText },
        { type: 'text', text: 'Response' },
      ];
      const message: Message = {
        id: 'assistant-2',
        role: 'assistant',
        content: 'Response',
        parts,
        timestamp: new Date(),
      };

      const result = ChatMessageItem({ message, contentWidth: 80, showThinking: true });
      const texts = findByType(result, Text).map(getTextContent).join('');

      // Should contain truncated content (500 chars + ellipsis)
      expect(texts.length).toBeLessThan(longThinkingText.length + 100);
      expect(texts).toContain('...');
    });

    it('shows thinking content only when showThinking is true', () => {
      const parts: MessagePart[] = [
        { type: 'thinking', text: 'Hidden thinking content' },
        { type: 'text', text: 'Visible response' },
      ];
      const message: Message = {
        id: 'assistant-3',
        role: 'assistant',
        content: 'Visible response',
        parts,
        timestamp: new Date(),
      };

      // When showThinking is false, thinking content should not be visible
      const resultHidden = ChatMessageItem({ message, contentWidth: 80, showThinking: false });
      const hiddenTexts = findByType(resultHidden, Text).map(getTextContent).join(' ');

      // Should still show the thinking indicator but not the content
      expect(hiddenTexts).not.toContain('Hidden thinking content');
    });

    it('renders thinking content inline with proper indentation', () => {
      const parts: MessagePart[] = [
        { type: 'thinking', text: 'Thinking step by step' },
        { type: 'text', text: 'Answer' },
      ];
      const message: Message = {
        id: 'assistant-4',
        role: 'assistant',
        content: 'Answer',
        parts,
        timestamp: new Date(),
      };

      const result = ChatMessageItem({ message, contentWidth: 80, showThinking: true });

      // Check that thinking block exists with proper structure
      const thinkingBlocks = findAll(result, (el) => {
        const texts = findByType(el, Text);
        return texts.some((t: any) => getTextContent(t).includes('Thinking'));
      });

      expect(thinkingBlocks.length).toBeGreaterThan(0);
    });
  });

  describe('thinking block duplication prevention', () => {
    it('does not render duplicate thinking blocks when both assistant parts and thinking role exist', () => {
      // Create assistant message with thinking parts
      const assistantParts: MessagePart[] = [
        { type: 'thinking', text: 'Assistant thinking' },
        { type: 'text', text: 'Response' },
      ];
      const assistantMessage: Message = {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Response',
        parts: assistantParts,
        timestamp: new Date(),
      };

      // Create separate thinking role message
      const thinkingMessage: Message = {
        id: 'thinking-1',
        role: 'thinking',
        content: 'Separate thinking',
        timestamp: new Date(),
      };

      // Render assistant message
      const assistantResult = ChatMessageItem({
        message: assistantMessage,
        contentWidth: 80,
        showThinking: true,
      });
      const assistantTexts = findByType(assistantResult, Text).map(getTextContent).join(' ');

      // Render thinking message in chat mode (should be compact or hidden)
      const thinkingResult = ChatMessageItem({
        message: thinkingMessage,
        contentWidth: 80,
        showThinking: false,
        isTranscriptMode: false,
      });

      // Thinking message should not render when showThinking is false
      expect(thinkingResult).toBe(null);
    });

    it('shows full thinking content in transcript mode', () => {
      const message: Message = {
        id: 'thinking-1',
        role: 'thinking',
        content: 'Full thinking content for transcript',
        timestamp: new Date(),
      };

      const result = ChatMessageItem({ message, contentWidth: 80, isTranscriptMode: true });
      const texts = findByType(result, Text).map(getTextContent).join(' ');

      expect(texts).toContain('Thinking:');
      expect(texts).toContain('Full thinking content for transcript');
    });

    it('shows compact thinking indicator in chat mode', () => {
      const message: Message = {
        id: 'thinking-2',
        role: 'thinking',
        content: 'Long thinking content',
        preview: 'Quick preview',
        timestamp: new Date(),
      };

      const result = ChatMessageItem({
        message,
        contentWidth: 80,
        isTranscriptMode: false,
        showThinking: true,
      });
      const texts = findByType(result, Text).map(getTextContent).join(' ');

      expect(texts).toContain('Thinking');
      expect(texts).toContain('Quick preview');
      expect(texts).not.toContain('Long thinking content');
    });
  });
});

describe('ChatMessageItem - Tool Block Rendering', () => {
  it('renders tool calls with status indicators', () => {
    const message: Message = {
      id: 'tool-1',
      role: 'tool',
      toolName: 'bash',
      content: 'npm install',
      status: 'completed',
      timestamp: new Date(),
    };

    const result = ChatMessageItem({ message, contentWidth: 80 });
    const texts = findByType(result, Text).map(getTextContent).join(' ');

    expect(texts).toContain('[done]');
    expect(texts).toContain('bash');
    expect(texts).toContain('npm install');
  });

  it('renders tool with pending status', () => {
    const message: Message = {
      id: 'tool-2',
      role: 'tool',
      toolName: 'bash',
      content: 'running command',
      status: 'pending',
      timestamp: new Date(),
    };

    const result = ChatMessageItem({ message, contentWidth: 80 });
    const texts = findByType(result, Text).map(getTextContent).join(' ');

    expect(texts).toContain('[running]');
  });

  it('renders tool with error status', () => {
    const message: Message = {
      id: 'tool-3',
      role: 'tool',
      toolName: 'bash',
      content: 'failed command',
      status: 'error',
      timestamp: new Date(),
    };

    const result = ChatMessageItem({ message, contentWidth: 80 });
    const texts = findByType(result, Text).map(getTextContent).join(' ');

    expect(texts).toContain('[error]');
  });

  it('renders tool calls with proper status indicators', () => {
    const message: Message = {
      id: 'tool-status',
      role: 'tool',
      toolName: 'write',
      content: 'Writing file',
      status: 'completed',
      timestamp: new Date(),
    };

    const result = ChatMessageItem({ message, contentWidth: 80 });
    const texts = findByType(result, Text).map(getTextContent).join(' ');

    expect(texts).toContain('[done]');
    expect(texts).toContain('write');
  });

  it('renders shell output with stdout and stderr', () => {
    const toolArtifact = {
      kind: 'shell_output' as const,
      stdout: 'Command output line 1\nCommand output line 2',
      stderr: 'Error output',
    };

    const message: Message = {
      id: 'tool-6',
      role: 'tool',
      toolName: 'bash',
      content: 'npm test',
      toolArtifact,
      timestamp: new Date(),
    };

    const result = ChatMessageItem({ message, contentWidth: 80 });
    const texts = findByType(result, Text).map(getTextContent).join(' ');

    expect(texts).toContain('Command output');
    expect(texts).toContain('STDERR');
  });

  it('renders tool preview content', () => {
    const message: Message = {
      id: 'tool-7',
      role: 'tool',
      toolName: 'read',
      content: 'Reading file',
      preview: '/path/to/file.txt',
      timestamp: new Date(),
    };

    const result = ChatMessageItem({ message, contentWidth: 80 });
    const texts = findByType(result, Text).map(getTextContent).join(' ');

    expect(texts).toContain('[done]');
    expect(texts).toContain('read');
    expect(texts).toContain('/path/to/file.txt');
  });
});

describe('ChatMessageItem - Thinking Toggle Behavior', () => {
  it('toggles thinking content visibility with showThinking prop', () => {
    const parts: MessagePart[] = [
      { type: 'thinking', text: 'Toggle test content' },
      { type: 'text', text: 'Response' },
    ];
    const message: Message = {
      id: 'toggle-1',
      role: 'assistant',
      content: 'Response',
      parts,
      timestamp: new Date(),
    };

    // With showThinking=true
    const visibleResult = ChatMessageItem({ message, contentWidth: 80, showThinking: true });
    const visibleTexts = findByType(visibleResult, Text).map(getTextContent).join(' ');

    // With showThinking=false
    const hiddenResult = ChatMessageItem({ message, contentWidth: 80, showThinking: false });
    const hiddenTexts = findByType(hiddenResult, Text).map(getTextContent).join(' ');

    // Visible state should contain thinking indicator
    expect(visibleTexts).toContain('Thinking');

    // Hidden state should not contain thinking content
    expect(hiddenTexts).not.toContain('Toggle test content');
  });

  it('maintains thinking indicator visibility state consistently', () => {
    const parts: MessagePart[] = [
      { type: 'thinking', text: 'Consistent test' },
      { type: 'text', text: 'Answer' },
    ];
    const message: Message = {
      id: 'toggle-2',
      role: 'assistant',
      content: 'Answer',
      parts,
      timestamp: new Date(),
    };

    const result1 = ChatMessageItem({ message, contentWidth: 80, showThinking: true });
    const result2 = ChatMessageItem({ message, contentWidth: 80, showThinking: true });

    const texts1 = findByType(result1, Text).map(getTextContent).join(' ');
    const texts2 = findByType(result2, Text).map(getTextContent).join(' ');

    // Both renders should be identical
    expect(texts1).toBe(texts2);
  });
});

describe('ChatMessageItem - Transcript Mode', () => {
  it('shows all content in transcript mode', () => {
    const message: Message = {
      id: 'transcript-1',
      role: 'thinking',
      content: 'Full transcript content',
      timestamp: new Date(),
    };

    const result = ChatMessageItem({ message, contentWidth: 80, isTranscriptMode: true });
    const texts = findByType(result, Text).map(getTextContent).join(' ');

    expect(texts).toContain('Full transcript content');
  });

  it('displays thinking role messages with full content in transcript mode', () => {
    const message: Message = {
      id: 'transcript-2',
      role: 'thinking',
      content: 'Detailed reasoning steps for transcript',
      preview: 'preview',
      timestamp: new Date(),
    };

    const result = ChatMessageItem({ message, contentWidth: 80, isTranscriptMode: true });
    const texts = findByType(result, Text).map(getTextContent).join(' ');

    expect(texts).toContain('Detailed reasoning steps for transcript');
  });
});

describe('ChatMessageItem - System / command output', () => {
  it('renders multi-line system content as one Text row per line', () => {
    const message: Message = {
      id: 'sys-1',
      role: 'system',
      content: 'Available Commands:\n\nSystem:\n  /help       Show help',
      timestamp: new Date(),
      commandOutput: true,
    };

    const result = ChatMessageItem({ message, contentWidth: 80 });
    const texts = findByType(result, Text).map(getTextContent);

    // 4 lines from content (including blank) => 4 Text nodes
    expect(texts.length).toBe(4);
    expect(texts[0]).toContain('Available Commands:');
    expect(texts[2]).toContain('System:');
    expect(texts[3]).toContain('/help');
  });
});

