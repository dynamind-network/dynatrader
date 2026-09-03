import { describe, it, expect } from 'vitest';
import {
  useChatViewport,
  createScrollHandlers,
  getAutoScrollOffset,
  computeScrollState,
} from './useChatViewport.js';

describe('createScrollHandlers', () => {
  function setup(maxScrollOffset: number, pageSize: number, initialOffset = 0) {
    let scrollOffset = initialOffset;
    const setScrollOffset = (updater: number | ((prev: number) => number)) => {
      if (typeof updater === 'function') {
        scrollOffset = (updater as (prev: number) => number)(scrollOffset);
      } else {
        scrollOffset = updater;
      }
    };
    const handlers = createScrollHandlers(setScrollOffset, maxScrollOffset, pageSize);
    return { handlers, getOffset: () => scrollOffset };
  }

  describe('pageUp', () => {
    it('increases scrollOffset by pageSize to scroll up to older messages', () => {
      const { handlers, getOffset } = setup(100, 10, 50);
      handlers.pageUp();
      expect(getOffset()).toBe(60);
    });

    it('clamps to maxScrollOffset at the top boundary', () => {
      const { handlers, getOffset } = setup(100, 10, 95);
      handlers.pageUp();
      expect(getOffset()).toBe(100);
    });

    it('scrolls up from bottom to see older messages', () => {
      const { handlers, getOffset } = setup(100, 10, 0);
      handlers.pageUp();
      expect(getOffset()).toBe(10);
    });
  });

  describe('pageDown', () => {
    it('decreases scrollOffset by pageSize to scroll down to newer messages', () => {
      const { handlers, getOffset } = setup(100, 10, 50);
      handlers.pageDown();
      expect(getOffset()).toBe(40);
    });

    it('clamps to 0 at the bottom boundary', () => {
      const { handlers, getOffset } = setup(100, 10, 5);
      handlers.pageDown();
      expect(getOffset()).toBe(0);
    });

    it('has no effect when already at bottom', () => {
      const { handlers, getOffset } = setup(100, 10, 0);
      handlers.pageDown();
      expect(getOffset()).toBe(0);
    });
  });

  describe('lineUp', () => {
    it('increases scrollOffset by 1 to scroll up to older messages', () => {
      const { handlers, getOffset } = setup(100, 10, 50);
      handlers.lineUp();
      expect(getOffset()).toBe(51);
    });

    it('clamps to maxScrollOffset at the top boundary', () => {
      const { handlers, getOffset } = setup(100, 10, 100);
      handlers.lineUp();
      expect(getOffset()).toBe(100);
    });
  });

  describe('lineDown', () => {
    it('decreases scrollOffset by 1 to scroll down to newer messages', () => {
      const { handlers, getOffset } = setup(100, 10, 50);
      handlers.lineDown();
      expect(getOffset()).toBe(49);
    });

    it('clamps to 0 at the bottom boundary', () => {
      const { handlers, getOffset } = setup(100, 10, 0);
      handlers.lineDown();
      expect(getOffset()).toBe(0);
    });
  });

  describe('jumpTop', () => {
    it('sets scrollOffset to maxScrollOffset', () => {
      const { handlers, getOffset } = setup(100, 10, 0);
      handlers.jumpTop();
      expect(getOffset()).toBe(100);
    });
  });

  describe('jumpBottom', () => {
    it('sets scrollOffset to 0', () => {
      const { handlers, getOffset } = setup(100, 10, 50);
      handlers.jumpBottom();
      expect(getOffset()).toBe(0);
    });
  });
});

describe('getAutoScrollOffset', () => {
  it('returns 0 when at bottom and new message arrives', () => {
    // offset=0, prevLen=5, currLen=6, pageSize=20
    const result = getAutoScrollOffset(0, 5, 6, 20);
    expect(result).toBe(0);
  });

  it('returns 0 when scrollOffset is within threshold and new message arrives', () => {
    // offset=2 is within threshold of max(3, floor(20*0.1))=3
    const result = getAutoScrollOffset(2, 5, 6, 20);
    expect(result).toBe(0);
  });

  it('returns 0 when scrollOffset equals threshold and new message arrives', () => {
    // offset=3 equals threshold of max(3, floor(20*0.1))=3
    const result = getAutoScrollOffset(3, 5, 6, 20);
    expect(result).toBe(0);
  });

  it('returns null when scrolled beyond threshold and new message arrives', () => {
    // offset=10 is beyond threshold of 3
    const result = getAutoScrollOffset(10, 5, 6, 20);
    expect(result).toBeNull();
  });

  it('returns null when no new message arrives', () => {
    const result = getAutoScrollOffset(0, 5, 5, 20);
    expect(result).toBeNull();
  });

  it('returns null when messages were removed', () => {
    const result = getAutoScrollOffset(0, 5, 4, 20);
    expect(result).toBeNull();
  });

  it('uses percentage-based threshold for large viewports', () => {
    // pageSize=100, threshold = max(3, floor(100*0.1)) = 10
    // offset=10 is within threshold
    expect(getAutoScrollOffset(10, 5, 6, 100)).toBe(0);
    // offset=11 is beyond threshold
    expect(getAutoScrollOffset(11, 5, 6, 100)).toBeNull();
  });
});

describe('computeScrollState', () => {
  it('isAtBottom is true when scrollOffset is 0', () => {
    const state = computeScrollState(0);
    expect(state.isAtBottom).toBe(true);
    expect(state.isUserScrolledUp).toBe(false);
  });

  it('isUserScrolledUp is true when scrollOffset is greater than 0', () => {
    const state = computeScrollState(1);
    expect(state.isAtBottom).toBe(false);
    expect(state.isUserScrolledUp).toBe(true);
  });

  it('isUserScrolledUp is true at max offset', () => {
    const state = computeScrollState(100);
    expect(state.isAtBottom).toBe(false);
    expect(state.isUserScrolledUp).toBe(true);
  });
});

describe('useChatViewport', () => {
  it('exports a function', async () => {
    expect(typeof useChatViewport).toBe('function');
  });
});
