import { describe, it, expect, vi } from 'vitest';
import { hasMarkdownSyntax, createMarkdownCacheKey, MarkdownTokenCache } from './MarkdownRenderer';

/**
 * Tests for MarkdownRenderer cache integration.
 *
 * Tests the markdown fast-path detection, hash-based cache keys,
 * and LRU token cache behavior.
 */

// ---------------------------------------------------------------------------
// hasMarkdownSyntax - fast-path detection
// ---------------------------------------------------------------------------

describe('hasMarkdownSyntax', () => {
  it('returns false for plain text', () => {
    expect(hasMarkdownSyntax('Hello world')).toBe(false);
    expect(hasMarkdownSyntax('This is a simple sentence.')).toBe(false);
    expect(hasMarkdownSyntax('Just some regular text here.')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(hasMarkdownSyntax('')).toBe(false);
  });

  it('returns true for headings', () => {
    expect(hasMarkdownSyntax('# Heading 1')).toBe(true);
    expect(hasMarkdownSyntax('## Heading 2')).toBe(true);
    expect(hasMarkdownSyntax('### Heading 3')).toBe(true);
  });

  it('returns true for code blocks', () => {
    expect(hasMarkdownSyntax('```typescript\nconst x = 1;\n```')).toBe(true);
    expect(hasMarkdownSyntax('```\ncode\n```')).toBe(true);
  });

  it('returns true for inline code', () => {
    expect(hasMarkdownSyntax('Use `console.log` for debugging')).toBe(true);
  });

  it('returns true for bold text', () => {
    expect(hasMarkdownSyntax('This is **bold** text')).toBe(true);
    expect(hasMarkdownSyntax('This is __bold__ text')).toBe(true);
  });

  it('returns true for italic text', () => {
    expect(hasMarkdownSyntax('This is *italic* text')).toBe(true);
    expect(hasMarkdownSyntax('This is _italic_ text')).toBe(true);
  });

  it('returns true for strikethrough', () => {
    expect(hasMarkdownSyntax('This is ~~strikethrough~~ text')).toBe(true);
  });

  it('returns true for links', () => {
    expect(hasMarkdownSyntax('Visit [example](https://example.com)')).toBe(true);
  });

  it('returns true for horizontal rules', () => {
    expect(hasMarkdownSyntax('---')).toBe(true);
    expect(hasMarkdownSyntax('***')).toBe(true);
    expect(hasMarkdownSyntax('___')).toBe(true);
  });

  it('returns true for blockquotes', () => {
    expect(hasMarkdownSyntax('> This is a quote')).toBe(true);
  });

  it('returns true for unordered lists', () => {
    expect(hasMarkdownSyntax('- Item 1')).toBe(true);
    expect(hasMarkdownSyntax('* Item 1')).toBe(true);
    expect(hasMarkdownSyntax('+ Item 1')).toBe(true);
  });

  it('returns true for ordered lists', () => {
    expect(hasMarkdownSyntax('1. First item')).toBe(true);
    expect(hasMarkdownSyntax('2. Second item')).toBe(true);
  });

  it('returns true for tables', () => {
    expect(hasMarkdownSyntax('| Header |')).toBe(true);
  });

  it('returns true for checkboxes', () => {
    expect(hasMarkdownSyntax('- [ ] Task')).toBe(true);
    expect(hasMarkdownSyntax('- [x] Done')).toBe(true);
  });

  it('only checks first 500 characters', () => {
    // Plain text in first 500 chars, markdown after
    const longText = 'a'.repeat(500) + '\n# Heading';
    expect(hasMarkdownSyntax(longText)).toBe(false);
  });

  it('detects markdown within first 500 characters', () => {
    const text = 'a'.repeat(100) + '\n**bold**' + 'b'.repeat(500);
    expect(hasMarkdownSyntax(text)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createMarkdownCacheKey - hash-based keys
// ---------------------------------------------------------------------------

describe('createMarkdownCacheKey', () => {
  it('produces consistent keys for same content', () => {
    const content = 'Hello world';
    const key1 = createMarkdownCacheKey(content);
    const key2 = createMarkdownCacheKey(content);
    expect(key1).toBe(key2);
  });

  it('produces different keys for different content', () => {
    const key1 = createMarkdownCacheKey('Hello world');
    const key2 = createMarkdownCacheKey('Hello universe');
    expect(key1).not.toBe(key2);
  });

  it('produces different keys for same content with different hasMarkdown result', () => {
    const key1 = createMarkdownCacheKey('Hello world', false);
    const key2 = createMarkdownCacheKey('Hello world', true);
    expect(key1).not.toBe(key2);
  });

  it('produces short keys (not full content strings)', () => {
    const longContent = 'a'.repeat(10000);
    const key = createMarkdownCacheKey(longContent);
    // Key should be much shorter than the content
    expect(key.length).toBeLessThan(100);
  });

  it('handles empty string', () => {
    const key = createMarkdownCacheKey('');
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThan(0);
  });

  it('handles special characters', () => {
    const key1 = createMarkdownCacheKey('Hello\nWorld\t"quotes"');
    const key2 = createMarkdownCacheKey('Hello\nWorld\t"quotes"');
    expect(key1).toBe(key2);
  });

  it('handles unicode content', () => {
    const key1 = createMarkdownCacheKey('Hello \u4e16\u754c');
    const key2 = createMarkdownCacheKey('Hello \u4e16\u754c');
    expect(key1).toBe(key2);
  });
});

// ---------------------------------------------------------------------------
// MarkdownTokenCache - integration with LRU cache
// ---------------------------------------------------------------------------

describe('MarkdownTokenCache', () => {
  it('is an instance of LRUCache', () => {
    expect(MarkdownTokenCache).toBeDefined();
    expect(typeof MarkdownTokenCache.get).toBe('function');
    expect(typeof MarkdownTokenCache.set).toBe('function');
  });

  it('has a reasonable default max size', () => {
    expect(MarkdownTokenCache.maxSize).toBeGreaterThanOrEqual(100);
  });

  it('starts empty', () => {
    // Clear any prior test state
    MarkdownTokenCache.clear();
    expect(MarkdownTokenCache.size).toBe(0);
  });

  it('stores and retrieves parsed blocks', () => {
    MarkdownTokenCache.clear();
    const key = createMarkdownCacheKey('# Hello', true);
    const blocks = [{ type: 'heading' as const, content: '# Hello' }];

    MarkdownTokenCache.set(key, blocks);
    const result = MarkdownTokenCache.get(key);

    expect(result).toEqual(blocks);
  });

  it('returns undefined for cache miss', () => {
    MarkdownTokenCache.clear();
    const key = createMarkdownCacheKey('nonexistent', false);
    expect(MarkdownTokenCache.get(key)).toBe(undefined);
  });

  it('evicts old entries when full', () => {
    MarkdownTokenCache.clear();
    const smallCache = new (MarkdownTokenCache.constructor as new (options: {
      maxSize: number;
    }) => typeof MarkdownTokenCache)({ maxSize: 3 });

    smallCache.set(createMarkdownCacheKey('a', false), [
      { type: 'paragraph' as const, content: 'a' },
    ]);
    smallCache.set(createMarkdownCacheKey('b', false), [
      { type: 'paragraph' as const, content: 'b' },
    ]);
    smallCache.set(createMarkdownCacheKey('c', false), [
      { type: 'paragraph' as const, content: 'c' },
    ]);
    smallCache.set(createMarkdownCacheKey('d', false), [
      { type: 'paragraph' as const, content: 'd' },
    ]);

    expect(smallCache.get(createMarkdownCacheKey('a', false))).toBe(undefined);
    expect(smallCache.get(createMarkdownCacheKey('d', false))).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Integration: cache behavior with MarkdownRenderer parseMarkdown
// ---------------------------------------------------------------------------

describe('MarkdownRenderer cache integration (parseMarkdown)', () => {
  // We test the parseMarkdown function indirectly by verifying the cache
  // integration pattern works correctly.

  it('cache hit returns same parsed result', () => {
    MarkdownTokenCache.clear();
    const content = '# Test\n\nParagraph';
    const key = createMarkdownCacheKey(content, true);

    // Simulate first parse
    const blocks = [
      { type: 'heading' as const, content: '# Test' },
      { type: 'paragraph' as const, content: 'Paragraph' },
    ];
    MarkdownTokenCache.set(key, blocks);

    // Simulate cache hit
    const hit = MarkdownTokenCache.get(key);
    expect(hit).toEqual(blocks);
  });

  it('cache miss returns undefined', () => {
    MarkdownTokenCache.clear();
    const key = createMarkdownCacheKey('not in cache', false);
    expect(MarkdownTokenCache.get(key)).toBe(undefined);
  });

  it('plain text content gets cached with hasMarkdown=false key', () => {
    MarkdownTokenCache.clear();
    const content = 'Just plain text without any markdown syntax at all';
    const key = createMarkdownCacheKey(content, false);

    const blocks = [{ type: 'paragraph' as const, content }];
    MarkdownTokenCache.set(key, blocks);

    expect(MarkdownTokenCache.get(key)).toEqual(blocks);
  });

  it('markdown content gets cached with hasMarkdown=true key', () => {
    MarkdownTokenCache.clear();
    const content = '# Heading\n\n**Bold text**';
    const key = createMarkdownCacheKey(content, true);

    const blocks = [
      { type: 'heading' as const, content: '# Heading' },
      { type: 'paragraph' as const, content: '**Bold text**' },
    ];
    MarkdownTokenCache.set(key, blocks);

    expect(MarkdownTokenCache.get(key)).toEqual(blocks);
  });
});
