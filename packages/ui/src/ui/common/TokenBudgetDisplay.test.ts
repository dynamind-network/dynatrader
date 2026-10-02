import { describe, expect, it } from 'vitest';
import {
  formatTokenCount,
  getTokenBudgetColor,
  buildTokenBudgetText,
  buildRateLimitText,
} from './TokenBudgetDisplay.js';

describe('TokenBudgetDisplay pure functions', () => {
  describe('formatTokenCount', () => {
    it('formats numbers under 1000 as-is', () => {
      expect(formatTokenCount(0)).toBe('0');
      expect(formatTokenCount(1)).toBe('1');
      expect(formatTokenCount(500)).toBe('500');
      expect(formatTokenCount(999)).toBe('999');
    });

    it('formats thousands with k suffix', () => {
      expect(formatTokenCount(1000)).toBe('1.0k');
      expect(formatTokenCount(1500)).toBe('1.5k');
      expect(formatTokenCount(12500)).toBe('12.5k');
      expect(formatTokenCount(99999)).toBe('100.0k');
    });

    it('formats millions with m suffix', () => {
      expect(formatTokenCount(1000000)).toBe('1.0m');
      expect(formatTokenCount(1500000)).toBe('1.5m');
      expect(formatTokenCount(12500000)).toBe('12.5m');
    });

    it('handles edge cases', () => {
      expect(formatTokenCount(100)).toBe('100');
      expect(formatTokenCount(10000)).toBe('10.0k');
    });
  });

  describe('getTokenBudgetColor', () => {
    it('returns green for usage under 50%', () => {
      expect(getTokenBudgetColor(0)).toBe('green');
      expect(getTokenBudgetColor(25)).toBe('green');
      expect(getTokenBudgetColor(49)).toBe('green');
    });

    it('returns yellow for usage between 50% and 80%', () => {
      expect(getTokenBudgetColor(50)).toBe('yellow');
      expect(getTokenBudgetColor(65)).toBe('yellow');
      expect(getTokenBudgetColor(80)).toBe('yellow');
    });

    it('returns red for usage above 80%', () => {
      expect(getTokenBudgetColor(81)).toBe('red');
      expect(getTokenBudgetColor(95)).toBe('red');
      expect(getTokenBudgetColor(100)).toBe('red');
    });
  });

  describe('buildTokenBudgetText', () => {
    it('formats basic token budget without ETA', () => {
      const result = buildTokenBudgetText({
        used: 12500,
        budget: 50000,
        elapsedMs: 0,
      });
      expect(result).toBe('12.5k / 50.0k (25%)');
    });

    it('shows ETA when rate is available (elapsed > 5s and tokens >= 2000)', () => {
      const result = buildTokenBudgetText({
        used: 10000,
        budget: 50000,
        elapsedMs: 10000,
      });
      // 10000 tokens / 10000ms = 1 token/ms
      // remaining = 40000 tokens, ETA = 40000ms = 40s
      expect(result).toContain('10.0k / 50.0k (20%)');
      expect(result).toContain('~');
    });

    it('does not show ETA when elapsed is too short', () => {
      const result = buildTokenBudgetText({
        used: 5000,
        budget: 50000,
        elapsedMs: 3000,
      });
      expect(result).toBe('5.0k / 50.0k (10%)');
      expect(result).not.toContain('~');
    });

    it('does not show ETA when token count is too low', () => {
      const result = buildTokenBudgetText({
        used: 500,
        budget: 50000,
        elapsedMs: 10000,
      });
      expect(result).toBe('500 / 50.0k (1%)');
      expect(result).not.toContain('~');
    });

    it('handles zero budget gracefully', () => {
      const result = buildTokenBudgetText({
        used: 1000,
        budget: 0,
        elapsedMs: 0,
      });
      expect(result).toContain('1.0k');
    });

    it('handles used exceeding budget', () => {
      const result = buildTokenBudgetText({
        used: 60000,
        budget: 50000,
        elapsedMs: 0,
      });
      expect(result).toContain('60.0k / 50.0k');
      expect(result).toContain('120%');
    });
  });

  describe('buildRateLimitText', () => {
    it('returns null when no rate limit remaining', () => {
      expect(buildRateLimitText(undefined)).toBeNull();
      expect(buildRateLimitText(null)).toBeNull();
      expect(buildRateLimitText(0)).toBeNull();
    });

    it('returns rate limit countdown text', () => {
      expect(buildRateLimitText(45)).toBe('Rate limit: 45s');
      expect(buildRateLimitText(1)).toBe('Rate limit: 1s');
      expect(buildRateLimitText(120)).toBe('Rate limit: 120s');
    });

    it('formats minutes when over 60 seconds', () => {
      expect(buildRateLimitText(120)).toBe('Rate limit: 120s');
    });
  });
});

