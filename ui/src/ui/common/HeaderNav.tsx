import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import path from 'node:path';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { buildHeaderNavLayout } from './header-nav-layout.js';
import { LiveTickerStrip } from './LiveTickerStrip.js';
import { COLORS, GLYPHS } from '../design/tokens.js';

interface HeaderNavProps {
  activeScreen: string;
  /** Active model identifier (e.g. "provider/model-name") */
  modelName?: string;
  /** Current working directory */
  cwd?: string;
  /** Whether the live ticker backend is available */
  hasTicker?: boolean;
}

/**
 * Responsive header bar with navigation hints, version display,
 * model/cwd info and ticker indicator.
 * Adapts layout based on terminal width.
 */
export function HeaderNav({ activeScreen, modelName, cwd, hasTicker = false }: HeaderNavProps) {
  const { width } = useTerminalSize();
  const layout = buildHeaderNavLayout(width, activeScreen);
  const [showTicker, setShowTicker] = useState(false);

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

  // Keep secondary context off narrow terminals to protect the navigation row.
  const showInfoRow = width >= 60 && Boolean(modelName || shortCwd || hasTicker);
  const contextParts = [modelName, shortCwd, hasTicker ? 'Ctrl+T ticker' : null, 'Ctrl+K commands'].filter(
    Boolean
  );

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

      {/* --- Info row: model, cwd, and stable keyboard hints --- */}
      {showInfoRow && (
        <Box width={width} height={1} overflow="hidden">
          <Text wrap="truncate" color={COLORS.muted}>
            {contextParts.join(` ${GLYPHS.separator} `)}
          </Text>
        </Box>
      )}

      {/* --- Live ticker strip (toggle via Ctrl+T) --- */}
      {showTicker && <LiveTickerStrip width={width} />}
    </Box>
  );
}

export default HeaderNav;
