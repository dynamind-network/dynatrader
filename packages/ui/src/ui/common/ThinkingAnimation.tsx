import React, { useEffect, useState, useRef } from 'react';
import { Box, Text } from '@dynatrader/ink/terminal';
import { COLORS, GLYPHS, ANIMATION } from '../design/tokens.js';

// ---------------------------------------------------------------------------
// Constants & helpers (exported for unit testing)
// ---------------------------------------------------------------------------

const THINKING_VERBS = [
  'Thinking',
  'Noodling',
  'Reading',
  'Searching',
  'Planning',
  'Building',
  'Checking',
  'Writing',
  'Reasoning',
  'Working',
  'Untangling',
  'Sketching',
  'Tracing',
  'Inspecting',
  'Connecting',
  'Refining',
  'Testing',
  'Mapping',
  'Tuning',
  'Fetching',
  'Exploring',
  'Calculating',
  'Sifting',
  'Drafting',
  'Polishing',
  'Gathering',
  'Comparing',
  'Verifying',
  'Composing',
  'Wiring',
  'Considering',
  'Sorting',
  'Reviewing',
  'Investigating',
  'Understanding',
  'Organizing',
  'Following',
  'Measuring',
  'Discovering',
  'Unpacking',
  'Combining',
  'Connecting dots',
  'Double-checking',
  'Looking closer',
  'Making a plan',
  'Working it out',
  'Following the trail',
  'Putting pieces together',
  'Checking the details',
  'Finding a path',
  'Lining things up',
  'Making sense of it',
  'Running the numbers',
  'Reading the room',
  'Following through',
  'Narrowing it down',
  'Taking a closer look',
  'Joining the dots',
  'Stepping through it',
  'Checking assumptions',
  'Searching the workspace',
  'Reviewing the context',
  'Planning the next step',
  'Tracing the details',
  'Piecing it together',
  'Sorting out the details',
  'Exploring the options',
  'Checking what changed',
  'Thinking it through',
  'Sketching an approach',
  'Finding the right tool',
  'Getting oriented',
  'Laying the groundwork',
  'Making progress',
  'Checking the edges',
  'Tidying things up',
  'Getting things ready',
  'Taking stock',
  'Looking for clues',
  'Working through it',
  'Putting it in place',
  'Making a few checks',
  'Getting to the bottom of it',
] as const;

/** Returns the frozen array of thinking verb phrases. */
export function getThinkingVerbs(): readonly string[] {
  return THINKING_VERBS;
}

/** Format elapsed milliseconds into a human-readable string like "2s" or "1m 30s". */
export function formatElapsedTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/**
 * Returns the elapsed milliseconds since `startTime` if at least
 * `minDisplayMs` have passed, otherwise `null`.
 */
export function getDisplayElapsedMs(startTime: number, minDisplayMs: number): number | null {
  const elapsed = Date.now() - startTime;
  if (elapsed < minDisplayMs) return null;
  return elapsed;
}

/**
 * Format a token count into a compact human-readable string.
 * Examples: 1200 -> "~1.2k", 500 -> "~500", 15000 -> "~15k"
 */
export function formatTokensUsed(count: number): string {
  if (count >= 1_000_000) {
    const val = count / 1_000_000;
    return `~${val % 1 === 0 ? val.toFixed(0) : val.toFixed(1)}m`;
  }
  if (count >= 1_000) {
    const val = count / 1_000;
    return `~${val % 1 === 0 ? val.toFixed(0) : val.toFixed(1)}k`;
  }
  return `~${count}`;
}

// ---------------------------------------------------------------------------
// Shimmer helpers
// ---------------------------------------------------------------------------

/** Shimmer wave length in characters — controls how wide the highlight sweep is. */
const SHIMMER_WAVE_LENGTH = 12;

/**
 * Compute per-character shimmer colors for a string.
 * Returns an array of color values — one per character — where the "wave peak"
 * uses `shimmerColor` and the rest use `baseColor`, blended by distance.
 *
 * The `phase` argument is a continuously increasing value (e.g. Date.now())
 * that drives the wave position along the string.
 */
export function shimmerColors(
  text: string,
  phase: number,
  baseColor: string,
  shimmerColor: string
): string[] {
  const len = text.length;
  if (len === 0) return [];
  const wavePos = (phase % (len + SHIMMER_WAVE_LENGTH)) - SHIMMER_WAVE_LENGTH;
  return Array.from({ length: len }, (_, i) => {
    const dist = Math.abs(i - wavePos);
    // Peak is within the wave window; use shimmerColor for the center,
    // fade to baseColor at edges
    if (dist < 2) return shimmerColor;
    if (dist < SHIMMER_WAVE_LENGTH / 2) return shimmerColor;
    return baseColor;
  });
}

// ---------------------------------------------------------------------------
// Props & memo comparator
// ---------------------------------------------------------------------------

interface ThinkingAnimationProps {
  /** List of currently active tool names (for legacy single-tool display). */
  activeTools?: string[];
  /** Total tokens consumed so far; rendered inline when provided. */
  tokensUsed?: number;
  /** Index of the current tool (0-based) when multiple tools are active. */
  toolIndex?: number;
  /** Total number of tools being called in the current batch. */
  toolTotal?: number;
  /** Name of the specific tool currently running (overrides activeTools[0]). */
  toolName?: string;
  /** Width constraint for the component (in terminal columns). */
  width?: number;
}

/**
 * Compare two arrays of strings for equality by content.
 */
function arraysEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Custom props equality function for React.memo on ThinkingAnimation.
 * Prevents re-renders when props haven't meaningfully changed.
 */
export function thinkingAnimationPropsEqual(
  prev: ThinkingAnimationProps,
  next: ThinkingAnimationProps
): boolean {
  return (
    prev.tokensUsed === next.tokensUsed &&
    prev.toolIndex === next.toolIndex &&
    prev.toolTotal === next.toolTotal &&
    prev.toolName === next.toolName &&
    prev.width === next.width &&
    arraysEqual(prev.activeTools, next.activeTools)
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const MIN_DISPLAY_MS = 2000;

/** Shimmer speed: characters per millisecond the wave travels. */
const SHIMMER_SPEED = 0.035;

const ThinkingAnimationInner: React.FC<ThinkingAnimationProps> = ({
  activeTools = [],
  tokensUsed,
  toolIndex,
  toolTotal,
  toolName,
  width,
}) => {
  const [tick, setTick] = useState(0);
  const mountTimeRef = useRef<number>(Date.now());
  const verbIndexRef = useRef(Math.floor(Math.random() * THINKING_VERBS.length));
  const lastVerbChangeRef = useRef<number>(Date.now());
  const shimmerPhaseRef = useRef<number>(0);

  // Single consolidated interval — drives all animations with one setState
  useEffect(() => {
    const id = setInterval(() => {
      setTick((prev) => prev + 1);
    }, ANIMATION.spinnerInterval);
    return () => clearInterval(id);
  }, []);

  // Derive all animation state from the single tick (no extra re-renders)
  const spinnerIndex = tick % GLYPHS.spinner.length;
  const now = Date.now();
  if (now - lastVerbChangeRef.current >= ANIMATION.verbCycleInterval) {
    verbIndexRef.current = (verbIndexRef.current + 1) % THINKING_VERBS.length;
    lastVerbChangeRef.current = now;
  }
  const elapsedMs = getDisplayElapsedMs(mountTimeRef.current, MIN_DISPLAY_MS);

  // Shimmer phase — continuously increments for smooth color wave
  shimmerPhaseRef.current = now * SHIMMER_SPEED;

  const spinner = GLYPHS.spinner[spinnerIndex];
  const currentVerb = THINKING_VERBS[verbIndexRef.current];

  // Determine if we have multi-tool progress info
  const hasToolProgress =
    typeof toolIndex === 'number' && typeof toolTotal === 'number' && toolTotal > 1;

  // Determine the current tool name (new props take precedence over legacy activeTools)
  const currentToolName = toolName ?? (activeTools.length > 0 ? activeTools[0] : null);

  // Build the main text
  let mainText: string;
  if (hasToolProgress) {
    const idx = toolIndex! + 1;
    const total = toolTotal!;
    const name = currentToolName ?? 'tool';
    mainText = `Calling ${idx}/${total}: ${name}`;
  } else if (currentToolName) {
    mainText = `Calling ${currentToolName}`;
  } else {
    mainText = `${currentVerb}…`;
  }

  const statusDetails = [
    elapsedMs !== null ? formatElapsedTime(elapsedMs) : undefined,
    typeof tokensUsed === 'number' ? `↑ ${tokensUsed.toLocaleString()} tokens` : undefined,
    'esc to interrupt',
  ].filter(Boolean).join(' · ');

  // Color: thinking = shimmer wave, tool running = yellow pulse
  const isToolRunning = Boolean(currentToolName);
  const baseColor = isToolRunning ? COLORS.toolRunning : COLORS.thinking;
  const shimmerColor = isToolRunning ? COLORS.warning : COLORS.thinkingShimmer;

  // Shimmer: spinner gets the shimmer color, text gets the base color
  // The spinner pulses between base and shimmer for a "breathing" effect
  const shimmerPhase = shimmerPhaseRef.current;
  const pulsePhase = Math.sin(shimmerPhase * 0.003) * 0.5 + 0.5; // 0-1 oscillation
  const spinnerColor = pulsePhase > 0.5 ? shimmerColor : baseColor;

  return (
    <Box flexDirection="row" alignItems="center" width={width} overflow="hidden" flexShrink={0}>
      <Text color={spinnerColor} wrap="truncate">
        {spinner}{' '}
      </Text>
      <Text color={baseColor} wrap="truncate">
        {mainText}
      </Text>
      <Text color={COLORS.muted}> ({statusDetails})</Text>
    </Box>
  );
};

export const ThinkingAnimation = React.memo(ThinkingAnimationInner, thinkingAnimationPropsEqual);
export default ThinkingAnimation;

