import { describe, it, expect } from 'vitest';
import {
  clampScrollOffset,
  getChatViewportMetrics,
  getMessageRenderWidth,
  estimateMessageRows,
  estimateMessageHeight,
  expandWrappedLines,
  sliceContentFromTop,
  messagesToDisplayLines,
  getScrollbarMetrics,
} from '../src/utils/chatViewport.js';

describe('chatViewport utilities', () => {
  describe('clampScrollOffset', () => {
    it('returns 0 when offset is negative', () => {
      expect(clampScrollOffset(-5, 100)).toBe(0);
    });

    it('returns maxOffset when offset exceeds it', () => {
      expect(clampScrollOffset(150, 100)).toBe(100);
    });

    it('returns offset when within range', () => {
      expect(clampScrollOffset(50, 100)).toBe(50);
    });

    it('returns 0 when maxOffset is 0', () => {
      expect(clampScrollOffset(10, 0)).toBe(0);
    });
  });

  describe('getMessageRenderWidth', () => {
    it('reserves breathing room around the scrollbar gutter', () => {
      expect(getMessageRenderWidth(80)).toBe(77);
    });

    it('never exceeds the available width on narrow terminals', () => {
      expect(getMessageRenderWidth(10)).toBe(7);
      expect(getMessageRenderWidth(1)).toBe(1);
    });

    it('handles wide terminals', () => {
      expect(getMessageRenderWidth(200)).toBe(197);
    });
  });

  describe('estimateMessageRows', () => {
    it('returns 1 for short single-line content', () => {
      expect(estimateMessageRows('Hello', 80)).toBe(1);
    });

    it('returns multiple rows for content wider than viewport', () => {
      const longLine = 'a'.repeat(160);
      expect(estimateMessageRows(longLine, 80)).toBe(2);
    });

    it('counts newlines as separate rows', () => {
      const multiLine = 'line1\nline2\nline3';
      expect(estimateMessageRows(multiLine, 80)).toBe(3);
    });

    it('handles empty content', () => {
      expect(estimateMessageRows('', 80)).toBe(1);
    });

    it('strips markdown formatting chars before measuring', () => {
      // Without stripping, 80 asterisks would be 1 row at width 80
      // But we verify stripping happens by checking a case where markdown chars add length
      const withMarkdown = '**bold** __italic__ `code`';
      // After stripping: bold italic code (no extra chars from formatting)
      const strippedLength = 'bold italic code'.length; // ~16 chars
      // At width 10, stripped version is 2 rows, unstripped is 3 rows
      const withMarkdownRows = estimateMessageRows(withMarkdown, 10);
      expect(withMarkdownRows).toBe(Math.ceil(strippedLength / 10));
    });

    it('strips all markdown characters', () => {
      const content = '#header *[link](url)* _text_ `code` \\escape';
      // All markdown chars should be removed: # * [ ] ( ) _ ` \
      const rows = estimateMessageRows(content, 100);
      // After stripping, should fit in 1 row at width 100
      expect(rows).toBe(1);
    });
  });

  describe('getChatViewportMetrics', () => {
    const createMessage = (content: string, preview?: string) => ({
      content,
      timestamp: new Date(),
      ...(preview ? { preview } : {}),
    });

    it('returns totalRows for messages', () => {
      const messages = [createMessage('Hello'), createMessage('World')];
      const metrics = getChatViewportMetrics(messages, 80, 20, 1, 0);

      expect(metrics.totalRows).toBeGreaterThan(0);
    });

    it('returns pageSize equal to effective height', () => {
      const messages = [createMessage('Hello')];
      const metrics = getChatViewportMetrics(messages, 80, 20, 1, 0);

      expect(metrics.pageSize).toBe(19); // height - bottomPadding
    });

    it('returns maxScrollOffset of 0 when content fits', () => {
      const messages = [createMessage('Short')];
      const metrics = getChatViewportMetrics(messages, 80, 100, 1, 0);

      expect(metrics.maxScrollOffset).toBe(0);
    });

    it('returns positive maxScrollOffset when content overflows', () => {
      const messages = Array.from({ length: 50 }, (_, i) =>
        createMessage(`Message ${i} with some content`)
      );
      const metrics = getChatViewportMetrics(messages, 80, 20, 1, 0);

      expect(metrics.maxScrollOffset).toBeGreaterThan(0);
    });

    it('clamps scrollOffset to maxScrollOffset', () => {
      const messages = [createMessage('Short')];
      const metrics = getChatViewportMetrics(messages, 80, 20, 1, 999);

      expect(metrics.scrollOffset).toBe(metrics.maxScrollOffset);
    });

    it('returns hasNewer true when scrolled up', () => {
      const messages = Array.from({ length: 50 }, (_, i) => createMessage(`Message ${i}`));
      const metrics = getChatViewportMetrics(messages, 80, 20, 1, 10);

      expect(metrics.hasNewer).toBe(true);
    });

    it('returns hasNewer false when at bottom', () => {
      const messages = [createMessage('Short')];
      const metrics = getChatViewportMetrics(messages, 80, 20, 1, 0);

      expect(metrics.hasNewer).toBe(false);
    });

    it('returns hasOlder true when not at top', () => {
      const messages = Array.from({ length: 50 }, (_, i) => createMessage(`Message ${i}`));
      const maxOffset = getChatViewportMetrics(messages, 80, 20, 1, 0).maxScrollOffset;
      const metrics = getChatViewportMetrics(messages, 80, 20, 1, Math.max(0, maxOffset - 1));

      expect(metrics.hasOlder).toBe(true);
    });

    it('returns hasOlder false when at top', () => {
      const messages = Array.from({ length: 50 }, (_, i) => createMessage(`Message ${i}`));
      const maxOffset = getChatViewportMetrics(messages, 80, 20, 1, 0).maxScrollOffset;
      const metrics = getChatViewportMetrics(messages, 80, 20, 1, maxOffset);

      expect(metrics.hasOlder).toBe(false);
    });

    it('returns visibleMessages subset', () => {
      const messages = Array.from({ length: 50 }, (_, i) => createMessage(`Message ${i}`));
      const metrics = getChatViewportMetrics(messages, 80, 20, 1, 0);

      expect(metrics.visibleMessages.length).toBeGreaterThan(0);
      expect(metrics.visibleMessages.length).toBeLessThan(messages.length);
    });

    it('uses preview content when available for row calculation', () => {
      const messages = [
        {
          content: 'tool-name',
          preview: 'This is a longer preview text that takes more rows',
          timestamp: new Date(),
        },
      ];
      const metrics = getChatViewportMetrics(messages, 80, 20, 1, 0);

      // Should use preview for row calculation
      expect(metrics.totalRows).toBeGreaterThan(0);
    });

    it('uses collapsed preview for thinking messages when available', () => {
      const messages = [
        {
          role: 'thinking',
          content:
            'This is a much longer reasoning body that should not drive collapsed chat height.',
          preview: 'Inspecting providers',
          timestamp: new Date(),
        },
      ];

      const metrics = getChatViewportMetrics(messages, 40, 20, 1, 0);
      // Collapsed thinking renders as a single compact "≈ Thinking:" line
      expect(metrics.totalRows).toBe(1);
    });

    it('counts assistant thinking parts when thinking is visible', () => {
      const messages = [
        {
          role: 'assistant',
          content: 'Final answer',
          parts: [
            { type: 'thinking', text: 'Inspect providers' },
            { type: 'text', text: 'Final answer' },
          ],
          timestamp: new Date(),
        },
      ];

      const hidden = getChatViewportMetrics(messages, 40, 20, 1, 0, false);
      const shown = getChatViewportMetrics(messages, 40, 20, 1, 0, true);

      expect(shown.totalRows).toBeGreaterThan(hidden.totalRows);
    });

    it('skips hidden messages from viewport output', () => {
      const messages = [createMessage('Visible'), { ...createMessage('Hidden'), hidden: true }];

      const metrics = getChatViewportMetrics(messages, 80, 20, 1, 0);

      expect(metrics.visibleMessages).toHaveLength(1);
      expect(metrics.visibleMessages[0].content).toBe('Visible');
    });

    it('accounts for marginBottom spacing between messages', () => {
      const messages = [createMessage('A'), createMessage('B')];
      const metrics = getChatViewportMetrics(messages, 80, 20, 1, 0);

      // Two system messages, same role: each contributes a single content line,
      // and marginBottom spacing is only inserted between DIFFERENT roles.
      expect(metrics.totalRows).toBe(2);
    });

    it('returns empty visibleMessages for empty message array', () => {
      const metrics = getChatViewportMetrics([], 80, 20, 1, 0);

      expect(metrics.visibleMessages).toEqual([]);
      expect(metrics.totalRows).toBe(0);
      expect(metrics.maxScrollOffset).toBe(0);
    });

    it('returns all messages when viewport is large enough', () => {
      const messages = [createMessage('A'), createMessage('B'), createMessage('C')];
      const metrics = getChatViewportMetrics(messages, 80, 100, 1, 0);

      expect(metrics.visibleMessages.length).toBe(3);
      expect(metrics.visibleMessages[0].content).toBe('A');
      expect(metrics.visibleMessages[2].content).toBe('C');
    });

    it('windows tall help+tools conversation to pageSize lines without clumping', () => {
      const helpLines = [
        'Available Commands:',
        '',
        'System:',
        '  /exit       Exit the application',
        '  /help       Show help and available commands',
        '  /position   Show position for a symbol <symbol>',
        '  /tools      List available tools',
        '',
        'Session:',
        '  /clear      Clear current session and start fresh',
        '  /compact    Summarize and compact session',
        '  /resume     Resume a previous session [session-id]',
        '',
        'Configuration:',
        '  /connect    Set API key for provider <provider>',
        '  /model      Switch AI model set <model-name>',
        '  /mode       Change execution mode',
        '',
        'Usage:',
        '  Type a message to chat with the AI',
        '  @name task        - Dispatch to a configured workspace agent',
        '  /plan <goal>      - Generate a read-only plan for review',
      ];
      const toolsLines = [
        'Available runtime tools (8):',
        '  - delegate_task [session] — Delegate a concrete sub-task',
        '  - edit [file] — Perform exact string replacements in files',
        '  - glob — Find files by pattern',
        '  - grep — Search file contents',
        '  - read — Read a file',
        '  - shell — Run a shell command',
        '  - write — Write a file',
      ];

      const messages = [
        { role: 'user', content: '/help', timestamp: new Date() },
        { role: 'system', content: helpLines.join('\n'), timestamp: new Date() },
        { role: 'user', content: '/tools', timestamp: new Date() },
        { role: 'system', content: toolsLines.join('\n'), timestamp: new Date() },
      ];

      const height = 20;
      const bottomPadding = 1;
      const metrics = getChatViewportMetrics(messages, 80, height, bottomPadding, 0);

      expect(metrics.visibleLines.length).toBeLessThanOrEqual(metrics.pageSize);
      expect(metrics.visibleLines.length).toBeGreaterThan(0);
      // Newest content at bottom scroll
      const joined = metrics.visibleLines.map((l) => l.text).join('\n');
      expect(joined).toContain('Available runtime tools');
      expect(joined).toContain('❯ /tools');
      // Each display line is a single row (no embedded newlines)
      for (const line of metrics.visibleLines) {
        expect(line.text.includes('\n')).toBe(false);
      }
    });

    it('shows bottom of tall content when scrolled to bottom', () => {
      const tall = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
      const messages = [
        { role: 'system', content: tall, timestamp: new Date() },
        { role: 'system', content: 'tail message', timestamp: new Date() },
      ];

      const metrics = getChatViewportMetrics(messages, 80, 12, 1, 0);
      const joined = metrics.visibleLines.map((l) => l.text).join('\n');
      expect(joined).toContain('tail message');
      expect(joined).not.toMatch(/line 0/);
      expect(metrics.visibleLines.length).toBeLessThanOrEqual(metrics.pageSize);
    });
  });

  describe('messagesToDisplayLines', () => {
    it('flattens multi-line system help into one display line per source line', () => {
      const content = 'Available Commands:\n\nSystem:\n  /help       Show help';
      const lines = messagesToDisplayLines(
        [{ role: 'system', content, timestamp: new Date() }],
        80,
        true
      );
      // 4 body lines, no trailing blank added
      expect(lines.length).toBe(4);
      expect(lines[0].text).toBe('Available Commands:');
      expect(lines[1].text).toBe('');
      expect(lines[2].text).toBe('System:');
      expect(lines[3].text).toContain('/help');
    });

    it('prefixes user messages with the current prompt glyph', () => {
      const lines = messagesToDisplayLines(
        [{ role: 'user', content: '/help', timestamp: new Date() }],
        80,
        true
      );
      expect(lines[0].text).toBe('❯ /help');
      expect(lines[0].color).toBe('white');
    });
  });

  describe('expandWrappedLines / sliceContentFromTop', () => {
    it('expands multi-line content into display rows', () => {
      expect(expandWrappedLines('a\nb\nc', 80)).toEqual(['a', 'b', 'c']);
    });

    it('wraps long lines', () => {
      expect(expandWrappedLines('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
    });

    it('slices from top by display rows', () => {
      expect(sliceContentFromTop('a\nb\nc\nd', 2, 80)).toBe('c\nd');
    });
  });

  describe('getScrollbarMetrics', () => {
    it('returns show false when content fits', () => {
      const metrics = getScrollbarMetrics(10, 20, 0, 0);
      expect(metrics.show).toBe(false);
    });

    it('returns show true when content overflows', () => {
      const metrics = getScrollbarMetrics(100, 20, 0, 80);
      expect(metrics.show).toBe(true);
    });

    it('returns thumbHeight proportional to visible ratio with minimum 2', () => {
      const metrics = getScrollbarMetrics(100, 20, 0, 80);
      expect(metrics.thumbHeight).toBeGreaterThanOrEqual(2);
      // At 20% visible ratio on a 20-row track: max(2, floor(20 * 20 / 100)) = max(2, 4) = 4
      expect(metrics.thumbHeight).toBe(4);
    });

    it('returns thumbPosition at bottom when scrolled to bottom', () => {
      const metrics = getScrollbarMetrics(100, 20, 0, 80);
      // trackHeight=20, thumbHeight=4, scrollRatio=0
      // thumbPosition = round((20 - 4) * (1 - 0)) = 16
      expect(metrics.thumbPosition).toBe(16);
    });

    it('returns thumbPosition at top when scrolled to top', () => {
      const metrics = getScrollbarMetrics(100, 20, 80, 80);
      // scrollRatio = 80/80 = 1
      // thumbPosition = round((20 - 4) * (1 - 1)) = 0
      expect(metrics.thumbPosition).toBe(0);
    });

    it('returns thumbPosition proportional to scroll position', () => {
      const metrics = getScrollbarMetrics(100, 20, 40, 80);
      // scrollRatio = 40/80 = 0.5
      // thumbPosition = round((20 - 4) * (1 - 0.5)) = round(8) = 8
      expect(metrics.thumbPosition).toBe(8);
    });

    it('returns minimum thumbHeight of 2 for very large content', () => {
      const metrics = getScrollbarMetrics(1000, 20, 0, 980);
      // (20/1000)*20 = 0.4, floored = 0, but min is 2
      expect(metrics.thumbHeight).toBe(2);
    });
  });
});
