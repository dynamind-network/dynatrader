import React from 'react';
import { Text } from 'ink';

export type ShortcutHintVariant = 'inline' | 'parens';

export interface ShortcutHintProps {
  /** The key or keys to display (e.g., ["Enter"], ["ctrl", "o"], ["up/down"]) */
  keys: string[];
  /** The action the key performs (e.g., "confirm", "cancel", "navigate") */
  label: string;
  /** Whether to wrap in parentheses or render inline. Default: 'inline' */
  variant?: ShortcutHintVariant;
  /** Whether to render the shortcut keys in bold. Default: false */
  bold?: boolean;
}

/**
 * Joins key labels: single keys use the key as-is, multiple keys join with "+"
 * e.g., ["Enter"] -> "Enter", ["ctrl", "o"] -> "ctrl+o"
 */
export function joinKeys(keys: string[]): string {
  return keys.join('+');
}

/**
 * Builds the hint text string for testing purposes.
 * Pure function - no React dependencies.
 */
export function buildShortcutHintText(
  props: Pick<ShortcutHintProps, 'keys' | 'label' | 'variant'>
): string {
  const { keys, label, variant = 'inline' } = props;
  const shortcutText = joinKeys(keys);
  const text = `${shortcutText} to ${label}`;
  return variant === 'parens' ? `(${text})` : text;
}

/**
 * Renders a keyboard shortcut hint like "Enter to confirm" or "(Esc to cancel)"
 *
 * Wrap in <Text dimColor> for the common dim styling.
 *
 * @example
 * // Simple inline hint
 * <Text dimColor><KeyboardShortcutHint keys={["Enter"]} label="confirm" /></Text>
 *
 * // With parentheses: "(Esc to cancel)"
 * <Text dimColor><KeyboardShortcutHint keys={["Esc"]} label="cancel" variant="parens" /></Text>
 *
 * // With bold shortcut: "Enter to confirm" (Enter is bold)
 * <Text dimColor><KeyboardShortcutHint keys={["Enter"]} label="confirm" bold /></Text>
 *
 * // Chord combination: "(ctrl+p to search)"
 * <Text dimColor><KeyboardShortcutHint keys={["ctrl", "p"]} label="search" variant="parens" /></Text>
 */
export function KeyboardShortcutHint({
  keys,
  label,
  variant = 'inline',
  bold = false,
}: ShortcutHintProps): React.ReactElement {
  const shortcutText = joinKeys(keys);
  const shortcutElement = bold ? <Text bold>{shortcutText}</Text> : shortcutText;
  const text =
    variant === 'parens' ? (
      <Text>
        ({shortcutElement} to {label})
      </Text>
    ) : (
      <Text>
        {shortcutElement} to {label}
      </Text>
    );

  return text;
}
