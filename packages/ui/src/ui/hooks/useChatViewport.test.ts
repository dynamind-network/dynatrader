import { describe, it, expect } from 'vitest';
import {
  useChatViewport,
  createScrollHandlers,
  getAdjustedScrollOffset,
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

describe('getAdjustedScrollOffset', () => {
  it('stays pinned when content grows at the bottom', () => {
    expect(getAdjustedScrollOffset(0, 100, 110, 20, 90)).toBe(0);
  });

  it('stays pinned when content grows within the follow threshold', () => {
    expect(getAdjustedScrollOffset(2, 100, 110, 20, 90)).toBe(0);
  });

  it('keeps a scrolled-up view anchored when content grows below it', () => {
    expect(getAdjustedScrollOffset(30, 100, 110, 20, 90)).toBe(40);
  });

  it('preserves a deliberate small scroll when content height is unchanged', () => {
    expect(getAdjustedScrollOffset(2, 100, 100, 20, 80)).toBe(2);
  });

  it('moves the offset with content shrink to keep the same rows anchored', () => {
    expect(getAdjustedScrollOffset(40, 110, 100, 20, 80)).toBe(30);
  });

  it('uses a larger follow threshold for tall viewports', () => {
    expect(getAdjustedScrollOffset(10, 100, 110, 100, 190)).toBe(0);
    expect(getAdjustedScrollOffset(11, 100, 110, 100, 190)).toBe(21);
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

