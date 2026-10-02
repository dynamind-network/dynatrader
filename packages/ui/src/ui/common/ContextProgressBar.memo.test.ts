import { describe, expect, it } from 'vitest';
import { contextProgressBarPropsEqual } from './ContextProgressBar.js';
import type { ContextUsage } from '../../services/ContextUsageService.js';

describe('ContextProgressBar memo comparator', () => {
  const baseUsage: ContextUsage = {
    used: 50000,
    total: 200000,
    percent: 25,
    remaining: 150000,
    level: 'ok',
    contextWindow: 200000,
  };

  describe('does not re-render when props unchanged', () => {
    it('returns true when all props are identical (same reference)', () => {
      const props = { usage: baseUsage, width: 20, showPercentage: true };
      const result = contextProgressBarPropsEqual(props, props);
      expect(result).toBe(true);
    });

    it('returns true when usage object is same reference', () => {
      const prevProps = { usage: baseUsage, width: 20, showPercentage: true };
      const nextProps = { usage: baseUsage, width: 20, showPercentage: true };
      const result = contextProgressBarPropsEqual(prevProps, nextProps);
      expect(result).toBe(true);
    });

    it('returns true when both have null usage', () => {
      const prevProps = { usage: null as ContextUsage | null, width: 20, showPercentage: true };
      const nextProps = { usage: null as ContextUsage | null, width: 20, showPercentage: true };
      const result = contextProgressBarPropsEqual(prevProps, nextProps);
      expect(result).toBe(true);
    });

    it('returns true when width and showPercentage are same defaults', () => {
      const prevProps = { usage: baseUsage };
      const nextProps = { usage: baseUsage };
      const result = contextProgressBarPropsEqual(prevProps, nextProps);
      expect(result).toBe(true);
    });
  });

  describe('re-renders when usage changes', () => {
    it('returns false when usage percent changes', () => {
      const prevProps = { usage: baseUsage, width: 20, showPercentage: true };
      const nextProps = {
        usage: { ...baseUsage, percent: 50 },
        width: 20,
        showPercentage: true,
      };
      const result = contextProgressBarPropsEqual(prevProps, nextProps);
      expect(result).toBe(false);
    });

    it('returns false when usage level changes', () => {
      const prevProps = { usage: baseUsage, width: 20, showPercentage: true };
      const nextProps = {
        usage: { ...baseUsage, level: 'warning' as const },
        width: 20,
        showPercentage: true,
      };
      const result = contextProgressBarPropsEqual(prevProps, nextProps);
      expect(result).toBe(false);
    });

    it('returns false when usage goes from null to a value', () => {
      const prevProps = { usage: null as ContextUsage | null, width: 20, showPercentage: true };
      const nextProps = { usage: baseUsage, width: 20, showPercentage: true };
      const result = contextProgressBarPropsEqual(prevProps, nextProps);
      expect(result).toBe(false);
    });

    it('returns false when usage goes from a value to null', () => {
      const prevProps = { usage: baseUsage, width: 20, showPercentage: true };
      const nextProps = { usage: null as ContextUsage | null, width: 20, showPercentage: true };
      const result = contextProgressBarPropsEqual(prevProps, nextProps);
      expect(result).toBe(false);
    });

    it('returns false when usage used value changes', () => {
      const prevProps = { usage: baseUsage, width: 20, showPercentage: true };
      const nextProps = {
        usage: { ...baseUsage, used: 60000 },
        width: 20,
        showPercentage: true,
      };
      const result = contextProgressBarPropsEqual(prevProps, nextProps);
      expect(result).toBe(false);
    });
  });

  describe('re-renders when width changes', () => {
    it('returns false when width changes', () => {
      const prevProps = { usage: baseUsage, width: 20, showPercentage: true };
      const nextProps = { usage: baseUsage, width: 30, showPercentage: true };
      const result = contextProgressBarPropsEqual(prevProps, nextProps);
      expect(result).toBe(false);
    });
  });

  describe('re-renders when showPercentage changes', () => {
    it('returns false when showPercentage changes from true to false', () => {
      const prevProps = { usage: baseUsage, width: 20, showPercentage: true };
      const nextProps = { usage: baseUsage, width: 20, showPercentage: false };
      const result = contextProgressBarPropsEqual(prevProps, nextProps);
      expect(result).toBe(false);
    });

    it('returns false when showPercentage changes from false to true', () => {
      const prevProps = { usage: baseUsage, width: 20, showPercentage: false };
      const nextProps = { usage: baseUsage, width: 20, showPercentage: true };
      const result = contextProgressBarPropsEqual(prevProps, nextProps);
      expect(result).toBe(false);
    });
  });

  describe('handles edge cases', () => {
    it('returns true when both have undefined optional props', () => {
      const prevProps = { usage: baseUsage };
      const nextProps = { usage: baseUsage };
      const result = contextProgressBarPropsEqual(prevProps, nextProps);
      expect(result).toBe(true);
    });

    it('returns false when usage object reference changes even with same values', () => {
      const prevProps = { usage: baseUsage, width: 20, showPercentage: true };
      const nextProps = {
        usage: { ...baseUsage },
        width: 20,
        showPercentage: true,
      };
      // Different object reference should trigger re-render
      const result = contextProgressBarPropsEqual(prevProps, nextProps);
      expect(result).toBe(false);
    });
  });
});

