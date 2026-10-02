import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSelectionRedrawScheduler } from './selection-redraw.js';

afterEach(() => vi.useRealTimers());

describe('selection redraw scheduler', () => {
  it('coalesces rapid pointer motion into at most one redraw per frame window', () => {
    vi.useFakeTimers();
    const redraw = vi.fn();
    const scheduler = createSelectionRedrawScheduler(redraw, 20);

    for (let i = 0; i < 100; i++) scheduler.schedule();
    expect(redraw).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    expect(redraw).toHaveBeenCalledOnce();
    scheduler.cancel();
  });

  it('flushes the last drag update immediately and cancels pending work on cleanup', () => {
    vi.useFakeTimers();
    const redraw = vi.fn();
    const scheduler = createSelectionRedrawScheduler(redraw, 20);
    scheduler.schedule();
    scheduler.flush();
    expect(redraw).toHaveBeenCalledOnce();
    scheduler.schedule();
    scheduler.cancel();
    vi.advanceTimersByTime(20);
    expect(redraw).toHaveBeenCalledOnce();
  });
});
