import { describe, expect, it } from 'vitest';
import { calculateVisibleCount, buildMatchLabel } from './CommandPalette.js';

describe('CommandPalette height capping', () => {
  describe('calculateVisibleCount', () => {
    it('caps to minimum 3 on very small terminals (5 rows)', () => {
      expect(calculateVisibleCount(5)).toBe(3);
    });

    it('caps to minimum 3 on small terminals (10 rows)', () => {
      expect(calculateVisibleCount(10)).toBe(3);
    });

    it('allows more items on medium terminals (24 rows)', () => {
      const result = calculateVisibleCount(24);
      expect(result).toBeGreaterThan(3);
      expect(result).toBeLessThanOrEqual(15);
    });

    it('uses full 15 items on large terminals (50+ rows)', () => {
      expect(calculateVisibleCount(50)).toBe(15);
      expect(calculateVisibleCount(100)).toBe(15);
    });

    it('scales linearly between min and max', () => {
      const count20 = calculateVisibleCount(20);
      const count30 = calculateVisibleCount(30);
      expect(count30).toBeGreaterThanOrEqual(count20);
    });

    it('handles edge case of chrome rows boundary (12 total rows = 3 visible)', () => {
      expect(calculateVisibleCount(12)).toBe(3);
    });

    it('handles edge case of 24 rows (15 visible)', () => {
      expect(calculateVisibleCount(24)).toBe(15);
    });
  });

  describe('buildMatchLabel', () => {
    it('returns empty string when no query', () => {
      expect(buildMatchLabel('', 10)).toBe('');
    });

    it('returns match count with query', () => {
      expect(buildMatchLabel('help', 5)).toBe('5 matches');
    });

    it('returns singular match for count of 1', () => {
      expect(buildMatchLabel('help', 1)).toBe('1 match');
    });

    it('returns zero matches', () => {
      expect(buildMatchLabel('xyz', 0)).toBe('0 matches');
    });
  });
});

