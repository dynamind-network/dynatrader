import React, { useMemo } from 'react';
import { Box, Text } from '@dynatrader/ink/terminal';
import { LRUCache } from '../utils/lruCache.js';
import { createSymbolPattern } from './marketSymbols.js';
import { COLORS, GLYPHS, SPACING } from '../design/tokens.js';

// ---------------------------------------------------------------------------
// LRU Token Cache - shared singleton for markdown parsing results
// ---------------------------------------------------------------------------

export const MarkdownTokenCache = new LRUCache<string, ParsedBlock[]>({ maxSize: 500 });

// ---------------------------------------------------------------------------
// Markdown syntax fast-path detection
// ---------------------------------------------------------------------------

const MARKDOWN_SYNTAX_PATTERNS = [
  /^#{1,6}\s/m, // Headings
  /^```/m, // Code block fences
  /`[^`]+`/, // Inline code
  /\*\*[^*]+\*\*/, // Bold (**)
  /__[^_]+__/, // Bold (__)
  /\*[^*]+\*/, // Italic (*)
  /_[^_]+_/, // Italic (_)
  /~~[^~]+~~/, // Strikethrough
  /\[[^\]]+\]\([^)]+\)/, // Links
  /^[-*_]{3,}\s*$/m, // Horizontal rules
  /^>\s/m, // Blockquotes
  /^(\s*)([-*+]|\d+\.)\s/m, // Lists
  /^\|.+\|$/m, // Tables
  /^(\s*)([-*+])\s+\[[ xX]\]\s/m, // Checkboxes
];

const SYMBOL_PATTERN = createSymbolPattern();

const FAST_PATH_CHECK_LENGTH = 500;

/**
 * Check if a string contains any markdown syntax.
 * Only scans the first 500 characters for performance.
 * Returns true if markdown syntax is detected, false for plain text.
 */
export function hasMarkdownSyntax(content: string): boolean {
  const checkContent =
    content.length > FAST_PATH_CHECK_LENGTH ? content.slice(0, FAST_PATH_CHECK_LENGTH) : content;

  for (const pattern of MARKDOWN_SYNTAX_PATTERNS) {
    if (pattern.test(checkContent)) {
      return true;
    }
  }
  return false;
}

/**
 * Create a hash-based cache key for markdown content.
 * Uses a simple string hash to avoid retaining full content strings in the cache.
 * The hasMarkdown flag is included to differentiate plain text from markdown
 * content that happens to hash to the same value.
 */
export function createMarkdownCacheKey(content: string, hasMarkdown: boolean): string {
  // Simple DJB2-style hash
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash + content.charCodeAt(i)) | 0;
  }
  return `md:${hash.toString(36)}:${hasMarkdown ? '1' : '0'}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface MarkdownRendererProps {
  content: string;
  maxWidth?: number;
}

type BlockType =
  'paragraph' | 'heading' | 'code-block' | 'list' | 'table' | 'blockquote' | 'horizontal-rule';

interface ParsedBlock {
  type: BlockType;
  content: string;
  language?: string;
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content, maxWidth = 120 }) => {
  const parsedBlocks = useMemo(() => {
    // Fast-path: check for markdown syntax before parsing
    const hasMd = hasMarkdownSyntax(content);

    // Check cache
    const cacheKey = createMarkdownCacheKey(content, hasMd);
    const cached = MarkdownTokenCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Parse and cache
    const blocks = parseMarkdown(content);
    MarkdownTokenCache.set(cacheKey, blocks);
    return blocks;
  }, [content]);

  return (
    <Box flexDirection="column" width={maxWidth}>
      {parsedBlocks.map((block, index) => (
        <RenderBlock key={index} block={block} maxWidth={maxWidth} />
      ))}
    </Box>
  );
};

function parseMarkdown(content: string): ParsedBlock[] {
  const lines = content.split('\n');
  const blocks: ParsedBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('```')) {
      const language = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push({
        type: 'code-block',
        content: codeLines.join('\n'),
        language,
      });
      i++;
      continue;
    }

    if (line.startsWith('---') || line.startsWith('***') || line.startsWith('___')) {
      blocks.push({ type: 'horizontal-rule', content: '' });
      i++;
      continue;
    }

    if (line.match(/^#{1,6}\s/)) {
      blocks.push({ type: 'heading', content: line });
      i++;
      continue;
    }

    if (line.match(/^\|.+\|$/) && lines[i + 1]?.match(/^\|[\s-:|]+\|$/)) {
      const tableLines: string[] = [line];
      i++;
      while (i < lines.length && lines[i].match(/^\|.+\|/)) {
        tableLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'table', content: tableLines.join('\n') });
      continue;
    }

    if (line.match(/^(\s*)([-*+]|\d+\.)\s/)) {
      const listLines: string[] = [line];
      i++;
      while (i < lines.length && lines[i].match(/^(\s*)([-*+]|\d+\.)\s/)) {
        listLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'list', content: listLines.join('\n') });
      continue;
    }

    if (line.match(/^>\s/)) {
      const quoteLines: string[] = [line.replace(/^>\s?/, '')];
      i++;
      while (i < lines.length && lines[i].match(/^>/)) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'blockquote', content: quoteLines.join('\n') });
      continue;
    }

    if (line.trim() === '') {
      i++;
      continue;
    }

    // Group consecutive plain lines into a single paragraph so each line
    // does not get its own marginBottom (which doubled chat row height).
    const paragraphLines: string[] = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i];
      if (next.trim() === '') break;
      if (next.startsWith('```')) break;
      if (next.startsWith('---') || next.startsWith('***') || next.startsWith('___')) break;
      if (next.match(/^#{1,6}\s/)) break;
      if (next.match(/^\|.+\|$/) && lines[i + 1]?.match(/^\|[\s-:|]+\|$/)) break;
      if (next.match(/^(\s*)([-*+]|\d+\.)\s/)) break;
      if (next.match(/^>\s/)) break;
      paragraphLines.push(next);
      i++;
    }
    blocks.push({ type: 'paragraph', content: paragraphLines.join('\n') });
  }

  return blocks;
}

function RenderBlock({ block, maxWidth }: { block: ParsedBlock; maxWidth: number }) {
  switch (block.type) {
    case 'code-block':
      return <CodeBlock content={block.content} language={block.language} />;
    case 'heading':
      return <HeadingBlock content={block.content} />;
    case 'list':
      return <ListBlock content={block.content} />;
    case 'table':
      return <TableBlock content={block.content} maxWidth={maxWidth} />;
    case 'blockquote':
      return <QuoteBlock content={block.content} />;
    case 'horizontal-rule':
      return (
        <Box marginY={SPACING.sm}>
          <Text color={COLORS.muted}>{'─'.repeat(56)}</Text>
        </Box>
      );
    default:
      return <ParagraphBlock content={block.content} maxWidth={maxWidth} />;
  }
}

// ---------------------------------------------------------------------------
// Syntax highlighting
// ---------------------------------------------------------------------------

const JS_KEYWORDS = new Set([
  'const',
  'let',
  'var',
  'function',
  'return',
  'import',
  'export',
  'if',
  'else',
  'for',
  'while',
  'class',
  'async',
  'await',
  'try',
  'catch',
  'throw',
  'new',
  'this',
  'typeof',
  'instanceof',
]);

const PYTHON_KEYWORDS = new Set([
  'def',
  'class',
  'return',
  'import',
  'from',
  'if',
  'else',
  'elif',
  'for',
  'while',
  'try',
  'except',
  'finally',
  'with',
  'as',
  'lambda',
  'yield',
  'raise',
  'True',
  'False',
  'None',
]);

function getKeywordsForLanguage(language?: string): Set<string> | null {
  if (!language) return null;
  const lang = language.toLowerCase();
  if (['js', 'jsx', 'ts', 'tsx', 'javascript', 'typescript'].includes(lang)) {
    return JS_KEYWORDS;
  }
  if (['python', 'py'].includes(lang)) {
    return PYTHON_KEYWORDS;
  }
  return null;
}

interface TokenSpan {
  text: string;
  type: 'plain' | 'keyword' | 'string' | 'comment';
}

/**
 * Tokenize a single line of code for syntax highlighting.
 * Handles // and # comments, single/double/backtick strings,
 * and keyword matching.
 */
function tokenizeCodeLine(line: string, keywords: Set<string> | null): TokenSpan[] {
  const spans: TokenSpan[] = [];
  let i = 0;

  while (i < line.length) {
    // Single-line comment: // or #
    if ((line[i] === '/' && line[i + 1] === '/') || line[i] === '#') {
      spans.push({ text: line.slice(i), type: 'comment' });
      return spans;
    }

    // Strings: single-quoted, double-quoted, or backtick-quoted
    if (line[i] === '"' || line[i] === "'" || line[i] === '`') {
      const quote = line[i];
      let j = i + 1;
      while (j < line.length && line[j] !== quote) {
        if (line[j] === '\\') j++; // skip escaped char
        j++;
      }
      j++; // include closing quote
      spans.push({ text: line.slice(i, j), type: 'string' });
      i = j;
      continue;
    }

    // Word: check if keyword
    if (/[a-zA-Z_]/.test(line[i])) {
      let j = i;
      while (j < line.length && /[a-zA-Z0-9_]/.test(line[j])) j++;
      const word = line.slice(i, j);
      const isKeyword = keywords !== null && keywords.has(word);
      spans.push({ text: word, type: isKeyword ? 'keyword' : 'plain' });
      i = j;
      continue;
    }

    // Everything else is plain
    let j = i;
    while (
      j < line.length &&
      !['/', '"', "'", '`', '#'].includes(line[j]) &&
      !/[a-zA-Z_]/.test(line[j])
    ) {
      j++;
    }
    if (j > i) {
      spans.push({ text: line.slice(i, j), type: 'plain' });
    }
    i = j;
  }

  return spans;
}

function HighlightedCodeLine({
  line,
  keywords,
  lineIndex,
}: {
  line: string;
  keywords: Set<string> | null;
  lineIndex: number;
}) {
  const spans = tokenizeCodeLine(line, keywords);
  return (
    <Text>
      {spans.map((span, si) => {
        switch (span.type) {
          case 'keyword':
            return (
              <Text key={si} color={COLORS.accent}>
                {span.text}
              </Text>
            );
          case 'string':
            return (
              <Text key={si} color={COLORS.success}>
                {span.text}
              </Text>
            );
          case 'comment':
            return (
              <Text key={si} color={COLORS.muted} italic>
                {span.text}
              </Text>
            );
          default:
            return (
              <Text key={si} color={COLORS.primary}>
                {span.text}
              </Text>
            );
        }
      })}
    </Text>
  );
}

function CodeBlock({ content, language }: { content: string; language?: string }) {
  const lines = content.split('\n');
  const keywords = getKeywordsForLanguage(language);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={COLORS.border}
      paddingX={SPACING.xs}
      marginY={SPACING.sm}
    >
      {language && (
        <Text color={COLORS.muted} italic>
          {language}
        </Text>
      )}
      {lines.map((line, i) => (
        <HighlightedCodeLine key={i} line={line} keywords={keywords} lineIndex={i} />
      ))}
    </Box>
  );
}

function HeadingBlock({ content }: { content: string }) {
  const match = content.match(/^(#{1,6})\s(.*)$/);
  if (!match) return null;

  const level = match[1].length;
  const text = match[2];

  // H1: accent (cyan) + bold, H2: success (green) + bold,
  // H3: warning (yellow) + bold, H4+: muted (gray) + bold
  const headingColors: Record<number, string> = {
    1: COLORS.accent,
    2: COLORS.success,
    3: COLORS.warning,
  };
  const color = headingColors[level] ?? COLORS.muted;

  return (
    <Box marginTop={level > 1 ? SPACING.xs : 0} marginBottom={level < 3 ? SPACING.xs : 0}>
      <Text bold color={color as any}>
        {text}
      </Text>
    </Box>
  );
}

function ListBlock({ content }: { content: string }) {
  const lines = content.split('\n');

  // Calculate nesting levels and whether each item is the last child at its level.
  // We track indent levels to determine parent-child relationships.
  const items: { line: string; indent: number; isLast: boolean }[] = [];

  for (const line of lines) {
    const indentMatch = line.match(/^(\s*)/);
    const indent = indentMatch ? Math.floor(indentMatch[1].length / 2) : 0;
    items.push({ line, indent, isLast: false });
  }

  // Mark last items at each indent level
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    // Find the next item at the same or lesser indent — if none, this is last
    let foundPeer = false;
    for (let j = i + 1; j < items.length; j++) {
      if (items[j].indent === item.indent) {
        foundPeer = true;
        break;
      }
    }
    if (!foundPeer) {
      item.isLast = true;
    }
  }

  return (
    <Box flexDirection="column">
      {items.map((item, i) => {
        const checkboxMatch = item.line.match(/^(\s*)([-*+])\s+\[([ xX])\]\s+(.*)$/);
        if (checkboxMatch) {
          const checked = checkboxMatch[3] === 'x' || checkboxMatch[3] === 'X';
          const prefix = buildTreePrefix(items, i);
          return (
            <Box key={i}>
              <Text color={COLORS.muted}>{prefix}</Text>
              <Text color={checked ? COLORS.success : COLORS.muted}>[{checked ? 'x' : ' '}] </Text>
              <Text color={COLORS.primary}>{checkboxMatch[4]}</Text>
            </Box>
          );
        }

        const bulletMatch = item.line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
        if (bulletMatch) {
          const isNumbered = /\d+\./.test(bulletMatch[2]);
          const prefix = buildTreePrefix(items, i);
          const bullet = isNumbered ? bulletMatch[2] : `${GLYPHS.separator}`;
          return (
            <Box key={i}>
              <Text color={COLORS.muted}>{prefix}</Text>
              <Text color={COLORS.accent}>{bullet}</Text>
              <Text color={COLORS.primary}> </Text>
              <ParagraphBlock content={bulletMatch[3]} inline />
            </Box>
          );
        }

        return null;
      })}
    </Box>
  );
}

/**
 * Build the tree-like prefix for a list item at the given index.
 * Uses ├── for non-last items and └── for last items at each ancestor level.
 */
function buildTreePrefix(
  items: { line: string; indent: number; isLast: boolean }[],
  index: number
): string {
  const current = items[index];
  if (current.indent === 0) return '';

  let prefix = '';
  // Walk ancestors (indent levels 0 .. current.indent-1) to build the prefix
  // We need to know if each ancestor was the last item at its level when we
  // passed it.  We look backwards to find the relevant ancestor.
  const ancestorLastFlags: boolean[] = [];

  // For each level from 0 to current.indent-1, find the most recent item at
  // that level that appears before this index.
  for (let level = 0; level < current.indent; level++) {
    let found = false;
    for (let j = index - 1; j >= 0; j--) {
      if (items[j].indent === level) {
        ancestorLastFlags.push(items[j].isLast);
        found = true;
        break;
      }
    }
    if (!found) {
      ancestorLastFlags.push(false);
    }
  }

  for (const wasLast of ancestorLastFlags) {
    prefix += wasLast ? '   ' : `│${' '}`;
  }

  // The connector for the current item
  prefix += current.isLast ? '└── ' : '├── ';

  return prefix;
}

function TableBlock({ content, maxWidth }: { content: string; maxWidth: number }) {
  const lines = content.split('\n');
  if (lines.length < 2) return null;

  const parseRow = (line: string): string[] =>
    line
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean);

  const headers = parseRow(lines[0]);
  const alignments: ('left' | 'center' | 'right')[] = [];

  const separatorLine = lines[1];
  const separators = separatorLine.split('|').slice(1, -1);
  for (const sep of separators) {
    if (sep.trim().startsWith(':') && sep.trim().endsWith(':')) {
      alignments.push('center');
    } else if (sep.trim().endsWith(':')) {
      alignments.push('right');
    } else {
      alignments.push('left');
    }
  }

  // Parse data rows
  const dataRows: string[][] = [];
  for (let r = 2; r < lines.length; r++) {
    if (lines[r].match(/^\|.+\|/)) {
      dataRows.push(parseRow(lines[r]));
    }
  }

  // Calculate per-column widths based on content
  const MIN_COL_WIDTH = 4;
  const PADDING = 2; // 1 space each side
  const numCols = headers.length;
  const colWidths: number[] = new Array(numCols).fill(MIN_COL_WIDTH);

  // Check headers
  for (let c = 0; c < numCols; c++) {
    colWidths[c] = Math.max(colWidths[c], headers[c]?.length ?? 0);
  }

  // Check data rows
  for (const row of dataRows) {
    for (let c = 0; c < numCols; c++) {
      colWidths[c] = Math.max(colWidths[c], row[c]?.length ?? 0);
    }
  }

  // Apply padding
  for (let c = 0; c < numCols; c++) {
    colWidths[c] = colWidths[c] + PADDING;
  }

  // Ensure total width does not exceed maxWidth (shrink proportionally if needed)
  const totalWidth = colWidths.reduce((a, b) => a + b, 0);
  if (totalWidth > maxWidth) {
    const ratio = maxWidth / totalWidth;
    for (let c = 0; c < numCols; c++) {
      colWidths[c] = Math.max(MIN_COL_WIDTH, Math.floor(colWidths[c] * ratio));
    }
  }

  const padCell = (text: string, width: number, align: 'left' | 'center' | 'right'): string => {
    const pad = width - text.length;
    if (pad <= 0) return text.slice(0, width);
    const leftPad = align === 'right' ? pad : align === 'center' ? Math.floor(pad / 2) : 0;
    const rightPad = pad - leftPad;
    return ' '.repeat(leftPad) + text + ' '.repeat(rightPad);
  };

  return (
    <Box flexDirection="column" marginY={SPACING.sm}>
      <Box flexDirection="column">
        {/* Header row */}
        <Box>
          {headers.map((header, i) => (
            <Box key={i} width={colWidths[i]} marginRight={SPACING.xs}>
              <Text bold color={COLORS.warning}>
                {padCell(header, colWidths[i] - PADDING, 'left')}
              </Text>
            </Box>
          ))}
        </Box>
        {/* Separator row */}
        <Box>
          {colWidths.map((w, i) => (
            <Box key={i} width={w} marginRight={SPACING.xs}>
              <Text color={COLORS.muted}>{'─'.repeat(w - PADDING)}</Text>
            </Box>
          ))}
        </Box>
      </Box>
      {/* Data rows */}
      {dataRows.map((row, rowIndex) => (
        <Box key={rowIndex}>
          {row.map((cell, cellIndex) => (
            <Box key={cellIndex} width={colWidths[cellIndex]} marginRight={SPACING.xs}>
              <Text color={COLORS.primary}>
                {padCell(cell, colWidths[cellIndex] - PADDING, alignments[cellIndex] ?? 'left')}
              </Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

function QuoteBlock({ content }: { content: string }) {
  const lines = content.split('\n');
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={COLORS.highlight}
      paddingX={SPACING.xs}
      marginY={SPACING.sm}
    >
      {lines.map((line, i) => (
        <Text key={i} color={COLORS.highlight} italic>
          {'>'} {line}
        </Text>
      ))}
    </Box>
  );
}

function ParagraphBlock({
  content,
  inline = false,
  maxWidth = 120,
}: {
  content: string;
  inline?: boolean;
  maxWidth?: number;
}) {
  const renderInline = (text: string): React.ReactNode => {
    const parts: React.ReactNode[] = [];
    let cursor = 0;

    const pushPlainText = (txt: string) => {
      if (!txt) return;
      parts.push(<Text key={parts.length}>{txt}</Text>);
    };

    const patterns = [
      { regex: /```[\s\S]*?```/g, type: 'code' },
      { regex: /`[^`]+`/g, type: 'code' },
      { regex: /\*\*\*([^*]+)\*\*\*/g, type: 'bold-italic' },
      { regex: /\*\*([^*]+)\*\*/g, type: 'bold' },
      { regex: /\*([^*]+)\*/g, type: 'italic' },
      { regex: /__([^_]+)__/g, type: 'bold' },
      { regex: /_([^_]+)_/g, type: 'italic' },
      { regex: /~~([^~]+)~~/g, type: 'strikethrough' },
      { regex: /\[([^\]]+)\]\([^)]+\)/g, type: 'link' },
      { regex: SYMBOL_PATTERN, type: 'symbol' },
    ];

    while (cursor < text.length) {
      let earliestMatch: {
        start: number;
        end: number;
        type: string;
        text: string;
      } | null = null;

      for (const pattern of patterns) {
        pattern.regex.lastIndex = cursor;
        const match = pattern.regex.exec(text);
        if (match && (!earliestMatch || match.index < earliestMatch.start)) {
          earliestMatch = {
            start: match.index,
            end: pattern.regex.lastIndex,
            type: pattern.type,
            text: match[0],
          };
        }
      }

      if (!earliestMatch) {
        pushPlainText(text.slice(cursor));
        break;
      }

      pushPlainText(text.slice(cursor, earliestMatch.start));

      const innerText = earliestMatch.text.slice(1, -1);

      switch (earliestMatch.type) {
        case 'code': {
          const codeInner = innerText.startsWith('```') ? innerText.slice(3, -3) : innerText;
          parts.push(
            <Text key={parts.length} color={COLORS.accent} inverse>
              {' '}
              {codeInner.trim()}{' '}
            </Text>
          );
          break;
        }
        case 'bold-italic':
          parts.push(
            <Text key={parts.length} bold italic color={COLORS.primary}>
              {innerText}
            </Text>
          );
          break;
        case 'bold':
          parts.push(
            <Text key={parts.length} bold color={COLORS.primary}>
              {innerText}
            </Text>
          );
          break;
        case 'italic':
          parts.push(
            <Text key={parts.length} italic color={COLORS.primary}>
              {innerText}
            </Text>
          );
          break;
        case 'strikethrough':
          parts.push(
            <Text key={parts.length} strikethrough color={COLORS.muted}>
              {innerText}
            </Text>
          );
          break;
        case 'link': {
          const linkMatch = earliestMatch.text.match(/\[([^\]]+)\]\(([^)]+)\)/);
          if (linkMatch) {
            parts.push(
              <Text key={parts.length} color={COLORS.accent} underline>
                {linkMatch[1]}
              </Text>
            );
          }
          break;
        }
        case 'symbol':
          parts.push(
            <Text key={parts.length} color={COLORS.accent} bold>
              {earliestMatch.text}
            </Text>
          );
          break;
      }

      cursor = earliestMatch.end;
    }

    return parts.length > 0 ? parts : text;
  };

  if (inline) {
    return <>{renderInline(content)}</>;
  }

  // Multi-line paragraphs: one Text row per line (no extra margin between
  // lines). Single marginBottom after the whole block for paragraph spacing.
  const lines = content.split('\n');
  if (lines.length > 1) {
    return (
      <Box flexDirection="column" marginBottom={SPACING.xs} width={maxWidth}>
        {lines.map((line, index) => (
          <Text key={index} wrap="wrap">
            {renderInline(line)}
          </Text>
        ))}
      </Box>
    );
  }

  return (
    <Box marginBottom={SPACING.xs} width={maxWidth}>
      <Text wrap="wrap">{renderInline(content)}</Text>
    </Box>
  );
}

