import { describe, expect, it } from 'vitest';
import {
  buildProgressBarString,
  buildProgressBarStringWithMinimum,
  BLOCKS,
  getBarColor,
} from './ContextProgressBar.js';
import type { ContextUsage } from '../../services/ContextUsageService.js';

describe('ContextProgressBar Unicode blocks', () => {
  const baseUsage: ContextUsage = {
    used: 50000,
    total: 200000,
    percent: 25,
    remaining: 150000,
    level: 'ok',
    contextWindow: 200000,
  };

  describe('BLOCKS array', () => {
    it('has 9 levels of granularity', () => {
      expect(BLOCKS.length).toBe(9);
    });

    it('first element is space (empty)', () => {
      expect(BLOCKS[0]).toBe(' ');
    });

    it('last element is full block', () => {
      expect(BLOCKS[8]).toBe('\u2588');
    });
  });

  describe('buildProgressBarString', () => {
    it('renders all empty blocks for 0%', () => {
      const result = buildProgressBarString(0, 5);
      expect(result).toBe(BLOCKS[0].repeat(5));
    });

    it('renders all filled blocks for 100%', () => {
      const result = buildProgressBarString(100, 5);
      expect(result).toBe(BLOCKS[8].repeat(5));
    });

    it('renders exact fill for 50% with width 10', () => {
      // 50% of 10 = 5.0 -> 5 full blocks, 0 remainder -> 5 empty
      const result = buildProgressBarString(50, 10);
      expect(result).toBe(BLOCKS[8].repeat(5) + BLOCKS[0].repeat(5));
    });

    it('renders partial block for non-integer fill (55%, width 10)', () => {
      // 55% of 10 = 5.5 -> 5 full, remainder 0.5 -> BLOCKS[floor(0.5*9)] = BLOCKS[4]
      const result = buildProgressBarString(55, 10);
      expect(result).toBe(BLOCKS[8].repeat(5) + BLOCKS[4] + BLOCKS[0].repeat(4));
    });

    it('renders single full block for 10% with width 10', () => {
      // 10% of 10 = 1.0 -> 1 full, 0 remainder -> 9 empty
      const result = buildProgressBarString(10, 10);
      expect(result).toBe(BLOCKS[8] + BLOCKS[0].repeat(9));
    });

    it('renders only partial block for small percentage (5%, width 10)', () => {
      // 5% of 10 = 0.5 -> 0 full, remainder 0.5 -> BLOCKS[floor(0.5*9)] = BLOCKS[4]
      const result = buildProgressBarString(5, 10);
      expect(result).toBe(BLOCKS[4] + BLOCKS[0].repeat(9));
    });

    it('renders very small partial block (1%, width 10)', () => {
      // 1% of 10 = 0.1 -> 0 full, remainder 0.1 -> BLOCKS[floor(0.1*9)] = BLOCKS[0]
      const result = buildProgressBarString(1, 10);
      expect(result).toBe(BLOCKS[0].repeat(10));
    });

    it('renders a visible minimum partial block when requested', () => {
      const result = buildProgressBarStringWithMinimum(0, 10, true);
      expect(result).toBe(BLOCKS[1] + BLOCKS[0].repeat(9));
    });

    it('renders width of 1 at 100%', () => {
      const result = buildProgressBarString(100, 1);
      expect(result).toBe(BLOCKS[8]);
    });

    it('renders width of 1 at 0%', () => {
      const result = buildProgressBarString(0, 1);
      expect(result).toBe(BLOCKS[0]);
    });

    it('renders width of 1 at 50%', () => {
      // 50% of 1 = 0.5 -> 0 full, remainder 0.5 -> BLOCKS[floor(0.5*9)] = BLOCKS[4]
      const result = buildProgressBarString(50, 1);
      expect(result).toBe(BLOCKS[4]);
    });

    it('always produces string of exact width', () => {
      for (const width of [1, 3, 5, 10, 20, 30]) {
        for (const percent of [0, 10, 25, 33, 50, 67, 75, 90, 99, 100]) {
          const result = buildProgressBarString(percent, width);
          expect(result.length).toBe(width);
        }
      }
    });

    it('clamps percent above 100 to full bar', () => {
      const result = buildProgressBarString(150, 5);
      expect(result).toBe(BLOCKS[8].repeat(5));
    });

    it('clamps percent below 0 to empty bar', () => {
      const result = buildProgressBarString(-10, 5);
      expect(result).toBe(BLOCKS[0].repeat(5));
    });
  });

  describe('getBarColor', () => {
    it('returns green for ok level', () => {
      expect(getBarColor('ok')).toBe('green');
    });

    it('returns yellow for warning level', () => {
      expect(getBarColor('warning')).toBe('yellow');
    });

    it('returns red for error level', () => {
      expect(getBarColor('error')).toBe('red');
    });

    it('returns red for critical level', () => {
      expect(getBarColor('critical')).toBe('red');
    });
  });
});
