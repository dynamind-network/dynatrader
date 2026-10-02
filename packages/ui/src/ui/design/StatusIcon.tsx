import React, { useState, useEffect } from 'react';
import { Text } from '@dynatrader/ink/terminal';
import { COLORS, GLYPHS, ANIMATION } from './tokens.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StatusType = 'pending' | 'success' | 'error' | 'running';
type SizeType = 'sm' | 'md';

interface StatusIconProps {
  /** Tool execution status */
  status: StatusType;
  /** Size variant: sm (single char) or md (default, with padding) */
  size?: SizeType;
  /** Optional color override */
  color?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the glyph and color for a non-running status. */
function getStaticGlyph(status: StatusType): string {
  switch (status) {
    case 'pending':
      return GLYPHS.toolPending;
    case 'success':
      return GLYPHS.toolSuccess;
    case 'error':
      return GLYPHS.toolError;
    case 'running':
      return GLYPHS.spinner[0];
  }
}

/** Resolve the color for a non-running status. */
function getDefaultColor(status: StatusType): string {
  switch (status) {
    case 'pending':
      return COLORS.warning;
    case 'success':
      return COLORS.success;
    case 'error':
      return COLORS.error;
    case 'running':
      return COLORS.toolRunning;
  }
}

// ---------------------------------------------------------------------------
// Memo comparator
// ---------------------------------------------------------------------------

function statusIconPropsEqual(prev: StatusIconProps, next: StatusIconProps): boolean {
  return prev.status === next.status && prev.size === next.size && prev.color === next.color;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const StatusIconInner: React.FC<StatusIconProps> = ({ status, size = 'md', color }) => {
  const [spinnerFrame, setSpinnerFrame] = useState(0);

  // Spinner animation: cycle frames while status is 'running'
  useEffect(() => {
    if (status !== 'running') return;

    const interval = setInterval(() => {
      setSpinnerFrame((prev) => (prev + 1) % GLYPHS.spinner.length);
    }, ANIMATION.spinnerInterval);

    return () => clearInterval(interval);
  }, [status]);

  // Reset spinner frame when status changes away from running
  useEffect(() => {
    if (status !== 'running') {
      setSpinnerFrame(0);
    }
  }, [status]);

  const glyph = status === 'running' ? GLYPHS.spinner[spinnerFrame] : getStaticGlyph(status);

  const resolvedColor = color ?? getDefaultColor(status);
  const padding = size === 'md' ? ' ' : '';

  return (
    <Text color={resolvedColor}>
      {padding}
      {glyph}
      {padding}
    </Text>
  );
};

export const StatusIcon = React.memo(
  StatusIconInner,
  statusIconPropsEqual
) as React.FC<StatusIconProps>;
export default StatusIcon;

