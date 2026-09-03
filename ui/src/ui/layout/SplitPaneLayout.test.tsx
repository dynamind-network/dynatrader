import { describe, it, expect } from 'vitest';
import React from 'react';
import { Box, Text } from 'ink';
import { SplitPaneLayoutView } from './SplitPaneLayout.js';

/** Recursively find all elements matching a given type in a React element tree */
function findByType(element: any, type: any): any[] {
  const results: any[] = [];
  if (!element || typeof element !== 'object') return results;
  if (element.type === type) results.push(element);
  const children = element.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      results.push(...findByType(child, type));
    }
  } else if (children && typeof children === 'object') {
    results.push(...findByType(children, type));
  }
  return results;
}

/** Get the root Box of a rendered SplitPaneLayoutView */
function renderLayout(props: {
  splitActive: boolean;
  leftPane: React.ReactNode;
  rightPane: React.ReactNode;
  terminalWidth?: number;
  terminalHeight?: number;
  splitRatio?: number;
}) {
  return SplitPaneLayoutView({
    terminalWidth: 80,
    terminalHeight: 24,
    splitRatio: 50,
    ...props,
  });
}

describe('SplitPaneLayout', () => {
  it('renders single pane when splitActive=false', () => {
    const result = renderLayout({
      splitActive: false,
      leftPane: <Text>Left Content</Text>,
      rightPane: <Text>Right Content</Text>,
    });

    const boxes = findByType(result, Box);
    // Root should be a single column box
    expect(boxes[0].props.flexDirection).toBe('column');

    // Should contain left pane text
    const texts = findByType(result, Text);
    const textContents = texts.map((t) => t.props.children);
    expect(textContents).toContain('Left Content');
    expect(textContents).not.toContain('Right Content');
  });

  it('renders two panes with separator when splitActive=true', () => {
    const result = renderLayout({
      splitActive: true,
      leftPane: <Text>Left Content</Text>,
      rightPane: <Text>Right Content</Text>,
    });

    const boxes = findByType(result, Box);
    // Root should be a row box
    expect(boxes[0].props.flexDirection).toBe('row');

    // Should contain both left and right text
    const texts = findByType(result, Text);
    const textContents = texts.map((t) => t.props.children);
    expect(textContents).toContain('Left Content');
    expect(textContents).toContain('Right Content');
  });

  it('renders a vertical separator between panes', () => {
    const result = renderLayout({
      splitActive: true,
      leftPane: <Text>Left</Text>,
      rightPane: <Text>Right</Text>,
    });

    const texts = findByType(result, Text);
    const separator = texts.find((t) => t.props.children === '│');
    expect(separator).toBeDefined();
    expect(separator.props.color).toBe('gray');
  });

  it('renders three child boxes when split active (left, separator, right)', () => {
    const result = renderLayout({
      splitActive: true,
      leftPane: <Text>Left</Text>,
      rightPane: <Text>Right</Text>,
    });

    const root = findByType(result, Box)[0];
    const childBoxes = findByType(root, Box).filter((b) => b !== root);

    // Should have exactly 3 child boxes: left pane, separator, right pane
    expect(childBoxes).toHaveLength(3);
  });

  it('uses explicit widths instead of flexGrow for panes', () => {
    const result = renderLayout({
      splitActive: true,
      leftPane: <Text>Left</Text>,
      rightPane: <Text>Right</Text>,
      splitRatio: 60,
    });

    const root = findByType(result, Box)[0];
    const childBoxes = findByType(root, Box).filter((b) => b !== root);

    // All child boxes should have flexGrow=0 (width-based sizing)
    for (const box of childBoxes) {
      expect(box.props.flexGrow).toBe(0);
    }
  });

  it('calculates left and right widths from splitRatio', () => {
    const result = renderLayout({
      splitActive: true,
      leftPane: <Text>Left</Text>,
      rightPane: <Text>Right</Text>,
      terminalWidth: 100,
      splitRatio: 60,
    });

    const root = findByType(result, Box)[0];
    const childBoxes = findByType(root, Box).filter((b) => b !== root);

    // leftWidth = floor(100 * 60 / 100) = 60
    expect(childBoxes[0].props.width).toBe(60);
    // separator = 1
    expect(childBoxes[1].props.width).toBe(1);
    // rightWidth = 100 - 60 - 1 = 39
    expect(childBoxes[2].props.width).toBe(39);
  });

  it('defaults to 50/50 split', () => {
    const result = renderLayout({
      splitActive: true,
      leftPane: <Text>Left</Text>,
      rightPane: <Text>Right</Text>,
      terminalWidth: 100,
    });

    const root = findByType(result, Box)[0];
    const childBoxes = findByType(root, Box).filter((b) => b !== root);

    // leftWidth = floor(100 * 50 / 100) = 50
    expect(childBoxes[0].props.width).toBe(50);
    // rightWidth = 100 - 50 - 1 = 49
    expect(childBoxes[2].props.width).toBe(49);
  });

  it('handles minimum split ratio (20%)', () => {
    const result = renderLayout({
      splitActive: true,
      leftPane: <Text>Left</Text>,
      rightPane: <Text>Right</Text>,
      terminalWidth: 100,
      splitRatio: 20,
    });

    const root = findByType(result, Box)[0];
    const childBoxes = findByType(root, Box).filter((b) => b !== root);

    // leftWidth = floor(100 * 20 / 100) = 20
    expect(childBoxes[0].props.width).toBe(20);
    // rightWidth = 100 - 20 - 1 = 79
    expect(childBoxes[2].props.width).toBe(79);
  });

  it('handles maximum split ratio (80%)', () => {
    const result = renderLayout({
      splitActive: true,
      leftPane: <Text>Left</Text>,
      rightPane: <Text>Right</Text>,
      terminalWidth: 100,
      splitRatio: 80,
    });

    const root = findByType(result, Box)[0];
    const childBoxes = findByType(root, Box).filter((b) => b !== root);

    // leftWidth = floor(100 * 80 / 100) = 80
    expect(childBoxes[0].props.width).toBe(80);
    // rightWidth = 100 - 80 - 1 = 19
    expect(childBoxes[2].props.width).toBe(19);
  });

  it('passes terminal dimensions to single pane', () => {
    const result = renderLayout({
      splitActive: false,
      leftPane: <Text>Left</Text>,
      rightPane: <Text>Right</Text>,
      terminalWidth: 100,
      terminalHeight: 30,
    });

    const root = findByType(result, Box)[0];
    expect(root.props.width).toBe(100);
    expect(root.props.height).toBe(30);
  });

  it('passes terminal dimensions to split container', () => {
    const result = renderLayout({
      splitActive: true,
      leftPane: <Text>Left</Text>,
      rightPane: <Text>Right</Text>,
      terminalWidth: 120,
      terminalHeight: 40,
    });

    const root = findByType(result, Box)[0];
    expect(root.props.width).toBe(120);
    expect(root.props.height).toBe(40);
  });

  it('separator is 1 column wide', () => {
    const result = renderLayout({
      splitActive: true,
      leftPane: <Text>Left</Text>,
      rightPane: <Text>Right</Text>,
    });

    const root = findByType(result, Box)[0];
    const childBoxes = findByType(root, Box).filter((b) => b !== root);

    // Middle box is the separator
    expect(childBoxes[1].props.width).toBe(1);
  });

  it('sums widths correctly for terminal width', () => {
    const terminalWidth = 80;
    const splitRatio = 55;
    const result = renderLayout({
      splitActive: true,
      leftPane: <Text>Left</Text>,
      rightPane: <Text>Right</Text>,
      terminalWidth,
      splitRatio,
    });

    const root = findByType(result, Box)[0];
    const childBoxes = findByType(root, Box).filter((b) => b !== root);

    const leftWidth = childBoxes[0].props.width;
    const separatorWidth = childBoxes[1].props.width;
    const rightWidth = childBoxes[2].props.width;

    expect(leftWidth + separatorWidth + rightWidth).toBe(terminalWidth);
  });
});
