import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SmartCrusher } from './smart-crusher';
import { TokenCounter } from './token-counter';
import { ContentRouter } from './content-router';
import { ContentType } from '@dyna/contracts';
import type { CompressionResult, CompressionManifestEntry } from '@dyna/contracts';

describe('SmartCrusher', () => {
  let crusher: SmartCrusher;
  let tokenCounter: TokenCounter;
  let contentRouter: ContentRouter;

  beforeEach(() => {
    tokenCounter = new TokenCounter();
    contentRouter = new ContentRouter();
    crusher = new SmartCrusher(tokenCounter, contentRouter);
  });

  afterEach(() => {
    tokenCounter.close();
  });

  // ---------------------------------------------------------------------------
  // compressJson
  // ---------------------------------------------------------------------------

  describe('compressJson', () => {
    it('preserves top-level keys and truncates long string values', () => {
      const longValue = 'a'.repeat(200);
      const json = JSON.stringify({ key1: 'short', key2: longValue, key3: 42 });
      const result = crusher.compress(json, ContentType.JSON);

      const parsed = JSON.parse(result.compressed);
      expect(parsed).toHaveProperty('key1', 'short');
      expect(parsed).toHaveProperty('key3', 42);

      // key2 should be truncated to 100 chars
      expect(parsed.key2.length).toBe(100);
      expect(parsed.key2).toBe('a'.repeat(100));

      // Manifest should have a truncated entry for key2
      const truncatedEntries = result.manifest.filter(e => e.action === 'truncated');
      expect(truncatedEntries.length).toBeGreaterThanOrEqual(1);

      // originalTokens should be > 0
      expect(result.originalTokens).toBeGreaterThan(0);
      // ratio should be > 0
      expect(result.ratio).toBeGreaterThan(0);
    });

    it('preserves ID fields when preserveIdFields=true', () => {
      const crusherWithIds = new SmartCrusher(tokenCounter, contentRouter, {
        preserveIdFields: true,
      });
      const longId = 'x'.repeat(150);
      const longOther = 'y'.repeat(150);
      const json = JSON.stringify({
        id: longId,
        name: 'short-name',
        description: longOther,
        status: 'active',
      });
      const result = crusherWithIds.compress(json, ContentType.JSON);
      const parsed = JSON.parse(result.compressed);

      // ID field preserved intact
      expect(parsed.id).toBe(longId);
      expect(parsed.id.length).toBe(150);

      // name is short anyway, preserved
      expect(parsed.name).toBe('short-name');

      // status is short, preserved
      expect(parsed.status).toBe('active');

      // description (not in ID fields) should be truncated
      expect(parsed.description.length).toBe(100);
    });

    it('preserves UUID, _id, type fields when preserveIdFields=true', () => {
      const crusherWithIds = new SmartCrusher(tokenCounter, contentRouter, {
        preserveIdFields: true,
      });
      const longUuid = 'u'.repeat(150);
      const longType = 't'.repeat(150);
      const json = JSON.stringify({
        uuid: longUuid,
        _id: 'shorty',
        type: longType,
      });
      const result = crusherWithIds.compress(json, ContentType.JSON);
      const parsed = JSON.parse(result.compressed);

      expect(parsed.uuid).toBe(longUuid);
      expect(parsed._id).toBe('shorty');
      expect(parsed.type).toBe(longType);
    });

    it('falls through to compressGeneric when JSON is invalid', () => {
      const result = crusher.compress('not valid json at all', ContentType.JSON);
      // Generic compression with small content - should pass through as-is
      expect(result.compressed).toBe('not valid json at all');
      expect(result.ratio).toBeCloseTo(1.0, 1);
    });

    it('handles JSON arrays at top level', () => {
      const arr = ['short', 'a'.repeat(200), 42];
      const json = JSON.stringify(arr);
      const result = crusher.compress(json, ContentType.JSON);
      const parsed = JSON.parse(result.compressed);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(3);
    });
  });

  // ---------------------------------------------------------------------------
  // compressDiff
  // ---------------------------------------------------------------------------

  describe('compressDiff', () => {
    it('truncates long +/- lines and preserves @@ headers', () => {
      const crusherDiff = new SmartCrusher(tokenCounter, contentRouter, {
        diffMaxLineLength: 50,
      });
      const longLine = '+ ' + 'a'.repeat(200);
      const diff = [
        '--- a/file.ts',
        '+++ b/file.ts',
        '@@ -1,5 +1,6 @@',
        '-const x = 1;',
        longLine,
        ' normal line',
      ].join('\n');

      const result = crusherDiff.compress(diff, ContentType.DIFF);
      const lines = result.compressed.split('\n');

      // Header lines preserved
      expect(lines[0]).toBe('--- a/file.ts');
      expect(lines[1]).toBe('+++ b/file.ts');
      // @@ line preserved
      expect(lines[2]).toBe('@@ -1,5 +1,6 @@');
      // Short - lines preserved
      expect(lines[3]).toBe('-const x = 1;');
      // Long + lines truncated
      expect(lines[4].length).toBeLessThan(longLine.length);
      expect(lines[4].length).toBeLessThanOrEqual(50 + 3); // truncated with ...
      // Normal line preserved
      expect(lines[5]).toBe(' normal line');
    });

    it('preserves short +/- lines intact', () => {
      const diff = [
        '--- a/test.ts',
        '+++ b/test.ts',
        '@@ -1 +1 @@',
        '-old code',
        '+new code',
      ].join('\n');

      const result = crusher.compress(diff, ContentType.DIFF);
      const lines = result.compressed.split('\n');
      expect(lines[3]).toBe('-old code');
      expect(lines[4]).toBe('+new code');
    });
  });

  // ---------------------------------------------------------------------------
  // compressLog
  // ---------------------------------------------------------------------------

  describe('compressLog', () => {
    it('keeps first/last N lines and summarizes middle', () => {
      const crusherLog = new SmartCrusher(tokenCounter, contentRouter, {
        logKeepHeadTail: 3,
      });
      const lines: string[] = [];
      for (let i = 1; i <= 15; i++) {
        lines.push(`Line ${i}: some log data here`);
      }
      const log = lines.join('\n');

      const result = crusherLog.compress(log, ContentType.LOG);
      const compressedLines = result.compressed.split('\n');

      // First 3 lines preserved
      expect(compressedLines[0]).toBe('Line 1: some log data here');
      expect(compressedLines[1]).toBe('Line 2: some log data here');
      expect(compressedLines[2]).toBe('Line 3: some log data here');

      // Middle summary present
      const summaryLine = compressedLines.find(l => l.includes('omitted'));
      expect(summaryLine).toBeDefined();
      expect(summaryLine).toContain('9 lines omitted'); // 15 - 3 - 3 = 9

      // Last 3 lines preserved
      const lastIdx = compressedLines.length - 1;
      expect(compressedLines[lastIdx]).toBe('Line 15: some log data here');
      expect(compressedLines[lastIdx - 1]).toBe('Line 14: some log data here');
      expect(compressedLines[lastIdx - 2]).toBe('Line 13: some log data here');
    });

    it('handles log content with fewer lines than head+tail', () => {
      const lines = ['Line 1', 'Line 2', 'Line 3'];
      const log = lines.join('\n');

      const result = crusher.compress(log, ContentType.LOG);
      const compressedLines = result.compressed.split('\n');

      // All lines preserved when total <= head + tail
      expect(compressedLines).toHaveLength(3);
      expect(compressedLines[0]).toBe('Line 1');
      expect(compressedLines[2]).toBe('Line 3');
    });
  });

  // ---------------------------------------------------------------------------
  // compressGeneric
  // ---------------------------------------------------------------------------

  describe('compressGeneric', () => {
    it('returns content as-is when under maxTokens', () => {
      const shortContent = 'Hello, this is a short piece of content.';
      const result = crusher.compress(shortContent, ContentType.PLAINTEXT);

      expect(result.compressed).toBe(shortContent);
      expect(result.ratio).toBeCloseTo(1.0, 2);
      expect(result.originalTokens).toBeGreaterThan(0);
    });

    it('truncates when over maxTokens', () => {
      const crusherSmall = new SmartCrusher(tokenCounter, contentRouter, {
        maxTokens: 5,
      });
      // Create content longer than 5 tokens
      const longContent = 'one two three four five six seven eight nine ten';
      const result = crusherSmall.compress(longContent, ContentType.PLAINTEXT);

      expect(result.compressed.length).toBeLessThan(longContent.length);
      expect(result.compressedTokens).toBeLessThanOrEqual(result.originalTokens);
      expect(result.ratio).toBeLessThan(1);
    });
  });

  // ---------------------------------------------------------------------------
  // shouldCrusherActivate
  // ---------------------------------------------------------------------------

  describe('shouldCrusherActivate', () => {
    it('returns true for content over threshold', () => {
      // Create content that's definitely over 10 tokens
      const longContent = 'word '.repeat(50);
      expect(crusher.shouldCrusherActivate(longContent, 10)).toBe(true);
    });

    it('returns false for content under threshold', () => {
      const shortContent = 'short';
      expect(crusher.shouldCrusherActivate(shortContent, 100)).toBe(false);
    });

    it('uses config.maxTokens as default threshold', () => {
      const crusherSmall = new SmartCrusher(tokenCounter, contentRouter, {
        maxTokens: 3,
      });
      const content = 'this has more than three tokens';
      expect(crusherSmall.shouldCrusherActivate(content)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // compressMany
  // ---------------------------------------------------------------------------

  describe('compressMany', () => {
    it('compresses multiple items and returns array', () => {
      const items = [
        { content: '{"name": "' + 'a'.repeat(150) + '"}', contentType: ContentType.JSON },
        { content: 'short text', contentType: ContentType.PLAINTEXT },
        { content: 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\nline11\nline12\nline13\nline14\nline15', contentType: ContentType.LOG },
      ];
      const results = crusher.compressMany(items);
      expect(results).toHaveLength(3);
      results.forEach(r => {
        expect(r).toHaveProperty('compressed');
        expect(r).toHaveProperty('originalTokens');
        expect(r).toHaveProperty('compressedTokens');
        expect(r).toHaveProperty('ratio');
        expect(r).toHaveProperty('manifest');
        expect(r).toHaveProperty('ccrs');
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Contract / invariant tests
  // ---------------------------------------------------------------------------

  describe('compression invariants', () => {
    it('compression ratio is always between 0 and 1', () => {
      const contents = [
        { content: '{"a":"' + 'b'.repeat(200) + '"}', contentType: ContentType.JSON },
        { content: '--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-old line\n+new line', contentType: ContentType.DIFF },
        { content: 'short text', contentType: ContentType.PLAINTEXT },
        { content: 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\np\nq\nr\ns\nt\nu\nv', contentType: ContentType.LOG },
      ];
      const results = crusher.compressMany(contents);
      for (const r of results) {
        expect(r.ratio).toBeGreaterThanOrEqual(0);
        expect(r.ratio).toBeLessThanOrEqual(1);
      }
    });

    it('original token count is always > 0 for non-empty content', () => {
      const result = crusher.compress('some non-empty content here', ContentType.PLAINTEXT);
      expect(result.originalTokens).toBeGreaterThan(0);
      expect(result.compressedTokens).toBeGreaterThan(0);
    });

    it('empty content returns empty compression', () => {
      const result = crusher.compress('', ContentType.PLAINTEXT);
      expect(result.compressed).toBe('');
      expect(result.originalTokens).toBe(0);
      expect(result.compressedTokens).toBe(0);
      expect(result.ratio).toBe(0);
    });

    it('compressed output is always a valid string for valid inputs', () => {
      const testCases = [
        { content: 'hello world', contentType: ContentType.PLAINTEXT },
        { content: '{"key":"value"}', contentType: ContentType.JSON },
        { content: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b', contentType: ContentType.DIFF },
        { content: '2024-01-01T00:00:00Z [INFO] test', contentType: ContentType.LOG },
      ];
      for (const tc of testCases) {
        const result = crusher.compress(tc.content, tc.contentType);
        expect(typeof result.compressed).toBe('string');
        expect(result.compressed.length).toBeGreaterThan(0);
      }
    });

    it('manifest entries have correct structure', () => {
      const longJson = JSON.stringify({ data: 'x'.repeat(150), name: 'test' });
      const result = crusher.compress(longJson, ContentType.JSON);

      for (const entry of result.manifest) {
        expect(entry).toHaveProperty('originalOffset');
        expect(entry).toHaveProperty('compressedOffset');
        expect(entry).toHaveProperty('originalLength');
        expect(entry).toHaveProperty('compressedLength');
        expect(entry).toHaveProperty('action');
        expect(entry).toHaveProperty('contentType');
        expect(['preserved', 'truncated', 'summarized', 'ccr_replaced', 'removed']).toContain(entry.action);
      }
    });

    it('ccrs array is always empty for SmartCrusher', () => {
      const testCases = [
        { content: 'some text', contentType: ContentType.PLAINTEXT },
        { content: '{"a":1}', contentType: ContentType.JSON },
      ];
      for (const tc of testCases) {
        const result = crusher.compress(tc.content, tc.contentType);
        expect(result.ccrs).toEqual([]);
      }
    });
  });
});

