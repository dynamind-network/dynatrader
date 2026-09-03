import { useContext, useEffect, useState } from 'react';

export type Clock = {
  subscribe: (onChange: () => void, keepAlive: boolean) => () => void;
  now: () => number;
  setTickInterval: (ms: number) => void;
};

const DEFAULT_FRAME_INTERVAL_MS = 16;

export function createClock(tickIntervalMs: number): Clock {
  const subscribers = new Map<() => void, boolean>();
  let interval: ReturnType<typeof setInterval> | null = null;
  let currentTickIntervalMs = tickIntervalMs;
  let startTime = 0;
  let tickTime = 0;

  function tick(): void {
    tickTime = Date.now() - startTime;
    for (const onChange of subscribers.keys()) {
      onChange();
    }
  }

  function updateInterval(): void {
    const anyKeepAlive = [...subscribers.values()].some(Boolean);
    if (anyKeepAlive) {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      if (startTime === 0) {
        startTime = Date.now();
      }
      interval = setInterval(tick, currentTickIntervalMs);
    } else if (interval) {
      clearInterval(interval);
      interval = null;
    }
  }

  return {
    subscribe(onChange, keepAlive) {
      subscribers.set(onChange, keepAlive);
      updateInterval();
      return () => {
        subscribers.delete(onChange);
        updateInterval();
      };
    },
    now() {
      if (startTime === 0) {
        startTime = Date.now();
      }
      if (interval && tickTime) {
        return tickTime;
      }
      return Date.now() - startTime;
    },
    setTickInterval(ms) {
      if (ms === currentTickIntervalMs) return;
      currentTickIntervalMs = ms;
      updateInterval();
    },
  };
}

import { createContext } from 'react';

export const ClockContext = createContext<Clock | null>(null);

export function useAnimationFrame(
  intervalMs: number | null = DEFAULT_FRAME_INTERVAL_MS,
  isVisible = true
): [ref: React.RefObject<HTMLElement | null>, time: number] {
  const clock = useContext(ClockContext);
  const [time, setTime] = useState(() => clock?.now() ?? 0);

  const active = isVisible && intervalMs !== null;

  useEffect(() => {
    if (!clock || !active) return;

    let lastUpdate = clock.now();

    const onChange = (): void => {
      const now = clock.now();
      if (now - lastUpdate >= intervalMs!) {
        lastUpdate = now;
        setTime(now);
      }
    };

    return clock.subscribe(onChange, true);
  }, [clock, intervalMs, active]);

  const ref: React.RefObject<HTMLElement | null> = { current: null };

  return [ref, time];
}
