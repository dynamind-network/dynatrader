import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getThinkingVerbs,
  formatElapsedTime,
  getDisplayElapsedMs,
  formatTokensUsed,
} from './ThinkingAnimation.js';

describe('ThinkingAnimation enhanced', () => {
  describe('getThinkingVerbs', () => {
    it('returns a non-empty array of verb phrases', () => {
      const verbs = getThinkingVerbs();
      expect(verbs.length).toBeGreaterThan(0);
    });

    it('each verb phrase is a non-empty string', () => {
      const verbs = getThinkingVerbs();
      for (const verb of verbs) {
        expect(typeof verb).toBe('string');
        expect(verb.length).toBeGreaterThan(0);
      }
    });

    it('contains expected variety of verbs', () => {
      const verbs = getThinkingVerbs();
      const verbText = verbs.join(' ').toLowerCase();
      // Should contain multiple distinct action words
      expect(verbText).toMatch(/thinking|analyzing|processing/);
    });

    it('returns the same array on repeated calls (stable reference)', () => {
      const verbs1 = getThinkingVerbs();
      const verbs2 = getThinkingVerbs();
      expect(verbs1).toBe(verbs2);
    });
  });

  describe('formatElapsedTime', () => {
    it('formats milliseconds under 1 second as 0s', () => {
      expect(formatElapsedTime(500)).toBe('0s');
    });

    it('formats 1000ms as 1s', () => {
      expect(formatElapsedTime(1000)).toBe('1s');
    });

    it('formats 2500ms as 2s', () => {
      expect(formatElapsedTime(2500)).toBe('2s');
    });

    it('formats 60000ms as 1m 0s', () => {
      expect(formatElapsedTime(60000)).toBe('1m 0s');
    });

    it('formats 61000ms as 1m 1s', () => {
      expect(formatElapsedTime(61000)).toBe('1m 1s');
    });

    it('formats 120000ms as 2m 0s', () => {
      expect(formatElapsedTime(120000)).toBe('2m 0s');
    });

    it('formats 3661000ms as 61m 1s', () => {
      expect(formatElapsedTime(3661000)).toBe('61m 1s');
    });

    it('handles zero milliseconds', () => {
      expect(formatElapsedTime(0)).toBe('0s');
    });
  });

  describe('getDisplayElapsedMs', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns null before minimum display time', () => {
      const startTime = Date.now();
      vi.advanceTimersByTime(1000);
      const result = getDisplayElapsedMs(startTime, 2000);
      expect(result).toBeNull();
    });

    it('returns elapsed ms after minimum display time', () => {
      const startTime = Date.now();
      vi.advanceTimersByTime(3000);
      const result = getDisplayElapsedMs(startTime, 2000);
      expect(result).toBeGreaterThan(0);
    });

    it('returns null at exactly minimum display time boundary', () => {
      const startTime = Date.now();
      vi.advanceTimersByTime(1999);
      const result = getDisplayElapsedMs(startTime, 2000);
      expect(result).toBeNull();
    });

    it('returns elapsed ms at exactly 2000ms', () => {
      const startTime = Date.now();
      vi.advanceTimersByTime(2000);
      const result = getDisplayElapsedMs(startTime, 2000);
      expect(result).toBeGreaterThanOrEqual(0);
    });

    it('returns increasing values as time passes', () => {
      const startTime = Date.now();
      vi.advanceTimersByTime(3000);
      const result1 = getDisplayElapsedMs(startTime, 2000);
      vi.advanceTimersByTime(2000);
      const result2 = getDisplayElapsedMs(startTime, 2000);
      expect(result2).toBeGreaterThan(result1!);
    });

    it('respects custom minimum display time', () => {
      const startTime = Date.now();
      vi.advanceTimersByTime(4000);
      const result = getDisplayElapsedMs(startTime, 5000);
      expect(result).toBeNull();
    });
  });

  describe('formatTokensUsed', () => {
    it('formats zero as ~0', () => {
      expect(formatTokensUsed(0)).toBe('~0');
    });

    it('formats small counts without suffix', () => {
      expect(formatTokensUsed(500)).toBe('~500');
    });

    it('formats exact thousands with integer suffix', () => {
      expect(formatTokensUsed(1000)).toBe('~1k');
    });

    it('formats thousands with one decimal', () => {
      expect(formatTokensUsed(1200)).toBe('~1.2k');
    });

    it('formats large thousands with integer suffix', () => {
      expect(formatTokensUsed(15000)).toBe('~15k');
    });

    it('formats exact millions with integer suffix', () => {
      expect(formatTokensUsed(1_000_000)).toBe('~1m');
    });

    it('formats millions with one decimal', () => {
      expect(formatTokensUsed(1_500_000)).toBe('~1.5m');
    });

    it('formats 999 as ~999 (below 1k threshold)', () => {
      expect(formatTokensUsed(999)).toBe('~999');
    });
  });
});

