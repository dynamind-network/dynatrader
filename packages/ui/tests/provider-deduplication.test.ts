import { describe, expect, it } from 'vitest';
import { normalizeAssistantText } from '../src/core/text-normalizer.js';

describe('provider/agent output deduplication', () => {
  it('collapses exact adjacent duplicated price tokens', () => {
    const result = normalizeAssistantText(
      'BTC is currently at $66,400.83$66,400.83, down from recent highs.'
    );

    expect(result).toBe('BTC is currently at $66,400.83, down from recent highs.');
  });

  it('preserves normal repeated prose that is not immediate duplication', () => {
    const result = normalizeAssistantText('Very very strong support remains in place.');

    expect(result).toBe('Very very strong support remains in place.');
  });

  it('splits malformed bullet continuations into separate lines', () => {
    const result = normalizeAssistantText('bearish signal) \u2022 **RSI: 46** - Neutral momentum');

    expect(result).toBe('bearish signal)\n\u2022 **RSI: 46** - Neutral momentum');
  });
});
