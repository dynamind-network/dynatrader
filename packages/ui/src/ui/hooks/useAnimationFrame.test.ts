import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createClock, type Clock } from './useAnimationFrame.js';

describe('createClock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a clock with subscribe, now, and setTickInterval', () => {
    const clock = createClock(16);
    expect(typeof clock.subscribe).toBe('function');
    expect(typeof clock.now).toBe('function');
    expect(typeof clock.setTickInterval).toBe('function');
  });

  it('now() returns elapsed time in milliseconds', () => {
    const clock = createClock(16);
    const t1 = clock.now();
    vi.advanceTimersByTime(100);
    const t2 = clock.now();
    expect(t2 - t1).toBeGreaterThanOrEqual(90);
    expect(t2 - t1).toBeLessThanOrEqual(110);
  });

  it('subscribers are called on each tick', () => {
    const clock = createClock(16);
    const callback = vi.fn();
    clock.subscribe(callback, true);

    expect(callback).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(16);
    expect(callback).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(16);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('unsubscribe stops receiving ticks', () => {
    const clock = createClock(16);
    const callback = vi.fn();
    const unsubscribe = clock.subscribe(callback, true);

    vi.advanceTimersByTime(16);
    expect(callback).toHaveBeenCalledTimes(1);

    unsubscribe();
    vi.advanceTimersByTime(16);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('keepAlive=false does not start the clock', () => {
    const clock = createClock(16);
    const callback = vi.fn();
    clock.subscribe(callback, false);

    vi.advanceTimersByTime(100);
    expect(callback).toHaveBeenCalledTimes(0);
  });

  it('keepAlive=true starts the clock, keepAlive=false subscriber still receives ticks', () => {
    const clock = createClock(16);
    const keepAliveCb = vi.fn();
    const passiveCb = vi.fn();

    clock.subscribe(keepAliveCb, true);
    clock.subscribe(passiveCb, false);

    vi.advanceTimersByTime(16);
    expect(keepAliveCb).toHaveBeenCalledTimes(1);
    expect(passiveCb).toHaveBeenCalledTimes(1);
  });

  it('clock pauses when no keepAlive subscribers remain', () => {
    const clock = createClock(16);
    const cb1 = vi.fn();
    const cb2 = vi.fn();

    const unsub1 = clock.subscribe(cb1, true);
    const unsub2 = clock.subscribe(cb2, true);

    vi.advanceTimersByTime(16);
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);

    unsub1();
    unsub2();

    vi.advanceTimersByTime(100);
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it('clock resumes when a new keepAlive subscriber is added after pause', () => {
    const clock = createClock(16);
    const cb = vi.fn();

    const unsub = clock.subscribe(cb, true);
    vi.advanceTimersByTime(16);
    expect(cb).toHaveBeenCalledTimes(1);

    unsub();
    vi.advanceTimersByTime(50);
    expect(cb).toHaveBeenCalledTimes(1);

    const unsub2 = clock.subscribe(cb, true);
    vi.advanceTimersByTime(16);
    expect(cb).toHaveBeenCalledTimes(2);

    unsub2();
  });

  it('all subscribers see the same tick time (synchronized)', () => {
    const clock = createClock(16);
    const times: number[] = [];

    clock.subscribe(() => times.push(clock.now()), true);
    clock.subscribe(() => times.push(clock.now()), true);
    clock.subscribe(() => times.push(clock.now()), true);

    vi.advanceTimersByTime(16);
    expect(times[0]).toBe(times[1]);
    expect(times[1]).toBe(times[2]);
  });

  it('setTickInterval changes the tick frequency', () => {
    const clock = createClock(16);
    const callback = vi.fn();
    clock.subscribe(callback, true);

    callback.mockClear();
    clock.setTickInterval(50);

    vi.advanceTimersByTime(16);
    expect(callback).toHaveBeenCalledTimes(0);

    vi.advanceTimersByTime(34);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('setTickInterval is a no-op when interval is unchanged', () => {
    const clock = createClock(16);
    const callback = vi.fn();
    clock.subscribe(callback, true);

    clock.setTickInterval(16);
    vi.advanceTimersByTime(16);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('now() returns real-time when paused (no stale tickTime)', () => {
    const clock = createClock(16);
    const cb = vi.fn();
    const unsub = clock.subscribe(cb, true);

    vi.advanceTimersByTime(100);
    unsub();

    const beforePause = clock.now();
    vi.advanceTimersByTime(200);
    const afterPause = clock.now();

    expect(afterPause - beforePause).toBeGreaterThanOrEqual(190);
  });
});

