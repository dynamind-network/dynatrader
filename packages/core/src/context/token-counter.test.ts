import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TokenCounter } from './token-counter';

describe('TokenCounter', () => {
  let counter: TokenCounter;

  beforeEach(() => {
    counter = new TokenCounter();
  });

  afterEach(() => {
    counter.close();
  });

  // 1. Basic counting
  it('count() returns correct tokens for known string', () => {
    const tokens = counter.count('Hello, world!');
    expect(tokens).toBeGreaterThan(0);
    expect(Number.isInteger(tokens)).toBe(true);
  });

  // 2. Model-specific: different models may use different encodings
  it('count() works with different model names', () => {
    const text = 'Hello, world! This is a test of different tokenizers.';
    const gpt4Tokens = counter.count(text, 'gpt-4');
    const gpt4oTokens = counter.count(text, 'gpt-4o');
    expect(gpt4Tokens).toBeGreaterThan(0);
    expect(gpt4oTokens).toBeGreaterThan(0);
    expect(Number.isInteger(gpt4Tokens)).toBe(true);
    expect(Number.isInteger(gpt4oTokens)).toBe(true);
  });

  it('unknown model falls back to default encoding', () => {
    const text = 'Some random text for testing';
    const defaultTokens = counter.count(text);
    const unknownTokens = counter.count(text, 'unknown-model-xyz');
    expect(unknownTokens).toBeGreaterThan(0);
    expect(unknownTokens).toBe(defaultTokens);
  });

  // 3. LRU cache: repeated calls return same result
  it('LRU cache returns same result for repeated calls', () => {
    const text = 'This is a test string for caching verification.';
    const first = counter.count(text);
    const second = counter.count(text);
    expect(first).toBe(second);
  });

  it('LRU cache returns same result across different model calls', () => {
    const text = 'Cache test with model specified';
    const first = counter.count(text, 'gpt-4');
    const second = counter.count(text, 'gpt-4');
    expect(first).toBe(second);
  });

  // 4. Cache eviction
  it('evicts oldest entry when cache exceeds max size', () => {
    const smallCache = new TokenCounter(3);
    // Fill the cache
    smallCache.count('entry number one here with some text');
    smallCache.count('entry number two here with some text');
    smallCache.count('entry number three here with some text');
    // This should trigger eviction of the oldest entry
    smallCache.count('entry number four causing eviction');
    // The cache should still function
    expect(smallCache.count('another test entry')).toBeGreaterThan(0);
    smallCache.close();
  });

  it('constructor respects custom max cache size', () => {
    const tinyCache = new TokenCounter(1);
    tinyCache.count('first entry to fill the single slot');
    tinyCache.count('second entry should evict the first');
    // Should not throw
    expect(tinyCache.count('third entry still works')).toBeGreaterThan(0);
    tinyCache.close();
  });

  // 5. Tokenize returns array of numbers
  it('tokenize() returns array of numbers', () => {
    const tokens = counter.tokenize('Hello, world!');
    expect(Array.isArray(tokens)).toBe(true);
    expect(tokens.length).toBeGreaterThan(0);
    expect(typeof tokens[0]).toBe('number');
  });

  it('tokenize() with model returns array of numbers', () => {
    const tokens = counter.tokenize('Tokenize me with gpt-4o', 'gpt-4o');
    expect(Array.isArray(tokens)).toBe(true);
    expect(tokens.length).toBeGreaterThan(0);
    tokens.forEach(t => expect(typeof t).toBe('number'));
  });

  // 6. Estimate fallback
  it('estimate() returns chars/4 math for normal text', () => {
    const text = 'Hello, world!';
    const expected = Math.ceil(text.length / 4);
    expect(counter.estimate(text)).toBe(expected);
  });

  it('estimate() works for longer text', () => {
    const text = 'A'.repeat(100);
    const expected = Math.ceil(100 / 4);
    expect(counter.estimate(text)).toBe(expected);
  });

  it('estimate() works for odd-length strings', () => {
    expect(counter.estimate('abc')).toBe(Math.ceil(3 / 4)); // 1
    expect(counter.estimate('abcde')).toBe(Math.ceil(5 / 4)); // 2
    expect(counter.estimate('abcdefg')).toBe(Math.ceil(7 / 4)); // 2
  });

  // 7. countMessages
  it('countMessages counts tokens across message array', () => {
    const messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ];
    const total = counter.countMessages(messages);
    // user: count('Hello') + 4
    // assistant: count('Hi there') + 4 + 3
    const expected =
      counter.count('Hello') + 4 +
      counter.count('Hi there') + 4 + 3;
    expect(total).toBe(expected);
  });

  it('countMessages works with single message', () => {
    const messages = [{ role: 'user', content: 'Just one message' }];
    const total = counter.countMessages(messages);
    const expected = counter.count('Just one message') + 4;
    expect(total).toBe(expected);
  });

  it('countMessages with assistant role adds prefix tokens', () => {
    const userMsg = { role: 'user', content: 'Hello' };
    const assistantMsg = { role: 'assistant', content: 'World' };
    const userTotal = counter.countMessages([userMsg]);
    const assistantTotal = counter.countMessages([assistantMsg]);
    // Assistant should have 3 extra tokens vs user
    expect(assistantTotal - userTotal).toBe(
      counter.count('World') - counter.count('Hello') + 3
    );
  });

  // 8. breakdown
  it('breakdown returns per-message breakdown', () => {
    const messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ];
    const result = counter.breakdown(messages);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toBe('Hello');
    expect(result[0].tokens).toBe(counter.count('Hello') + 4);
    expect(result[1].role).toBe('assistant');
    expect(result[1].content).toBe('Hi there');
    expect(result[1].tokens).toBe(counter.count('Hi there') + 4 + 3);
  });

  it('breakdown includes correct fields', () => {
    const messages = [
      { role: 'system', content: 'You are a helpful assistant.' },
    ];
    const result = counter.breakdown(messages);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveProperty('role');
    expect(result[0]).toHaveProperty('tokens');
    expect(result[0]).toHaveProperty('content');
    expect(result[0].role).toBe('system');
    expect(result[0].content).toBe('You are a helpful assistant.');
    expect(result[0].tokens).toBe(counter.count('You are a helpful assistant.') + 4);
  });

  // 9. close / clearCache
  it('clearCache works without error', () => {
    counter.count('some text to cache');
    expect(() => counter.clearCache()).not.toThrow();
  });

  it('close works without error', () => {
    const c = new TokenCounter();
    c.count('text to use encoding');
    expect(() => c.close()).not.toThrow();
  });

  it('close frees encodings and cache', () => {
    const c = new TokenCounter();
    c.count('test one', 'gpt-4');
    c.count('test two', 'gpt-4o');
    c.close();
    // close should not throw, subsequent calls will create new encodings
    expect(() => c.clearCache()).not.toThrow();
  });

  // 10. Edge cases
  it('empty string returns 0 for count', () => {
    expect(counter.count('')).toBe(0);
  });

  it('empty string returns empty array for tokenize', () => {
    expect(counter.tokenize('')).toEqual([]);
  });

  it('empty string estimate returns 0', () => {
    expect(counter.estimate('')).toBe(0);
  });

  it('empty messages array returns 0 for countMessages', () => {
    expect(counter.countMessages([])).toBe(0);
  });

  it('empty messages array returns empty array for breakdown', () => {
    expect(counter.breakdown([])).toEqual([]);
  });

  it('handles strings with special characters', () => {
    const tokens = counter.count('Special chars: @#$%^&*()');
    expect(tokens).toBeGreaterThan(0);
  });

  it('handles very long strings without error', () => {
    const longText = 'hello world '.repeat(1000);
    const tokens = counter.count(longText);
    expect(tokens).toBeGreaterThan(0);
  });
});

