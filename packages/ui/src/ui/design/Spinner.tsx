import React, { useState, useEffect } from 'react';
import { Box, Text } from '@dynatrader/ink/terminal';
import { COLORS, GLYPHS, ANIMATION } from './tokens.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SpinnerProps {
  /** Whether the spinner is actively animating. Default: true */
  running?: boolean;
  /** Color of the spinner character. Default: COLORS.thinking ("cyan") */
  color?: string;
  /** Optional label displayed after the spinner. Default: "" */
  label?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const SpinnerInner: React.FC<SpinnerProps> = ({
  running = true,
  color = COLORS.thinking,
  label = '',
}) => {
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    if (!running) return;

    const interval = setInterval(() => {
      setFrameIndex((prev) => (prev + 1) % GLYPHS.spinner.length);
    }, ANIMATION.spinnerInterval);

    return () => clearInterval(interval);
  }, [running]);

  // When not running, display a static space instead of a spinning frame
  const glyph = running ? GLYPHS.spinner[frameIndex] : ' ';

  return (
    <Box flexDirection="row" alignItems="center">
      <Text color={color}>{glyph}</Text>
      {label.length > 0 && (
        <>
          <Text> </Text>
          <Text color={COLORS.muted}>{label}</Text>
        </>
      )}
    </Box>
  );
};

export const Spinner = React.memo(SpinnerInner);
export default Spinner;

