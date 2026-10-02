import { useState, useEffect, useCallback, useRef } from 'react';
import { useAnimationFrame } from './useAnimationFrame.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseBlinkOptions {
  /** Blink interval in milliseconds. Default: 530 (standard terminal cursor blink). */
  intervalMs?: number;
  /** Whether blinking is active. Default: true. */
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Synchronized blinking hook — all instances share the same animation clock
 * when a ClockContext is available, ensuring visual consistency.
 *
 * Returns a boolean that alternates `true`/`false` at the given interval.
 * Useful for loading indicators, cursor simulation, and blinking UI elements.
 *
 * @example
 * const isVisible = useBlink({ enabled: isLoading });
 * return <Text>{isVisible ? '|' : ' '}</Text>
 */
export function useBlink(options: UseBlinkOptions = {}): boolean {
  const { intervalMs = 530, enabled = true } = options;
  const [visible, setVisible] = useState(true);
  const mountedRef = useRef(true);

  // Use the animation frame clock for synchronized timing
  const [ref, time] = useAnimationFrame(intervalMs, enabled);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled || time === 0) return;
    if (mountedRef.current) {
      setVisible((prev) => !prev);
    }
  }, [time, enabled]);

  // Reset to visible when re-enabled
  useEffect(() => {
    if (enabled) {
      setVisible(true);
    }
  }, [enabled]);

  return visible;
}

// ---------------------------------------------------------------------------
// Lower-level hook for custom blink patterns
// ---------------------------------------------------------------------------

/**
 * Returns a [ref, isVisible] tuple for custom blink animations.
 * `isVisible` alternates at the given interval.
 */
export function useBlinkState(
  intervalMs: number = 530,
  enabled: boolean = true
): [React.RefObject<HTMLElement | null>, boolean] {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (!enabled) {
      setVisible(true);
      return;
    }
    const id = setInterval(() => {
      setVisible((prev) => !prev);
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);

  const ref: React.RefObject<HTMLElement | null> = { current: null };
  return [ref, visible];
}

