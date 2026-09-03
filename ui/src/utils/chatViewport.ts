/**
 * Chat viewport utilities for variable-height message virtualization.
 *
 * These functions calculate which messages are visible in a terminal-based
 * chat UI, accounting for line wrapping, markdown rendering overhead,
 * tool artifact heights, and spacing.
 */

/** Tool artifact shape for height estimation */
export interface ViewportToolArtifact {
  kind: string;
  path?: string;
  contents?: string;
  oldText?: string;
  newText?: string;
  stdout?: string;
  stderr?: string;
  symbol?: string;
  side?: string;
  size?: number;
  entryPrice?: number;
  currentPrice?: number;
  pnl?: number;
  pnlPercent?: number;
  leverage?: number;
  liquidationPrice?: number;
  isTruncated?: boolean;
  isNewFile?: boolean;
}

/** Input message shape accepted by viewport calculations */
export interface ViewportMessage {
  id?: string;
  content: string;
  parts?: Array<{ type: 'text' | 'thinking'; text: string }>;
  role?: string;
  timestamp: Date;
  status?: string;
  toolName?: string;
  preview?: string;
  hidden?: boolean;
  toolArtifact?: ViewportToolArtifact;
}

/** One pre-wrapped terminal row (Codex-style display line). */
export interface DisplayLine {
  key: string;
  /** Already wrapped to render width; at most one terminal row. */
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  /** Index into the non-hidden message list used to build lines. */
  messageIndex: number;
}

/** Metrics returned by getChatViewportMetrics */
export interface ChatViewportMetrics<T extends ViewportMessage = ViewportMessage> {
  totalRows: number;
  /** Messages that contribute at least one visible line (compat / transcript). */
  visibleMessages: T[];
  /** Exact line window to paint — length is <= pageSize. */
  visibleLines: DisplayLine[];
  pageSize: number;
  scrollOffset: number;
  maxScrollOffset: number;
  hasNewer: boolean;
  hasOlder: boolean;
}

/** Metrics returned by getScrollbarMetrics */
export interface ScrollbarMetrics {
  show: boolean;
  height: number;
  thumbPosition: number;
  thumbHeight: number;
  thumbTop: number;
  trackHeight: number;
}

/** Regex matching common markdown formatting characters */
const MARKDOWN_CHARS = /[*_`#\[()\]]/g;

/**
 * Strip markdown formatting characters before measuring text width.
 * This prevents `**bold**` from appearing wider than `bold`.
 */
function stripMarkdown(text: string): string {
  return text.replace(MARKDOWN_CHARS, '');
}

/**
 * Detect markdown block types in content and compute the overhead rows
 * they add beyond the raw text. Ink renders these with margins, borders,
 * and padding that plain text estimation misses.
 *
 * Overhead per block type (matching MarkdownRenderer.tsx):
 * - Code block: marginTop:1 + marginBottom:1 + borderStyle:"round" (2 rows) + optional language header = ~4 rows
 * - Heading (H2+): marginTop:1 + marginBottom:1 = 2 rows
 * - Heading (H1): marginBottom:1 = 1 row
 * - Table: marginY:1 = 2 rows
 * - Blockquote: marginY:1 + borderStyle:"round" (2 rows) + paddingX:1 = ~4 rows
 * - Horizontal rule: marginY:1 = 2 rows
 * - Paragraph: marginBottom:1 = 1 row (already counted in spacing)
 */
function estimateMarkdownOverhead(content: string): number {
  const lines = content.split('\n');
  let overhead = 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block: ```...```
    if (line.startsWith('```')) {
      // Find closing fence
      let codeLines = 0;
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines++;
        i++;
      }
      // marginTop:1 + marginBottom:1 + border top:1 + border bottom:1 + optional language header:1
      overhead += codeLines > 0 ? 5 : 4;
      i++;
      continue;
    }

    // Horizontal rule: ---, ***, ___
    if (/^[-*_]{3,}\s*$/.test(line.trim())) {
      overhead += 2; // marginY:1
      i++;
      continue;
    }

    // Heading: # ... ######
    const headingMatch = line.match(/^(#{1,6})\s/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      // H1: marginBottom:1 = 1 row
      // H2-H3: marginTop:1 + marginBottom:1 = 2 rows
      // H4-H6: marginTop:1 = 1 row
      overhead += level <= 1 ? 1 : level <= 3 ? 2 : 1;
      i++;
      continue;
    }

    // Table: |...| pattern with separator line
    if (line.match(/^\|.+\|$/) && i + 1 < lines.length && lines[i + 1]?.match(/^\|[\s-:|]+\|$/)) {
      // marginY:1 = 2 rows
      overhead += 2;
      // Skip table rows
      i += 2; // header + separator
      while (i < lines.length && lines[i].match(/^\|.+\|/)) {
        i++;
      }
      continue;
    }

    // Blockquote: > ...
    if (line.match(/^>\s/)) {
      // marginY:1 + borderStyle:"round" (2 rows) = ~3 rows
      overhead += 3;
      while (i < lines.length && lines[i].match(/^>/)) {
        i++;
      }
      continue;
    }

    i++;
  }

  return overhead;
}

/**
 * Estimate how many terminal rows a piece of text will occupy.
 *
 * - Newlines create separate rows
 * - Long lines wrap based on the provided width
 * - Markdown formatting chars are stripped before measuring
 * - Accounts for markdown block overhead (code blocks, headings, tables, etc.)
 * - Returns at least 1 row (even for empty content)
 */
export function estimateMessageRows(content: string, width: number): number {
  const safeWidth = Math.max(1, width);
  const stripped = stripMarkdown(content);
  const lines = stripped.split('\n');

  const textRows = lines.reduce((total, line) => {
    return total + Math.max(1, Math.ceil(line.length / safeWidth));
  }, 0);

  const markdownOverhead = estimateMarkdownOverhead(content);

  return textRows + markdownOverhead;
}

/**
 * Estimate how many terminal rows a tool artifact will occupy.
 *
 * Matches the actual rendering in DiffRenderer, WriteArtifactRenderer,
 * BoxedCodeSurface, and PositionCardInline.
 */
function estimateToolArtifactRows(artifact: ViewportToolArtifact, width: number): number {
  const safeWidth = Math.max(1, width);

  switch (artifact.kind) {
    case 'diff': {
      // DiffRenderer: createDiffLines produces up to MAX_RENDERED_DIFF_LINES (120)
      const oldLines = (artifact.oldText ?? '').split('\n');
      const newLines = (artifact.newText ?? '').split('\n');
      // Rough estimate: diff produces ~80% of total lines as output
      const diffContentLines = Math.min(Math.ceil((oldLines.length + newLines.length) * 0.8), 120);
      // BoxedCodeSurface overhead: marginTop:1 + borderStyle:"single" (2) + title:1 + path:1 + marginBottom:1 = ~6
      return diffContentLines + 6;
    }

    case 'write': {
      // WriteArtifactRenderer: up to MAX_RENDERED_WRITE_LINES (120)
      const contentLines = (artifact.contents ?? '').split('\n');
      const cappedLines = Math.min(contentLines.length, 120);
      // BoxedCodeSurface overhead: ~6 rows
      return cappedLines + 6;
    }

    case 'position-card': {
      // PositionCardInline: fixed height
      // borderStyle:"round" (2) + 4-5 content rows + paddingX:1 + marginTop:1 = ~7 rows
      return 7;
    }

    case 'shell_output': {
      // stdout + stderr lines + borders
      const stdoutLines = artifact.stdout ? artifact.stdout.split('\n').length : 0;
      const stderrLines = artifact.stderr ? artifact.stderr.split('\n').length : 0;
      const headerLines = artifact.stderr ? 1 : 0; // "STDERR:" header
      // marginTop:1 + marginLeft:2 don't add vertical rows, but content does
      return stdoutLines + stderrLines + headerLines + 1; // +1 for spacing
    }

    default:
      return 1;
  }
}

/**
 * Expand text into display rows after wrapping at `width`.
 * Empty content yields a single empty row (matches Ink Text).
 */
export function expandWrappedLines(content: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const source = content.length === 0 ? [''] : content.split('\n');
  const rows: string[] = [];

  for (const line of source) {
    if (line.length === 0) {
      rows.push('');
      continue;
    }
    for (let i = 0; i < line.length; i += safeWidth) {
      rows.push(line.slice(i, i + safeWidth));
    }
  }

  return rows.length > 0 ? rows : [''];
}

/**
 * Drop the first `skipRows` wrapped display rows from plain text content.
 * Used when a tall message is only partially in the viewport (show bottom).
 */
export function sliceContentFromTop(content: string, skipRows: number, width: number): string {
  if (skipRows <= 0) return content;
  const rows = expandWrappedLines(content, width);
  if (skipRows >= rows.length) return '';
  return rows.slice(skipRows).join('\n');
}

/**
 * Compute which message indices start a group of 3+ consecutive non-hidden
 * messages sharing the same role. Returns a Set of message indices that
 * should have a role indicator line prepended.
 */
function computeRoleGroupStarts(messages: readonly ViewportMessage[]): Set<number> {
  const result = new Set<number>();

  // Build list of non-hidden messages with their original indices
  const visibleMsgs: Array<{ msg: ViewportMessage; idx: number }> = [];
  messages.forEach((msg, idx) => {
    if (!msg.hidden) {
      visibleMsgs.push({ msg, idx });
    }
  });

  let currentRole: string | null = null;
  let groupStartIdx = -1;
  let groupCount = 0;

  for (let i = 0; i <= visibleMsgs.length; i++) {
    const role = i < visibleMsgs.length ? (visibleMsgs[i].msg.role ?? 'system') : null;

    if (role !== currentRole) {
      // End of previous group
      if (currentRole !== null && groupCount >= 3 && groupStartIdx >= 0) {
        result.add(groupStartIdx);
      }
      currentRole = role;
      groupStartIdx = i < visibleMsgs.length ? visibleMsgs[i].idx : -1;
      groupCount = role !== null ? 1 : 0;
    } else if (role !== null) {
      groupCount++;
    }
  }

  return result;
}

/**
 * Flatten messages into pre-wrapped display lines (Codex display_lines pattern).
 *
 * Scroll virtualization windows these lines — never mounts more Ink rows
 * than the page size, so Yoga cannot flex-shrink multi-line trees into clumps.
 *
 * When 3+ consecutive non-hidden messages share the same role, a role indicator
 * line (e.g. `── Assistant ──`) is prepended to the first message in the group.
 */
export function messagesToDisplayLines(
  messages: readonly ViewportMessage[],
  width: number,
  showThinking = true
): DisplayLine[] {
  const safeWidth = Math.max(1, width);
  const lines: DisplayLine[] = [];
  let seq = 0;

  // Pre-compute which messages start a group of 3+ same-role consecutive messages
  const roleGroupStarts = computeRoleGroupStarts(messages);

  const pushStyled = (
    text: string,
    msgIndex: number,
    style: Pick<DisplayLine, 'color' | 'bold' | 'dim' | 'italic'> = {}
  ) => {
    const rows = expandWrappedLines(text, safeWidth);
    for (const row of rows) {
      lines.push({
        key: `m${msgIndex}-${seq++}`,
        text: row.length > safeWidth ? row.slice(0, safeWidth) : row,
        messageIndex: msgIndex,
        ...style,
      });
    }
  };

  const pushBlank = (msgIndex: number) => {
    lines.push({
      key: `m${msgIndex}-gap-${seq++}`,
      text: '',
      messageIndex: msgIndex,
    });
  };

  let prevRole: string | null = null;

  messages.forEach((msg, msgIndex) => {
    if (msg.hidden) return;
    const role = msg.role ?? 'system';

    // Only add blank line between DIFFERENT roles (not after every message)
    // Claude Code pattern: no blank line between same-role messages
    if (prevRole !== null && prevRole !== role) {
      pushBlank(msgIndex);
    }
    prevRole = role;

    // Insert role indicator line for groups of 3+ consecutive same-role messages
    if (roleGroupStarts.has(msgIndex)) {
      const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);
      pushStyled(`── ${roleLabel} ──`, msgIndex, { color: 'gray', dim: true });
    }

    if (role === 'thinking') {
      if (!showThinking) return;
      const text = msg.preview
        ? `≈ Thinking: ${msg.preview}`
        : msg.content
          ? `≈ Thinking: ${msg.content}`
          : '≈ Thinking...';
      pushStyled(text, msgIndex, { dim: true, italic: true, color: 'gray' });
      return;
    }

    if (role === 'user') {
      const contentLines = (msg.content ?? '').split('\n');
      if (contentLines.length === 0) contentLines.push('');
      contentLines.forEach((line, i) => {
        const prefix = i === 0 ? '> ' : '  ';
        pushStyled(prefix + line, msgIndex, { color: 'green', bold: true });
      });
      return;
    }

    if (role === 'tool') {
      const toolStatus = msg.status || 'completed';
      const statusLabel =
        toolStatus === 'error' ? 'error' : toolStatus === 'pending' ? 'running' : 'done';
      const toolDisplayName = msg.toolName || msg.content || 'tool';
      pushStyled(`[${statusLabel}] ${toolDisplayName}`, msgIndex, {
        color: 'white',
        bold: true,
      });
      const previewContent = msg.preview || '';
      if (previewContent) {
        pushStyled(`└── ${previewContent}`, msgIndex, {
          color: toolStatus === 'error' ? 'red' : 'gray',
          dim: toolStatus !== 'pending',
          italic: toolStatus === 'pending',
        });
      }
      if (msg.toolArtifact?.kind === 'shell_output') {
        if (msg.toolArtifact.stdout) {
          for (const l of msg.toolArtifact.stdout.split('\n')) {
            pushStyled(l, msgIndex, { dim: true, color: 'gray' });
          }
        }
        if (msg.toolArtifact.stderr) {
          pushStyled('STDERR:', msgIndex, { color: 'red' });
          for (const l of msg.toolArtifact.stderr.split('\n')) {
            pushStyled(l, msgIndex, { color: 'red', dim: true });
          }
        }
      }
      return;
    }

    if (role === 'assistant') {
      let text = msg.content ?? '';
      if (msg.parts?.length) {
        const chunks: string[] = [];
        for (const part of msg.parts) {
          if (part.type === 'thinking') {
            if (!showThinking) continue;
            chunks.push('≈ Thinking...');
            if (part.text) chunks.push(part.text.slice(0, 500));
          } else {
            chunks.push(part.text);
          }
        }
        text = chunks.join('\n');
      }
      const plain = stripMarkdown(text);
      const bodyLines = plain.length === 0 ? [''] : plain.split('\n');
      for (const l of bodyLines) {
        pushStyled(l, msgIndex, { color: 'white' });
      }
      return;
    }

    // system / command output / default
    const content = msg.preview ?? msg.content ?? '';
    const bodyLines = content.length === 0 ? [''] : content.split('\n');
    for (const l of bodyLines) {
      pushStyled(l, msgIndex, { color: 'gray' });
    }
  });

  return lines;
}

/**
 * Estimate the total height of a message in terminal rows.
 *
 * Accounts for:
 * - Text content with markdown block overhead
 * - Tool artifacts (diffs, writes, position cards, shell output)
 * - Message role-specific rendering overhead
 * - Matches ChatMessageItem / MarkdownRenderer layout
 */
export function estimateMessageHeight(
  msg: ViewportMessage,
  width: number,
  showThinking: boolean
): number {
  const safeWidth = Math.max(1, width);
  let totalRows = 0;
  const role = msg.role ?? 'system';

  if (role === 'thinking') {
    if (!showThinking) return 0;
    // Compact: single italic line (preview preferred)
    totalRows = estimateMessageRows(msg.preview ?? msg.content ?? '≈ Thinking...', safeWidth);
  } else if (role === 'tool') {
    // Status line + optional preview line
    totalRows = 1;
    const previewContent = msg.preview || msg.content || '';
    if (previewContent) {
      totalRows += Math.max(1, Math.ceil(previewContent.length / safeWidth));
    }
    if (msg.toolArtifact) {
      totalRows += estimateToolArtifactRows(msg.toolArtifact, safeWidth);
    }
  } else if (msg.parts?.length) {
    // Assistant message with parts
    for (const part of msg.parts) {
      if (part.type === 'thinking' && !showThinking) continue;
      if (part.type === 'thinking') {
        // Header + optional content (truncated to 500) + part marginBottom
        const thinkingText = part.text.slice(0, 500);
        const wrappedRows = expandWrappedLines(thinkingText, Math.max(1, safeWidth - 2)).length;
        totalRows += 1 + wrappedRows + 1;
      } else {
        // Text part via markdown estimate + paragraph marginBottom (1)
        totalRows += estimateMessageRows(part.text, safeWidth) + 1;
      }
    }
  } else if (role === 'user') {
    // "> " prefix on first line only; each physical line wraps independently
    const lines = (msg.content ?? '').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const prefix = i === 0 ? 2 : 0; // "> "
      const lineWidth = Math.max(1, safeWidth - prefix);
      const line = lines[i] ?? '';
      totalRows += Math.max(1, Math.ceil(Math.max(line.length, 1) / lineWidth));
    }
    if (lines.length === 0) totalRows = 1;
  } else if (role === 'assistant') {
    totalRows = estimateMessageRows(msg.content, safeWidth) + 1; // + paragraph margin
  } else {
    // system / command output: plain line-split, no markdown margins
    totalRows = expandWrappedLines(msg.preview ?? msg.content ?? '', safeWidth).length;
  }

  if (msg.toolArtifact && role !== 'tool') {
    totalRows += estimateToolArtifactRows(msg.toolArtifact, safeWidth);
  }

  return Math.max(1, totalRows);
}

/**
 * Calculate the usable render width for a message box.
 *
 * Reserves 1 column for the scrollbar track so estimates match the
 * width passed to ChatMessageList (contentWidth = width - scrollbar).
 * Minimum usable width is 20 columns.
 */
export function getMessageRenderWidth(terminalWidth: number): number {
  return Math.max(20, terminalWidth - 1);
}

/**
 * Clamp a scroll offset to the valid range [0, maxOffset].
 */
export function clampScrollOffset(offset: number, maxOffset: number): number {
  return Math.max(0, Math.min(offset, maxOffset));
}

/**
 * Calculate chat viewport metrics with variable-height message virtualization.
 *
 * @param messages       Array of messages to display
 * @param width          Terminal width in columns
 * @param height         Terminal height in rows
 * @param bottomPadding  Rows reserved at bottom (e.g. input box)
 * @param scrollOffset   Requested scroll offset (0 = bottom/newest)
 *
 * @returns ChatViewportMetrics including visible message subset and scroll state
 */
export function getChatViewportMetrics<T extends ViewportMessage>(
  messages: T[],
  width: number,
  height: number,
  bottomPadding: number,
  scrollOffset: number,
  showThinking = true
): ChatViewportMetrics<T> {
  const renderWidth = getMessageRenderWidth(width);
  const pageSize = Math.max(1, height - bottomPadding);
  const visibleInput = messages.filter((msg) => !msg.hidden);

  // Codex-style: flatten to lines, then window by scroll offset
  const allLines = messagesToDisplayLines(visibleInput, renderWidth, showThinking);
  const totalRows = allLines.length;

  const maxScrollOffset = Math.max(0, totalRows - pageSize);
  const clampedOffset = clampScrollOffset(scrollOffset, maxScrollOffset);
  const hasNewer = clampedOffset > 0;
  const hasOlder = clampedOffset < maxScrollOffset;

  // scrollOffset=0 => bottom (newest)
  const endRowExclusive = totalRows - clampedOffset;
  const startRow = Math.max(0, endRowExclusive - pageSize);
  const visibleLines = allLines.slice(startRow, endRowExclusive);

  const msgIndices = new Set(visibleLines.map((line) => line.messageIndex));
  const visibleMessages = visibleInput.filter((_, index) => msgIndices.has(index));

  return {
    totalRows,
    visibleMessages,
    visibleLines,
    pageSize,
    scrollOffset: clampedOffset,
    maxScrollOffset,
    hasNewer,
    hasOlder,
  };
}

/**
 * Calculate scrollbar thumb metrics for the chat viewport.
 *
 * @param totalRows       Total rows of content
 * @param pageSize        Visible rows in the viewport
 * @param scrollOffset    Current scroll offset (0 = bottom)
 * @param maxScrollOffset Maximum scroll offset
 *
 * @returns ScrollbarMetrics including thumb size and position
 */
export function getScrollbarMetrics(
  totalRows: number,
  pageSize: number,
  scrollOffset: number,
  maxScrollOffset: number
): ScrollbarMetrics {
  const trackHeight = pageSize;

  // No scrolling needed if content fits within the viewport
  if (totalRows <= pageSize || maxScrollOffset <= 0) {
    return {
      show: false,
      thumbHeight: 0,
      thumbPosition: 0,
      thumbTop: 0,
      trackHeight,
      height: trackHeight,
    };
  }

  // Thumb height proportional to visible ratio, minimum 2 rows
  const thumbHeight = Math.max(2, Math.floor((pageSize / totalRows) * pageSize));

  // scrollOffset=0 is at the bottom (newest), maxScrollOffset is at top (oldest)
  // Thumb should be at the bottom when scrollOffset=0, top when at max
  const scrollRatio = maxScrollOffset > 0 ? scrollOffset / maxScrollOffset : 0;
  const thumbPosition = Math.round((trackHeight - thumbHeight) * (1 - scrollRatio));

  return {
    show: true,
    thumbHeight,
    thumbPosition,
    thumbTop: thumbPosition,
    trackHeight,
    height: trackHeight,
  };
}
