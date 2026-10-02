import { describe, it, expect } from 'vitest';
import { ContentRouter } from './content-router';
import { ContentType } from '@dyna/contracts';

describe('ContentRouter', () => {
  const router = new ContentRouter();

  // 1. classify() returns JSON type for valid JSON string
  it('classify() returns JSON type for valid JSON string', () => {
    const result = router.classify('{"name": "test", "value": 42}');
    expect(result.contentType).toBe(ContentType.JSON);
  });

  // 2. classify() returns CODE type for code with function keyword
  it('classify() returns CODE type for code with function keyword', () => {
    const result = router.classify('function add(a, b) { return a + b; }');
    expect(result.contentType).toBe(ContentType.CODE);
  });

  // 3. classify() returns DIFF type for git diff content
  it('classify() returns DIFF type for git diff content', () => {
    const diff = `--- a/file.ts
+++ b/file.ts
@@ -1,5 +1,6 @@
-const x = 1;
+const x = 2;`;
    const result = router.classify(diff);
    expect(result.contentType).toBe(ContentType.DIFF);
  });

  // 4. classify() returns PLAINTEXT for plain English text
  it('classify() returns PLAINTEXT for plain English text', () => {
    const result = router.classify('The quick brown fox jumps over the lazy dog.');
    expect(result.contentType).toBe(ContentType.PLAINTEXT);
  });

  // 5. classify() returns ERROR type for stack trace
  it('classify() returns ERROR type for stack trace', () => {
    const stackTrace = `Error: Something went wrong
    at Object.<anonymous> (C:\\test.js:10:15)
    at Module._compile (internal/modules/cjs/loader.js:1137:30)`;
    const result = router.classify(stackTrace);
    expect(result.contentType).toBe(ContentType.ERROR);
  });

  // 6. classify() returns LOG type for log with timestamp
  it('classify() returns LOG type for log with timestamp', () => {
    const log = '2024-01-15T10:30:00.000Z [INFO] Server started successfully';
    const result = router.classify(log);
    expect(result.contentType).toBe(ContentType.LOG);
  });

  // 7. classify() returns PLAINTEXT for empty whitespace
  it('classify() returns PLAINTEXT for empty/whitespace content', () => {
    const result = router.classify('   ');
    expect(result.contentType).toBe(ContentType.PLAINTEXT);
  });

  // 8. route() classifies multiple items and returns array
  it('route() classifies multiple items and returns array', () => {
    const items = [
      '{"a": 1}',
      'function foo() {}',
      'Just some plain text.',
    ];
    const results = router.route(items);
    expect(results).toHaveLength(3);
    expect(results[0].contentType).toBe(ContentType.JSON);
    expect(results[1].contentType).toBe(ContentType.CODE);
    expect(results[2].contentType).toBe(ContentType.PLAINTEXT);
  });

  // 9. Confidence for JSON detection > 0.90
  it('confidence for JSON detection is > 0.90', () => {
    const result = router.classify('{"key": "value"}');
    expect(result.confidence).toBeGreaterThan(0.90);
  });

  // 10. DetectedBy field contains correct source name
  it('detectedBy field contains correct source name for each tier', () => {
    expect(router.classify('{"a":1}').detectedBy).toBe('heuristic/json');
    expect(router.classify('function x(){}').detectedBy).toBe('keyword/code');
    expect(router.classify('plain text here').detectedBy).toBe('fallback/unknown');
  });

  // 11. XML content classified as JSON (heuristic)
  it('XML content classified as JSON (heuristic)', () => {
    const xml = '<root><item id="1">value</item></root>';
    const result = router.classify(xml);
    expect(result.contentType).toBe(ContentType.JSON);
    expect(result.detectedBy).toBe('heuristic/xml');
  });

  // 12. SQL content classified as CODE
  it('SQL content classified as CODE', () => {
    const sql = 'SELECT * FROM users WHERE id = 1';
    const result = router.classify(sql);
    expect(result.contentType).toBe(ContentType.CODE);
  });

  // 13. Edge case: very long string doesn't crash
  it('handles very long string without crashing', () => {
    const longStr = 'hello world '.repeat(10000);
    const result = router.classify(longStr);
    expect(result).toBeDefined();
    expect(result.contentType).toBe(ContentType.PLAINTEXT);
  });

  // 14. Edge case: special characters only
  it('handles special characters only', () => {
    const result = router.classify('@#$%^&*()_+{}[]|\\:;"\'<>,.?/~`');
    expect(result).toBeDefined();
    expect(result.contentType).toBe(ContentType.PLAINTEXT);
  });

  // Additional tests for robustness

  it('detects markdown code fences as CODE', () => {
    const mdBlock = '```\nconst x = 1;\n```';
    const result = router.classify(mdBlock);
    expect(result.contentType).toBe(ContentType.CODE);
    expect(result.detectedBy).toBe('heuristic/codefence');
  });

  it('detects log entries with [ERROR] pattern', () => {
    const log = '[ERROR] Failed to connect to database';
    const result = router.classify(log);
    expect(result.contentType).toBe(ContentType.LOG);
  });

  it('detects log entries with WARNING: prefix', () => {
    const log = 'WARNING: Disk space is low';
    const result = router.classify(log);
    expect(result.contentType).toBe(ContentType.LOG);
  });

  it('detects Python stack traces', () => {
    const trace = 'Traceback (most recent call last):\n  File "test.py", line 10, in <module>\n    main()\n  File "test.py", line 5, in main\n    raise ValueError("invalid")';
    const result = router.classify(trace);
    expect(result.contentType).toBe(ContentType.ERROR);
  });

  it('detects Java/TS stack traces with "at " pattern', () => {
    const trace = 'Error: null pointer\n  at com.example.Main.run(Main.java:20)';
    const result = router.classify(trace);
    expect(result.contentType).toBe(ContentType.ERROR);
  });

  it('detects search result patterns', () => {
    const searchResult = 'score: 0.95, relevance: high, found 10 results';
    const result = router.classify(searchResult);
    expect(result.contentType).toBe(ContentType.SEARCH_RESULT);
  });

  it('detects <?xml declaration as JSON-adjacent', () => {
    const xmlDecl = '<?xml version="1.0" encoding="UTF-8"?><root><item>val</item></root>';
    const result = router.classify(xmlDecl);
    expect(result.contentType).toBe(ContentType.JSON);
  });

  it('detects code with const/let/var keywords', () => {
    expect(router.classify('const x = 42;').contentType).toBe(ContentType.CODE);
    expect(router.classify('let y = "hello";').contentType).toBe(ContentType.CODE);
    expect(router.classify('var z = true;').contentType).toBe(ContentType.CODE);
  });

  it('detects code with import/export statements', () => {
    expect(router.classify('import { foo } from "bar";').contentType).toBe(ContentType.CODE);
    expect(router.classify('export default class App {}').contentType).toBe(ContentType.CODE);
  });

  it('detects code with interface/class definitions', () => {
    expect(router.classify('interface User { name: string; }').contentType).toBe(ContentType.CODE);
    expect(router.classify('class Animal { constructor() {} }').contentType).toBe(ContentType.CODE);
  });

  it('returns confidence between 0 and 1 for all routes', () => {
    const items = [
      '{"a":1}',
      '<root><item/></root>',
      '```code```',
      '---\n+++\n@@',
      '2024-01-01T00:00:00Z',
      'Error: test',
      'const x = 1',
      'SELECT * FROM t',
      'score: 1',
      'plain text',
    ];
    const results = router.route(items);
    for (const r of results) {
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
    }
  });
});

