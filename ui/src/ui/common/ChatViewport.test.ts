import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { Text } from 'ink';
import { ChatViewportComponent, chatViewportPropsEqual } from './ChatViewport.js';
import { ChatLineList } from './ChatLineList.js';
import { Scrollbar } from './Scrollbar.js';
import { getChatViewportMetrics, getScrollbarMetrics } from '../../utils/chatViewport.js';

vi.mock('../../utils/chatViewport.js', () => ({
  getChatViewportMetrics: vi.fn(),
  getScrollbarMetrics: vi.fn(),
}));

vi.mock('./ChatLineList.js', () => ({
  ChatLineList: vi.fn(() => null),
}));

vi.mock('./Scrollbar.js', () => ({
  Scrollbar: vi.fn(() => null),
}));

// Mock useMemo to call the factory directly, bypassing the fiber context requirement.
// This lets the tests call the component as a plain function while still exercising
// the useMemo setup (factory logic and deps).
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof React>('react');
  return {
    ...actual,
    useMemo: (factory: () => any, _deps: any[]) => factory(),
  };
});

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

function mockMetrics(overrides: Record<string, unknown> = {}) {
  return {
    totalRows: 100,
    visibleMessages: [],
    visibleLines: [
      { key: 'l0', text: 'line 0', messageIndex: 0 },
      { key: 'l1', text: 'line 1', messageIndex: 0 },
    ],
    pageSize: 19,
    scrollOffset: 0,
    maxScrollOffset: 81,
    hasNewer: false,
    hasOlder: true,
    ...overrides,
  };
}

describe('ChatViewport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createMessages = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `msg-${i}`,
      role: 'user' as const,
      content: `Message ${i}`,
      timestamp: new Date(),
    }));

  it('renders visible display lines from metrics', () => {
    const allMessages = createMessages(50);
    const visibleLines = [
      { key: 'a', text: '> /help', messageIndex: 0, color: 'green', bold: true },
      { key: 'b', text: 'Available Commands:', messageIndex: 1, color: 'gray' },
    ];

    (getChatViewportMetrics as any).mockReturnValue(
      mockMetrics({
        visibleMessages: allMessages.slice(0, 2),
        visibleLines,
        pageSize: 20,
        totalRows: 2,
        maxScrollOffset: 0,
        hasOlder: false,
      })
    );

    (getScrollbarMetrics as any).mockReturnValue({
      show: false,
      height: 0,
      thumbPosition: 0,
      thumbHeight: 0,
      thumbTop: 0,
      trackHeight: 0,
    });

    const result = ChatViewportComponent({
      messages: allMessages,
      width: 80,
      height: 20,
      scrollOffset: 0,
    });

    const lineLists = findByType(result, ChatLineList);
    expect(lineLists).toHaveLength(1);
    expect(lineLists[0].props.lines).toBe(visibleLines);
    expect(lineLists[0].props.contentWidth).toBe(79);
    expect(lineLists[0].props.height).toBe(20); // height - bottomPadding (0)
  });

  it('shows jump-to-bottom indicator when scrolled up with newer messages', () => {
    const messages = createMessages(50);

    (getChatViewportMetrics as any).mockReturnValue(
      mockMetrics({ hasNewer: true, hasOlder: true, scrollOffset: 10 })
    );

    (getScrollbarMetrics as any).mockReturnValue({
      show: true,
      height: 19,
      thumbPosition: 5,
      thumbHeight: 4,
      thumbTop: 5,
      trackHeight: 19,
    });

    const result = ChatViewportComponent({
      messages,
      width: 80,
      height: 20,
      scrollOffset: 10,
    });

    const texts = findByType(result, Text);
    const textContents = texts.map(getTextContent).join(' ');
    expect(textContents).toContain('New messages');
    // Does not show old "older messages" / "newer messages" text
    expect(textContents).not.toContain('older messages');
  });

  it('does not show scrollbar when content fits', () => {
    const messages = createMessages(5);

    (getChatViewportMetrics as any).mockReturnValue(
      mockMetrics({
        totalRows: 10,
        visibleMessages: messages,
        pageSize: 19,
        maxScrollOffset: 0,
        hasOlder: false,
      })
    );

    (getScrollbarMetrics as any).mockReturnValue({
      show: false,
      height: 0,
      thumbPosition: 0,
      thumbHeight: 0,
      thumbTop: 0,
      trackHeight: 0,
    });

    const result = ChatViewportComponent({
      messages,
      width: 80,
      height: 20,
      scrollOffset: 0,
    });

    const scrollbars = findByType(result, Scrollbar);
    expect(scrollbars).toHaveLength(0);
  });

  it('renders scrollbar when metrics say show', () => {
    const messages = createMessages(50);

    (getChatViewportMetrics as any).mockReturnValue(mockMetrics());

    (getScrollbarMetrics as any).mockReturnValue({
      show: true,
      height: 10,
      thumbPosition: 0,
      thumbHeight: 5,
      thumbTop: 0,
      trackHeight: 10,
    });

    const result = ChatViewportComponent({
      messages,
      width: 80,
      height: 20,
      scrollOffset: 0,
    });

    const scrollbars = findByType(result, Scrollbar);
    expect(scrollbars).toHaveLength(1);
  });

  it('shows welcome screen when no messages', () => {
    const result = ChatViewportComponent({
      messages: [],
      width: 80,
      height: 20,
      scrollOffset: 0,
    });

    expect(getChatViewportMetrics).not.toHaveBeenCalled();
    expect(result).toBeTruthy();

    const texts = findByType(result, Text);
    const textContents = texts.map(getTextContent).join(' ');
    expect(textContents).toContain('DynaMind Terminal');
    expect(textContents).toContain('Type a message to start chatting');
    expect(textContents).toContain('Ctrl+K');
    expect(textContents).toContain('slash commands');
    expect(textContents).toContain('keyboard shortcuts');
  });

  it('does not show jump-to-bottom indicator when at bottom', () => {
    const messages = createMessages(50);

    (getChatViewportMetrics as any).mockReturnValue(
      mockMetrics({ hasNewer: false, hasOlder: true, scrollOffset: 0 })
    );

    (getScrollbarMetrics as any).mockReturnValue({
      show: true,
      height: 19,
      thumbPosition: 5,
      thumbHeight: 4,
      thumbTop: 5,
      trackHeight: 19,
    });

    const result = ChatViewportComponent({
      messages,
      width: 80,
      height: 20,
      scrollOffset: 0,
    });

    const texts = findByType(result, Text);
    const textContents = texts.map(getTextContent).join(' ');
    expect(textContents).not.toContain('New messages');
  });

  it('passes effective bottomPadding (with indicator reserve) to metrics when scrolled up', () => {
    const messages = createMessages(3);

    (getChatViewportMetrics as any).mockReturnValue(
      mockMetrics({ totalRows: 6, maxScrollOffset: 5, hasNewer: true, scrollOffset: 2 })
    );
    (getScrollbarMetrics as any).mockReturnValue({
      show: false,
      height: 0,
      thumbPosition: 0,
      thumbHeight: 0,
      thumbTop: 0,
      trackHeight: 0,
    });

    ChatViewportComponent({
      messages,
      width: 80,
      height: 20,
      scrollOffset: 2,
      showThinking: true,
      bottomPadding: 1,
    });

    // bottomPadding 1 + 1 for indicator = 2
    expect(getChatViewportMetrics).toHaveBeenCalledWith(messages, 80, 20, 2, 2, true);
  });

  it('passes showThinking and bottomPadding to metrics', () => {
    const messages = createMessages(3);

    (getChatViewportMetrics as any).mockReturnValue(
      mockMetrics({ totalRows: 6, maxScrollOffset: 0, hasOlder: false })
    );
    (getScrollbarMetrics as any).mockReturnValue({
      show: false,
      height: 0,
      thumbPosition: 0,
      thumbHeight: 0,
      thumbTop: 0,
      trackHeight: 0,
    });

    ChatViewportComponent({
      messages,
      width: 80,
      height: 20,
      scrollOffset: 0,
      showThinking: false,
      bottomPadding: 1,
    });

    expect(getChatViewportMetrics).toHaveBeenCalledWith(messages, 80, 20, 1, 0, false);

    ChatViewportComponent({
      messages,
      width: 80,
      height: 20,
      scrollOffset: 0,
      showThinking: true,
      bottomPadding: 2,
    });

    expect(getChatViewportMetrics).toHaveBeenCalledWith(messages, 80, 20, 2, 0, true);
  });

  it('chatViewportPropsEqual compares relevant fields', () => {
    const messages = createMessages(2);
    const base = {
      messages,
      width: 80,
      height: 20,
      scrollOffset: 0,
      showThinking: true,
      bottomPadding: 1,
      onScrollOffsetChange: undefined as undefined | ((n: number) => void),
    };

    expect(chatViewportPropsEqual(base, { ...base })).toBe(true);
    expect(chatViewportPropsEqual(base, { ...base, scrollOffset: 1 })).toBe(false);
    expect(chatViewportPropsEqual(base, { ...base, width: 100 })).toBe(false);
  });
});
