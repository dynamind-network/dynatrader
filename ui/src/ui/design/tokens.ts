/**
 * Design tokens for the DynaMind Terminal UI.
 *
 * Shared constants for colors, glyphs, spacing, layout, and animation.
 * All visual components should reference these tokens instead of
 * hard-coding values, ensuring consistent appearance across the UI.
 *
 * These tokens are designed for Ink (React for terminals) and map
 * directly to Ink's `Text` component `color` prop values.
 */

// ---------------------------------------------------------------------------
// Color tokens
// ---------------------------------------------------------------------------

/**
 * Semantic color names for terminal text.
 * Values match the `color` prop accepted by Ink's `<Text>` component.
 */
export const COLORS = {
  /** Default foreground (user text, general content) */
  primary: 'white',

  /** Secondary / de-emphasized text */
  muted: 'gray',

  /** Very dim text — use sparingly for captions, hints */
  subtle: 'gray',

  /** Text for inactive / disabled elements */
  inactive: 'gray',

  /** Interactive elements (links, focus indicators) */
  accent: 'green',

  /** Completed actions, successful operations */
  success: 'green',

  /** Failed actions, error messages */
  error: 'red',

  /** Warnings, pending states */
  warning: 'yellow',

  /** Selected / active items */
  highlight: 'green',

  /** Default border color */
  border: 'gray',

  /** Interactive / focus border color */
  borderAccent: 'green',

  /** User message marker */
  userMessage: 'green',

  /** Assistant response text */
  assistantMessage: 'white',

  /** Thinking / processing animation */
  thinking: 'cyan',

  /** Lighter variant of thinking color for shimmer sweep */
  thinkingShimmer: 'blue',

  /** Tool currently running */
  toolRunning: 'yellow',

  /** Tool completed successfully */
  toolSuccess: 'green',

  /** Tool failed */
  toolError: 'red',

  /** Diff: added lines */
  diffAdded: 'green',

  /** Diff: removed lines */
  diffRemoved: 'red',

  /** Diff: added word (inline highlight) */
  diffAddedWord: 'green',

  /** Diff: removed word (inline highlight) */
  diffRemovedWord: 'red',

  /** Informational banner background hint */
  info: 'cyan',

  /** Picker container border */
  pickerBorder: 'green',

  /** Picker pointer (focused row indicator) */
  pickerPointer: 'green',

  /** Picker checkmark (current selection) */
  pickerCheck: 'cyan',
} as const;

// ---------------------------------------------------------------------------
// Glyph tokens
// ---------------------------------------------------------------------------

/**
 * Unicode characters and status markers used across UI components.
 */
export const GLYPHS = {
  /** User message prompt marker */
  userPrompt: '›',

  /** Pending tool status marker */
  toolPending: '*',

  /** Successful tool status marker */
  toolSuccess: '+',

  /** Failed tool status marker */
  toolError: '!',

  /** Dot separator between elements */
  separator: '\u00B7',

  /** Tab-expand hint shown inline */
  expandHint: '[Tab]',

  /** Checkmark for completed items */
  check: '\u2714',

  /** Cross for failed / rejected items */
  cross: '\u2718',

  /** Diamond event marker */
  diamond: '\u25C6',

  /** Selection cursor arrow (filled triangle) */
  arrow: '\u25B6',

  /** Picker pointer (small right triangle, compact) */
  pointer: '\u25B8',

  /** Checkmark for selected/current items */
  checkmark: '\u2713',

  /** Unselected radio button */
  radio: '( )',

  /** Selected radio button */
  radioSelected: '(>)',

  /** Braille spinner animation frames */
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const,
} as const;

// ---------------------------------------------------------------------------
// Spacing tokens
// ---------------------------------------------------------------------------

/**
 * Consistent spacing values in terminal columns / rows.
 */
export const SPACING = {
  /** Extra-small gap */
  xs: 1,

  /** Small gap */
  sm: 2,

  /** Medium gap (default) */
  md: 3,

  /** Large gap */
  lg: 4,

  /** Extra-large gap */
  xl: 6,
} as const;

// ---------------------------------------------------------------------------
// Layout tokens
// ---------------------------------------------------------------------------

/**
 * Layout constants for terminal rendering.
 */
export const LAYOUT = {
  /** Minimum usable terminal width (columns) */
  minWidth: 20,

  /** Width of the scrollbar column */
  scrollbarWidth: 1,

  /** Default maximum content width */
  defaultMaxWidth: 120,
} as const;

// ---------------------------------------------------------------------------
// Animation tokens
// ---------------------------------------------------------------------------

/**
 * Timing constants for animations and transitions.
 */
export const ANIMATION = {
  /** Milliseconds between spinner frame updates */
  spinnerInterval: 500,

  /** Milliseconds between verb-cycle label changes */
  verbCycleInterval: 3500,
} as const;
