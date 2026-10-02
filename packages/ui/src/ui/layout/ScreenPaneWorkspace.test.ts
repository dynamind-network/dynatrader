import { describe, expect, it } from 'vitest';
import { getPaneViewport, normalizePaneLayout } from './ScreenPaneWorkspace.js';

describe('normalizePaneLayout', () => {
  it('uses the curated single-pane default until the user adds panes', () => {
    expect(normalizePaneLayout(undefined, ['tape', 'flow'], ['tape'])).toEqual({
      panes: ['tape'],
      split: 62,
    });
  });

  it('drops unknown and duplicate pane ids while keeping the saved order', () => {
    expect(normalizePaneLayout({ panes: ['flow', 'removed', 'flow', 'tape'], split: 55 }, ['tape', 'flow'], ['tape']))
      .toEqual({ panes: ['flow', 'tape'], split: 55 });
  });

  it('clamps saved pane count and split width to supported bounds', () => {
    expect(normalizePaneLayout({ panes: ['a', 'b', 'c', 'd', 'e'], split: 99 }, ['a', 'b', 'c', 'd', 'e'], ['a']))
      .toEqual({ panes: ['a', 'b', 'c', 'd'], split: 75 });
    expect(normalizePaneLayout({ panes: ['a'], split: -5 }, ['a'], ['a']).split).toBe(30);
  });
});

describe('getPaneViewport', () => {
  it('splits wide terminals according to the saved ratio', () => {
    const layout = { panes: ['tape', 'flow'], split: 60 };
    expect(getPaneViewport(layout, 'tape', 'tape', { width: 180, height: 50 })).toEqual({ width: 104, height: 45 });
    expect(getPaneViewport(layout, 'flow', 'tape', { width: 180, height: 50 })).toEqual({ width: 67, height: 45 });
  });

  it('shows only the focused pane on narrow terminals', () => {
    const layout = { panes: ['tape', 'flow'], split: 60 };
    expect(getPaneViewport(layout, 'flow', 'tape', { width: 100, height: 32 })).toEqual({ width: 0, height: 0 });
    expect(getPaneViewport(layout, 'tape', 'tape', { width: 100, height: 32 })).toEqual({ width: 96, height: 27 });
  });
});

