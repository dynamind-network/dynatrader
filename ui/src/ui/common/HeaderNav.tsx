import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import path from 'node:path';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { buildHeaderNavLayout } from './header-nav-layout.js';
import { LiveTickerStrip } from './LiveTickerStrip.js';
import { COLORS, GLYPHS, SPACING, ANIMATION } from '../design/tokens.js';

interface HeaderNavProps {
  activeScreen: string;
  /** Active model identifier (e.g. "claude-sonnet-4-20250514") */
  modelName?: string;
  /** Current working directory */
  cwd?: string;
  /** Whether the live ticker backend is available */
  hasTicker?: boolean;
}

/** Contextual tips that rotate on a timer in the header info row */
const CONTEXTUAL_TIPS = [
  'Tab: suggestions',
  '/help: commands',
  'Ctrl+T: ticker',
  'Esc: chat',
  '/model: switch model',
  '?: shortcuts',
];

/**
 * Responsive header bar with navigation hints, version display,
 * model/cwd info, ticker indicator, and rotating contextual tips.
 * Adapts layout based on terminal width.
 */
export function HeaderNav({ activeScreen, modelName, cwd, hasTicker = false }: HeaderNavProps) {
  const { width } = useTerminalSize();
  const layout = buildHeaderNavLayout(width, activeScreen);
  const [showTicker, setShowTicker] = useState(false);
  const [tipIndex, setTipIndex] = useState(0);

  // Rotate contextual tips on a fixed interval
  useEffect(() => {
    const interval = setInterval(() => {
      setTipIndex((prev) => (prev + 1) % CONTEXTUAL_TIPS.length);
    }, ANIMATION.verbCycleInterval);
    return () => clearInterval(interval);
  }, []);

  useInput((_input, key) => {
    if (key.ctrl && _input === 't') {
      setShowTicker((prev) => !prev);
    }
  });

  /** Render a nav label with the first character in accent color */
  const renderSegmentText = (text: string, active?: boolean, dim?: boolean) => {
    const isNavLabel = !dim && /^[A-Za-z]+$/.test(text) && text.length > 0;

    if (!isNavLabel) {
      return text;
    }

    const firstCharColor = active ? COLORS.accent : COLORS.primary;
    const restColor = active ? COLORS.primary : COLORS.muted;

    return (
      <>
        <Text color={firstCharColor}>{text.charAt(0)}</Text>
        {text.length > 1 && <Text color={restColor}>{text.slice(1)}</Text>}
      </>
    );
  };

  // Compute a short cwd label (basename only) for compact display
  const shortCwd = cwd ? path.basename(cwd) : undefined;

  // Determine what to show on the info row
  const showInfoRow = width >= 60 && (modelName || shortCwd || hasTicker);

  return (
    <Box flexDirection="column">
      {/* --- Navigation row --- */}
      <Text>
        {layout.segments.map((segment, index) => (
          <Text
            key={`${index}-${segment.text}`}
            color={segment.active ? COLORS.accent : COLORS.primary}
            dimColor={segment.dim}
            bold={segment.bold ?? segment.active}
          >
            {segment.bracketed && <Text color={COLORS.highlight}>[</Text>}
            {renderSegmentText(segment.text, segment.active, segment.dim)}
            {segment.bracketed && <Text color={COLORS.highlight}>]</Text>}
          </Text>
        ))}
      </Text>

      {/* --- Info row: model, cwd, ticker hint, rotating tip --- */}
      {showInfoRow && (
        <Box>
          {modelName && <Text color={COLORS.muted}>{modelName}</Text>}
          {modelName && shortCwd && <Text dimColor> {GLYPHS.separator} </Text>}
          {shortCwd && <Text color={COLORS.muted}>{shortCwd}</Text>}
          {hasTicker && (
            <>
              <Text dimColor>
                {modelName || shortCwd ? ' ' : ''}
                {GLYPHS.separator}{' '}
              </Text>
              <Text color={COLORS.muted}>Ctrl+T: Ticker</Text>
            </>
          )}
          <Text dimColor>
            {SPACING.xs > 0 ? ' ' : ''}
            {GLYPHS.separator} {CONTEXTUAL_TIPS[tipIndex]}
          </Text>
        </Box>
      )}

      {/* --- Live ticker strip (toggle via Ctrl+T) --- */}
      {showTicker && <LiveTickerStrip width={width} />}
    </Box>
  );
}

export default HeaderNav;
