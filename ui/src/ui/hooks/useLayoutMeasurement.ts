import { useState, useLayoutEffect, useRef } from 'react';
import { measureElement, type DOMElement } from 'ink';

/**
 * Measures chrome (header) and footer DOM elements after render,
 * updating height state when measured values change by more than 0.5px.
 *
 * Uses a hybrid approach:
 * - Chrome height is measured from the DOM
 * - Footer height is calculated based on activeScreen and pendingQuestion to avoid stale
 *   measurement issues during screen transitions
 *
 * The footer height calculation accounts for all 3 layers:
 * - Chat: Layer1 (4-8 rows, varies with question) + Layer2 (2 rows) + Layer3 (1 row) = 7-11 rows
 * - Non-chat: StatusLine (2 rows) + hint (1 row) = 3 rows
 */
const FOOTER_HEIGHT_BY_SCREEN: Record<string, number> = {
  chat: 7,
  chatWithQuestion: 10,
  models: 3,
  transcript: 3,
};

export function useLayoutMeasurement(options: {
  activeScreen: string;
  terminalHeight: number;
  terminalWidth: number;
  hasPendingQuestion?: boolean;
}): {
  chromeRef: any;

  footerRef: any;
  chromeHeight: number;
  footerHeight: number;
} {
  const { activeScreen, terminalHeight, terminalWidth, hasPendingQuestion } = options;

  const chromeRef = useRef<DOMElement>(null);
  const footerRef = useRef<DOMElement>(null);
  const [chromeHeight, setChromeHeight] = useState(1);
  const [footerHeight, setFooterHeight] = useState(7);
  const prevChromeHeightRef = useRef(chromeHeight);

  useLayoutEffect(() => {
    if (chromeRef.current) {
      const measurement = measureElement(chromeRef.current);
      if (
        measurement.height > 0 &&
        Math.abs(measurement.height - prevChromeHeightRef.current) > 0.5
      ) {
        prevChromeHeightRef.current = measurement.height;
        setChromeHeight(measurement.height);
      }
    }

    // Calculate footer height based on activeScreen and pendingQuestion instead of measuring.
    // This eliminates the race condition where stale footerHeight caused
    // mainAreaHeight to be wrong, pushing the footer off-screen.
    const screenKey = hasPendingQuestion ? 'chatWithQuestion' : activeScreen;
    const calculatedFooterHeight = FOOTER_HEIGHT_BY_SCREEN[screenKey] ?? 3;
    setFooterHeight((prev) => (prev === calculatedFooterHeight ? prev : calculatedFooterHeight));
  }, [activeScreen, terminalHeight, terminalWidth, hasPendingQuestion]);

  return { chromeRef, footerRef, chromeHeight, footerHeight };
}
