import { describe, expect, it } from 'vitest';
import { thinkingAnimationPropsEqual } from './ThinkingAnimation.js';

describe('ThinkingAnimation memo comparator', () => {
  describe('does not re-render when props unchanged', () => {
    it('returns true when both have undefined activeTools', () => {
      const prevProps = {};
      const nextProps = {};
      const result = thinkingAnimationPropsEqual(prevProps, nextProps);
      expect(result).toBe(true);
    });

    it('returns true when both have empty activeTools arrays', () => {
      const prevProps = { activeTools: [] as string[] };
      const nextProps = { activeTools: [] as string[] };
      const result = thinkingAnimationPropsEqual(prevProps, nextProps);
      expect(result).toBe(true);
    });

    it('returns true when activeTools have same content but different reference', () => {
      const prevProps = { activeTools: ['Read', 'Write'] };
      const nextProps = { activeTools: ['Read', 'Write'] };
      const result = thinkingAnimationPropsEqual(prevProps, nextProps);
      expect(result).toBe(true);
    });

    it('returns true when same object reference is passed', () => {
      const props = { activeTools: ['Read', 'Write'] };
      const result = thinkingAnimationPropsEqual(props, props);
      expect(result).toBe(true);
    });
  });

  describe('re-renders when activeTools change', () => {
    it('returns false when activeTools content changes', () => {
      const prevProps = { activeTools: ['Read'] };
      const nextProps = { activeTools: ['Read', 'Write'] };
      const result = thinkingAnimationPropsEqual(prevProps, nextProps);
      expect(result).toBe(false);
    });

    it('returns false when activeTools goes from empty to non-empty', () => {
      const prevProps = { activeTools: [] as string[] };
      const nextProps = { activeTools: ['Read'] };
      const result = thinkingAnimationPropsEqual(prevProps, nextProps);
      expect(result).toBe(false);
    });

    it('returns false when activeTools goes from non-empty to empty', () => {
      const prevProps = { activeTools: ['Read'] };
      const nextProps = { activeTools: [] as string[] };
      const result = thinkingAnimationPropsEqual(prevProps, nextProps);
      expect(result).toBe(false);
    });

    it('returns false when activeTools order changes', () => {
      const prevProps = { activeTools: ['Read', 'Write'] };
      const nextProps = { activeTools: ['Write', 'Read'] };
      const result = thinkingAnimationPropsEqual(prevProps, nextProps);
      expect(result).toBe(false);
    });

    it('returns false when activeTools goes from undefined to defined', () => {
      const prevProps = {};
      const nextProps = { activeTools: ['Read'] };
      const result = thinkingAnimationPropsEqual(prevProps, nextProps);
      expect(result).toBe(false);
    });

    it('returns false when activeTools goes from defined to undefined', () => {
      const prevProps = { activeTools: ['Read'] };
      const nextProps = {};
      const result = thinkingAnimationPropsEqual(prevProps, nextProps);
      expect(result).toBe(false);
    });
  });

  describe('new prop comparisons', () => {
    it('returns true when tokensUsed is same', () => {
      const prevProps = { tokensUsed: 1200 } as any;
      const nextProps = { tokensUsed: 1200 } as any;
      expect(thinkingAnimationPropsEqual(prevProps, nextProps)).toBe(true);
    });

    it('returns false when tokensUsed changes', () => {
      const prevProps = { tokensUsed: 1200 } as any;
      const nextProps = { tokensUsed: 2400 } as any;
      expect(thinkingAnimationPropsEqual(prevProps, nextProps)).toBe(false);
    });

    it('returns true when toolIndex/toolTotal/toolName are same', () => {
      const prevProps = { toolIndex: 1, toolTotal: 3, toolName: 'read' } as any;
      const nextProps = { toolIndex: 1, toolTotal: 3, toolName: 'read' } as any;
      expect(thinkingAnimationPropsEqual(prevProps, nextProps)).toBe(true);
    });

    it('returns false when toolIndex changes', () => {
      const prevProps = { toolIndex: 0, toolTotal: 3 } as any;
      const nextProps = { toolIndex: 1, toolTotal: 3 } as any;
      expect(thinkingAnimationPropsEqual(prevProps, nextProps)).toBe(false);
    });

    it('returns false when toolTotal changes', () => {
      const prevProps = { toolIndex: 1, toolTotal: 3 } as any;
      const nextProps = { toolIndex: 1, toolTotal: 5 } as any;
      expect(thinkingAnimationPropsEqual(prevProps, nextProps)).toBe(false);
    });

    it('returns false when toolName changes', () => {
      const prevProps = { toolName: 'read' } as any;
      const nextProps = { toolName: 'write' } as any;
      expect(thinkingAnimationPropsEqual(prevProps, nextProps)).toBe(false);
    });

    it('returns true when width is same', () => {
      const prevProps = { width: 80 } as any;
      const nextProps = { width: 80 } as any;
      expect(thinkingAnimationPropsEqual(prevProps, nextProps)).toBe(true);
    });

    it('returns false when width changes', () => {
      const prevProps = { width: 80 } as any;
      const nextProps = { width: 120 } as any;
      expect(thinkingAnimationPropsEqual(prevProps, nextProps)).toBe(false);
    });
  });
});

