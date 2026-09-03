import { describe, expect, it } from 'vitest';
import { statusLinePropsEqual } from './StatusLine.js';
import type { GitStatus } from '../../services/GitService.js';
import type { ContextUsage } from '../../services/ContextUsageService.js';

describe('StatusLine memo comparator', () => {
  const baseGitStatus: GitStatus = {
    branch: 'main',
    modified: 0,
    staged: 0,
    untracked: 0,
    isDirty: false,
  };

  const baseContextUsage: ContextUsage = {
    used: 50000,
    total: 200000,
    percent: 25,
    remaining: 150000,
    level: 'ok',
    contextWindow: 200000,
  };

  const baseProps = {
    executionMode: 'normal' as const,
    currentModel: 'claude-sonnet-4-20250514',
    isProcessing: false,
    activeTools: ['Read', 'Write'],
    gitStatus: baseGitStatus,
    contextUsage: baseContextUsage,
  };

  describe('does not re-render when props unchanged', () => {
    it('returns true when all props are identical', () => {
      const result = statusLinePropsEqual(baseProps, baseProps);
      expect(result).toBe(true);
    });

    it('returns true when props have same values but different object references', () => {
      const nextProps = {
        executionMode: 'normal' as const,
        currentModel: 'claude-sonnet-4-20250514',
        isProcessing: false,
        activeTools: ['Read', 'Write'],
        gitStatus: baseGitStatus,
        contextUsage: baseContextUsage,
      };
      const result = statusLinePropsEqual(baseProps, nextProps);
      expect(result).toBe(true);
    });
  });

  describe('re-renders when isProcessing changes', () => {
    it('returns false when isProcessing changes from false to true', () => {
      const nextProps = { ...baseProps, isProcessing: true };
      const result = statusLinePropsEqual(baseProps, nextProps);
      expect(result).toBe(false);
    });

    it('returns false when isProcessing changes from true to false', () => {
      const prevProps = { ...baseProps, isProcessing: true };
      const nextProps = { ...baseProps, isProcessing: false };
      const result = statusLinePropsEqual(prevProps, nextProps);
      expect(result).toBe(false);
    });
  });

  describe('re-renders when contextUsage changes', () => {
    it('returns false when contextUsage percentage changes', () => {
      const nextProps = {
        ...baseProps,
        contextUsage: { ...baseContextUsage, percentage: 50 },
      };
      const result = statusLinePropsEqual(baseProps, nextProps);
      expect(result).toBe(false);
    });

    it('returns false when contextUsage goes from null to a value', () => {
      const prevProps = { ...baseProps, contextUsage: null };
      const result = statusLinePropsEqual(prevProps, baseProps);
      expect(result).toBe(false);
    });

    it('returns false when contextUsage goes from a value to null', () => {
      const nextProps = { ...baseProps, contextUsage: null };
      const result = statusLinePropsEqual(baseProps, nextProps);
      expect(result).toBe(false);
    });
  });

  describe('does not re-render when unrelated parent state changes', () => {
    it('returns true when only gitStatus reference is same (no re-render)', () => {
      const nextProps = {
        ...baseProps,
      };
      const result = statusLinePropsEqual(baseProps, nextProps);
      expect(result).toBe(true);
    });

    it('returns false when gitStatus reference changes', () => {
      const nextProps = {
        ...baseProps,
        gitStatus: { ...baseGitStatus, modified: 3 },
      };
      const result = statusLinePropsEqual(baseProps, nextProps);
      expect(result).toBe(false);
    });

    it('returns true when activeTools array has same content but different reference', () => {
      const nextProps = {
        ...baseProps,
        activeTools: ['Read', 'Write'],
      };
      const result = statusLinePropsEqual(baseProps, nextProps);
      expect(result).toBe(true);
    });

    it('returns true when executionMode is same string reference', () => {
      const nextProps = { ...baseProps };
      const result = statusLinePropsEqual(baseProps, nextProps);
      expect(result).toBe(true);
    });
  });

  describe('re-renders when core props change', () => {
    it('returns false when executionMode changes', () => {
      const nextProps = { ...baseProps, executionMode: 'auto-approve' as const };
      const result = statusLinePropsEqual(baseProps, nextProps);
      expect(result).toBe(false);
    });

    it('returns false when currentModel changes', () => {
      const nextProps = { ...baseProps, currentModel: 'gpt-4o' };
      const result = statusLinePropsEqual(baseProps, nextProps);
      expect(result).toBe(false);
    });

    it('returns false when activeTools content changes', () => {
      const nextProps = { ...baseProps, activeTools: ['Read', 'Write', 'Bash'] };
      const result = statusLinePropsEqual(baseProps, nextProps);
      expect(result).toBe(false);
    });
  });

  describe('handles undefined and null edge cases', () => {
    it('returns true when both have undefined optional props', () => {
      const prevProps = {
        executionMode: 'normal' as const,
        currentModel: undefined,
        isProcessing: undefined,
        activeTools: undefined,
        gitStatus: undefined,
        contextUsage: undefined,
      };
      const nextProps = { ...prevProps };
      const result = statusLinePropsEqual(prevProps, nextProps);
      expect(result).toBe(true);
    });

    it('returns true when both have null gitStatus', () => {
      const prevProps = { ...baseProps, gitStatus: null };
      const nextProps = { ...baseProps, gitStatus: null };
      const result = statusLinePropsEqual(prevProps, nextProps);
      expect(result).toBe(true);
    });

    it('returns true when both have null contextUsage', () => {
      const prevProps = { ...baseProps, contextUsage: null };
      const nextProps = { ...baseProps, contextUsage: null };
      const result = statusLinePropsEqual(prevProps, nextProps);
      expect(result).toBe(true);
    });
  });

  describe('token budget props', () => {
    it('returns true when token budget props are identical', () => {
      const prevProps = {
        ...baseProps,
        tokenBudgetUsed: 12500,
        tokenBudgetTotal: 50000,
        tokenBudgetElapsedMs: 10000,
        rateLimitRemaining: 45,
      };
      const nextProps = { ...prevProps };
      const result = statusLinePropsEqual(prevProps, nextProps);
      expect(result).toBe(true);
    });

    it('returns false when tokenBudgetUsed changes', () => {
      const prevProps = {
        ...baseProps,
        tokenBudgetUsed: 12500,
        tokenBudgetTotal: 50000,
        tokenBudgetElapsedMs: 10000,
      };
      const nextProps = { ...prevProps, tokenBudgetUsed: 15000 };
      const result = statusLinePropsEqual(prevProps, nextProps);
      expect(result).toBe(false);
    });

    it('returns false when tokenBudgetTotal changes', () => {
      const prevProps = {
        ...baseProps,
        tokenBudgetUsed: 12500,
        tokenBudgetTotal: 50000,
        tokenBudgetElapsedMs: 10000,
      };
      const nextProps = { ...prevProps, tokenBudgetTotal: 60000 };
      const result = statusLinePropsEqual(prevProps, nextProps);
      expect(result).toBe(false);
    });

    it('returns false when rateLimitRemaining changes', () => {
      const prevProps = {
        ...baseProps,
        tokenBudgetUsed: 12500,
        tokenBudgetTotal: 50000,
        tokenBudgetElapsedMs: 10000,
        rateLimitRemaining: 45,
      };
      const nextProps = { ...prevProps, rateLimitRemaining: 30 };
      const result = statusLinePropsEqual(prevProps, nextProps);
      expect(result).toBe(false);
    });

    it('returns true when both have undefined token budget props', () => {
      const prevProps = {
        ...baseProps,
        tokenBudgetUsed: undefined,
        tokenBudgetTotal: undefined,
        tokenBudgetElapsedMs: undefined,
        rateLimitRemaining: undefined,
      };
      const nextProps = { ...prevProps };
      const result = statusLinePropsEqual(prevProps, nextProps);
      expect(result).toBe(true);
    });
  });
});
