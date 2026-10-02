import { describe, it, expect } from 'vitest';
import { computeViewportVisibility, type DOMElement } from './useTerminalViewport.js';

/**
 * Helper to create a mock DOM element with yoga node.
 */
function mockElement(options: {
  height: number;
  top: number;
  parent?: DOMElement | null;
}): DOMElement {
  const yogaNode = {
    getComputedHeight: () => options.height,
    getComputedTop: () => options.top,
  };
  return {
    yogaNode,
    parentNode: options.parent ?? null,
    scrollTop: undefined,
  };
}

/**
 * Helper to create a mock scroll container parent.
 */
function mockScrollContainer(options: {
  height: number;
  top: number;
  scrollTop: number;
  parent?: DOMElement | null;
}): DOMElement {
  const yogaNode = {
    getComputedHeight: () => options.height,
    getComputedTop: () => options.top,
  };
  return {
    yogaNode,
    parentNode: options.parent ?? null,
    scrollTop: options.scrollTop,
  };
}

describe('computeViewportVisibility', () => {
  it('returns visible with 0 rows when element is null', () => {
    const result = computeViewportVisibility(null, 24);
    expect(result.isVisible).toBe(true);
    expect(result.visibleRows).toBe(0);
  });

  it('returns visible with 0 rows when element has no yogaNode', () => {
    const element: DOMElement = {
      yogaNode: null,
      parentNode: null,
    };
    const result = computeViewportVisibility(element, 24);
    expect(result.isVisible).toBe(true);
    expect(result.visibleRows).toBe(0);
  });

  it('reports visible when element is within viewport bounds', () => {
    const root = mockElement({ height: 24, top: 0 });
    const element = mockElement({ height: 3, top: 5, parent: root });

    const result = computeViewportVisibility(element, 24);

    expect(result.isVisible).toBe(true);
    expect(result.visibleRows).toBe(3);
  });

  it('reports hidden when element is scrolled offscreen (below viewport)', () => {
    const root = mockElement({ height: 24, top: 0 });
    const element = mockElement({ height: 3, top: 30, parent: root });

    const result = computeViewportVisibility(element, 24);

    expect(result.isVisible).toBe(false);
  });

  it('reports hidden when element is above the visible viewport', () => {
    const root = mockElement({ height: 24, top: 0 });
    const scrollContainer = mockScrollContainer({
      height: 24,
      top: 0,
      scrollTop: 20,
      parent: null,
    });
    const element = mockElement({ height: 3, top: 5, parent: scrollContainer });

    const result = computeViewportVisibility(element, 24);

    // After scrollTop adjustment: absoluteTop = 5 - 20 = -15, bottom = -12
    // Viewport starts at 0, so element is above viewport
    expect(result.isVisible).toBe(false);
  });

  it('accounts for scrollTop when computing visibility', () => {
    const root = mockElement({ height: 24, top: 0 });
    const scrollContainer = mockScrollContainer({
      height: 24,
      top: 0,
      scrollTop: 10,
      parent: null,
    });
    const element = mockElement({ height: 3, top: 15, parent: scrollContainer });

    const result = computeViewportVisibility(element, 24);

    // After scrollTop adjustment: absoluteTop = 15 - 10 = 5, bottom = 8
    // Viewport: 0 to 24, so element at rows 5-8 should be visible
    expect(result.isVisible).toBe(true);
  });

  it('handles deeply nested parent chains correctly', () => {
    const root = mockElement({ height: 24, top: 0 });
    const middle = mockElement({ height: 20, top: 3, parent: root });
    const element = mockElement({ height: 2, top: 2, parent: middle });

    const result = computeViewportVisibility(element, 24);

    // absoluteTop = 2 + 3 + 0 = 5, bottom = 7
    // Viewport: 0 to 24, so visible
    expect(result.isVisible).toBe(true);
    expect(result.visibleRows).toBe(2);
  });

  it('handles cursor restore scroll offset when content overflows', () => {
    const root = mockElement({ height: 30, top: 0 });
    const element = mockElement({ height: 2, top: 25, parent: root });

    const result = computeViewportVisibility(element, 24);

    // With cursor restore scroll: viewportY = (30 - 24) + 1 = 7, viewportBottom = 7 + 24 = 31
    // Element: top = 25, bottom = 27
    // 27 > 7 && 25 < 31 => visible
    expect(result.isVisible).toBe(true);
  });

  it('reports hidden when element is just below the overflow-adjusted viewport', () => {
    const root = mockElement({ height: 30, top: 0 });
    const element = mockElement({ height: 2, top: 32, parent: root });

    const result = computeViewportVisibility(element, 24);

    // viewportY = 7, viewportBottom = 31
    // Element: top = 32, bottom = 34
    // 34 > 7 but 32 >= 31 => not visible
    expect(result.isVisible).toBe(false);
  });

  it('reports visible when element is partially overlapping the viewport top', () => {
    const root = mockElement({ height: 24, top: 0 });
    const element = mockElement({ height: 5, top: -2, parent: root });

    const result = computeViewportVisibility(element, 24);

    // absoluteTop = -2, bottom = 3
    // Viewport: 0 to 24
    // 3 > 0 && -2 < 24 => visible (partially)
    expect(result.isVisible).toBe(true);
  });

  it('reports visible when element is partially overlapping the viewport bottom', () => {
    const root = mockElement({ height: 24, top: 0 });
    const element = mockElement({ height: 5, top: 22, parent: root });

    const result = computeViewportVisibility(element, 24);

    // absoluteTop = 22, bottom = 27
    // Viewport: 0 to 24
    // 27 > 0 && 22 < 24 => visible (partially)
    expect(result.isVisible).toBe(true);
  });

  it('reports hidden when element is completely above viewport', () => {
    const root = mockElement({ height: 24, top: 0 });
    const element = mockElement({ height: 3, top: -10, parent: root });

    const result = computeViewportVisibility(element, 24);

    // absoluteTop = -10, bottom = -7
    // Viewport: 0 to 24
    // -7 > 0 is false => not visible
    expect(result.isVisible).toBe(false);
  });

  it('reports hidden when element is completely below viewport', () => {
    const root = mockElement({ height: 24, top: 0 });
    const element = mockElement({ height: 3, top: 24, parent: root });

    const result = computeViewportVisibility(element, 24);

    // absoluteTop = 24, bottom = 27
    // Viewport: 0 to 24
    // 27 > 0 but 24 < 24 is false => not visible
    expect(result.isVisible).toBe(false);
  });

  it('handles multiple scroll containers in the chain', () => {
    const root = mockElement({ height: 24, top: 0 });
    const outerScroll = mockScrollContainer({
      height: 24,
      top: 0,
      scrollTop: 5,
      parent: root,
    });
    const innerScroll = mockScrollContainer({
      height: 20,
      top: 0,
      scrollTop: 3,
      parent: outerScroll,
    });
    const element = mockElement({ height: 2, top: 15, parent: innerScroll });

    const result = computeViewportVisibility(element, 24);

    // absoluteTop = 15 - 5 - 3 = 7, bottom = 9
    // Viewport: 0 to 24
    expect(result.isVisible).toBe(true);
  });

  it('returns correct visibleRows for element height', () => {
    const root = mockElement({ height: 24, top: 0 });
    const element = mockElement({ height: 10, top: 5, parent: root });

    const result = computeViewportVisibility(element, 24);

    expect(result.visibleRows).toBe(10);
  });

  it('handles element at exact viewport boundary (top edge)', () => {
    const root = mockElement({ height: 24, top: 0 });
    const element = mockElement({ height: 3, top: 0, parent: root });

    const result = computeViewportVisibility(element, 24);

    // absoluteTop = 0, bottom = 3
    // 3 > 0 && 0 < 24 => visible
    expect(result.isVisible).toBe(true);
  });

  it('handles element at exact viewport boundary (bottom edge)', () => {
    const root = mockElement({ height: 24, top: 0 });
    const element = mockElement({ height: 3, top: 21, parent: root });

    const result = computeViewportVisibility(element, 24);

    // absoluteTop = 21, bottom = 24
    // 24 > 0 && 21 < 24 => visible
    expect(result.isVisible).toBe(true);
  });

  it('handles non-scroll parent nodes (no scrollTop)', () => {
    const root = mockElement({ height: 24, top: 0 });
    const nonScrollParent: DOMElement = {
      yogaNode: {
        getComputedHeight: () => 20,
        getComputedTop: () => 2,
      },
      parentNode: root,
      // No scrollTop property
    };
    const element = mockElement({ height: 3, top: 5, parent: nonScrollParent });

    const result = computeViewportVisibility(element, 24);

    // absoluteTop = 5 + 2 + 0 = 7, bottom = 10
    expect(result.isVisible).toBe(true);
  });
});

