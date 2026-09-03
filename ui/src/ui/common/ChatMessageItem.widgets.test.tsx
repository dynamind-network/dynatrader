import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { Box, Text } from 'ink';
import { ChatMessageItem } from './ChatMessageItem.js';
import type { Message, MessagePart } from '../types.js';

vi.mock('./MarkdownRenderer.js', () => ({
  MarkdownRenderer: vi.fn(({ content }: { content: string }) => {
    return React.createElement(Text, { content }, content);
  }),
}));

interface RenderOpts {
  contentWidth?: number;
  isTranscriptMode?: boolean;
  showThinking?: boolean;
}

function render(message: Message, opts: RenderOpts = {}) {
  return TestRenderer.create(
    React.createElement(ChatMessageItem, {
      message,
      contentWidth: opts.contentWidth ?? 80,
      isTranscriptMode: opts.isTranscriptMode,
      showThinking: opts.showThinking,
    })
  );
}

/** Recursively collect all rendered text leaves from the host tree */
function collectText(node: any): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  const children = node.children;
  if (!children) return '';
  if (Array.isArray(children)) return children.map(collectText).join('');
  return collectText(children);
}

function textLeaves(renderer: TestRenderer.ReactTestRenderer): string[] {
  return [collectText(renderer.toJSON())];
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return collectText(renderer.toJSON()).trim();
}

function createMessage(role: Message['role'], content: string, toolArtifact?: any): Message {
  return {
    id: 'test-msg',
    role,
    content,
    timestamp: new Date(),
    toolArtifact,
  };
}

describe('ChatMessageItem widgets', () => {
  it('renders full thinking content in transcript mode', () => {
    const message = createMessage(
      'thinking',
      'Inspect provider response formats and keep reasoning separate.'
    );
    const root = render(message, { isTranscriptMode: true });

    const texts = allText(root);
    expect(texts).toContain('Thinking:');
    expect(texts).toContain('Inspect provider response formats');
  });

  it('renders compact preview for thinking messages in chat mode', () => {
    const message: Message = {
      id: 'think-1',
      role: 'thinking',
      content: 'Very long hidden reasoning content that should not fully render in chat mode.',
      preview: 'Inspecting providers',
      timestamp: new Date(),
    };
    const root = render(message, { isTranscriptMode: false });

    const texts = allText(root);
    expect(texts).toContain('Thinking');
    expect(texts).toContain('Inspecting providers');
    expect(texts).not.toContain('Very long hidden reasoning content');
  });

  it('renders assistant thinking block when enabled', () => {
    const parts: MessagePart[] = [
      { type: 'thinking', text: 'Inspect providers and parse reasoning fields.' },
      { type: 'text', text: 'Final answer' },
    ];
    const message: Message = {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Final answer',
      parts,
      timestamp: new Date(),
    };

    const root = render(message, { showThinking: true });
    const texts = allText(root);

    expect(texts).toContain('Thinking');
    expect(texts).toContain('Inspect providers');
    expect(textLeaves(root).length).toBeGreaterThan(0);
  });

  it('hides assistant thinking block when disabled', () => {
    const parts: MessagePart[] = [
      { type: 'thinking', text: 'This should be hidden in normal chat.' },
      { type: 'text', text: 'Final answer' },
    ];
    const message: Message = {
      id: 'assistant-2',
      role: 'assistant',
      content: 'Final answer',
      parts,
      timestamp: new Date(),
    };

    const root = render(message, { showThinking: false });
    const texts = allText(root);
    const rendered = textLeaves(root);

    expect(texts).not.toContain('Thinking');
    expect(rendered).not.toContain('This should be hidden in normal chat.');
    expect(rendered).toContain('Final answer');
  });

  it('renders sparkline row when assistant message mentions symbols', () => {
    const message = createMessage('assistant', 'BTC is looking bullish today');
    const root = render(message);

    const rowBoxes = root.root.findAll(
      (n) => n.type === Box && n.props?.flexDirection === 'row' && n.props?.marginTop === 1
    );
    expect(rowBoxes.length).toBeGreaterThan(0);

    const texts = textLeaves(root);
    expect(texts.some((t: string) => t.includes('BTC'))).toBe(true);
  });

  it('renders multiple sparklines for multiple symbols', () => {
    const message = createMessage('assistant', 'BTC and ETH are both up, SOL is flat');
    const root = render(message);

    const texts = textLeaves(root);
    expect(texts.some((t: string) => t.includes('BTC'))).toBe(true);
    expect(texts.some((t: string) => t.includes('ETH'))).toBe(true);
    expect(texts.some((t: string) => t.includes('SOL'))).toBe(true);
  });

  it('does not render sparklines for user messages', () => {
    const message = createMessage('user', 'What about BTC?');
    const root = render(message);

    const rowBoxes = root.root.findAll(
      (n) => n.type === Box && n.props?.flexDirection === 'row' && n.props?.marginTop === 1
    );
    expect(rowBoxes.length).toBe(0);
  });

  it('does not render sparklines when no symbols are mentioned', () => {
    const message = createMessage('assistant', 'The market looks stable today');
    const root = render(message);

    const rowBoxes = root.root.findAll(
      (n) => n.type === Box && n.props?.flexDirection === 'row' && n.props?.marginTop === 1
    );
    expect(rowBoxes.length).toBe(0);
  });

  it('renders position card artifact inline', () => {
    const artifact = {
      kind: 'position-card' as const,
      symbol: 'BTC',
      side: 'long' as const,
      size: 1.5,
      entryPrice: 45000,
      currentPrice: 47000,
      pnl: 3000,
      pnlPercent: 6.67,
      leverage: 10,
      liquidationPrice: 40500,
    };
    const message = createMessage('tool', 'Position loaded', artifact);
    const root = render(message);

    const positionCards = root.root.findAll((n) => {
      return typeof n.type === 'function' && (n.type as any).name === 'PositionCardInline';
    });
    expect(positionCards.length).toBe(1);
    expect(positionCards[0].props.artifact.symbol).toBe('BTC');
    expect(positionCards[0].props.artifact.side).toBe('long');
  });
});
