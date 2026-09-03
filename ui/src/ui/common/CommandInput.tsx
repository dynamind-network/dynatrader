import React, { useRef, useCallback, useEffect, useState, useImperativeHandle, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { ExecutionMode } from '../../index.js';
import { COLORS, GLYPHS, SPACING } from '../design/tokens.js';
import { getCommandRegistry, registerBuiltinCommands } from '../../commands/index.js';

// Paste detection thresholds - Claude Code style
const PASTE_LENGTH_THRESHOLD = 500; // Characters - any substantial paste is > 500

// History configuration
const MAX_HISTORY_SIZE = 50;

// ---------------------------------------------------------------------------
// Suggestion types (discriminated union)
// ---------------------------------------------------------------------------

export interface CommandSuggestion {
  type: 'command';
  name: string;
  /** Slash command trigger, e.g. "/help" */
  shortcut?: string;
  /** Short description shown beside the command */
  description: string;
  /** Optional argument hint, e.g. "<file>" */
  argumentHint?: string;
}

export interface RecentSuggestion {
  type: 'recent';
  name: string;
  /** Description of the recent item */
  description: string;
}

export type SuggestionItem = CommandSuggestion | RecentSuggestion;

// ---------------------------------------------------------------------------
// Imperative handle exposed by CommandInput
// ---------------------------------------------------------------------------

export interface CommandInputHandle {
  clear(): void;
  setValue(v: string): void;
  getValue(): string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeLineEndings(input: string): string {
  return input.replace(/\r\n?/g, '\n');
}

function getLineCount(text: string): number {
  const normalized = normalizeLineEndings(text);
  return (normalized.match(/\n/g) || []).length + 1;
}

function isPastedText(input: string): boolean {
  const normalized = normalizeLineEndings(input);
  const lineCount = (normalized.match(/\n/g) || []).length + 1;
  // Detect paste: large text OR multiple lines (at least 5 lines)
  return normalized.length > PASTE_LENGTH_THRESHOLD || lineCount >= 5;
}

let registryInitialized = false;
function ensureRegistryLoaded() {
  if (!registryInitialized) {
    registerBuiltinCommands();
    registryInitialized = true;
  }
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface CommandInputProps {
  onSubmit: (input: string) => void;
  onStopProcessing?: () => void;
  placeholder: string;
  disabled?: boolean;
  inputBlockedRef?: React.MutableRefObject<boolean>;
  agentSuggestions?: Array<{ name: string; description: string }>;
  executionMode?: ExecutionMode;
  isProcessing?: boolean;
  hasPendingApproval?: boolean;
  /** Total number of suggestions available (before any client-side limit) */
  totalSuggestionCount?: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const CommandInput = React.forwardRef<CommandInputHandle, CommandInputProps>(
  function CommandInput(
    {
      onSubmit,
      onStopProcessing,
      placeholder,
      disabled = false,
      inputBlockedRef,
      agentSuggestions = [],
      executionMode = 'normal',
      isProcessing = false,
      hasPendingApproval = false,
      totalSuggestionCount,
    },
    ref
  ) {
    // --- Local input state (isolated from App re-renders) ---
    const [localInput, setLocalInput] = useState('');
    const [localSelectedIndex, setLocalSelectedIndex] = useState(0);

    // Paste buffer - stores full pasted text in a REF (not state that TextInput sees)
    const pastedTextRef = useRef<string>('');
    const pastePendingRef = useRef(false);
    const isInitialMountRef = useRef(true);

    // Input history state
    const [history, setHistory] = useState<string[]>([]);
    const historyIndexRef = useRef<number>(-1);
    const historySnapshotRef = useRef<string>(''); // Stores current input when browsing history

    const isProcessingRef = useRef(isProcessing);
    isProcessingRef.current = isProcessing;
    const onStopProcessingRef = useRef(onStopProcessing);
    onStopProcessingRef.current = onStopProcessing;
    const localInputRef = useRef(localInput);
    localInputRef.current = localInput;

    // --- Inline suggestion logic (moved from useSuggestions) ---
    const commandSuggestions = useMemo<CommandSuggestion[]>(() => {
      ensureRegistryLoaded();
      const registry = getCommandRegistry();
      return registry.getDescriptions().map((cmd) => ({
        type: 'command' as const,
        name: cmd.name,
        shortcut: `/${cmd.name}`,
        description: cmd.description,
        argumentHint: cmd.argumentHint,
      }));
    }, []);

    const agentSuggestionItems = useMemo<RecentSuggestion[]>(
      () =>
        agentSuggestions.map((a) => ({
          type: 'recent' as const,
          name: a.name,
          description: a.description,
        })),
      [agentSuggestions]
    );

    const currentSuggestions = useMemo(() => {
      if (localInput.startsWith('/')) {
        return commandSuggestions.filter(
          (c) => (c.shortcut?.startsWith(localInput) && c.shortcut !== localInput) || localInput === '/'
        );
      }
      if (localInput.startsWith('@')) {
        return agentSuggestionItems.filter(
          (a) => a.name.startsWith(localInput.slice(1)) && a.name !== localInput.slice(1)
        );
      }
      return [];
    }, [localInput, commandSuggestions, agentSuggestionItems]);

    const hasSuggestions = currentSuggestions.length > 0;
    const isSlashMode = localInput.startsWith('/');

    const suggestionsActiveRef = useRef(false);
    suggestionsActiveRef.current = hasSuggestions;

    // Check if current input is a paste (based on stored ref or detection)
    // Skip paste detection on initial mount to allow initial test messages
    const isPasted =
      !isInitialMountRef.current && (pastedTextRef.current.length > 0 || isPastedText(localInput));
    const lineCount =
      pastedTextRef.current.length > 0 ? getLineCount(pastedTextRef.current) : getLineCount(localInput);

    // After first render, enable paste detection
    useEffect(() => {
      isInitialMountRef.current = false;
    }, []);

    // --- Imperative handle ---
    useImperativeHandle(
      ref,
      () => ({
        clear() {
          setLocalInput('');
          setLocalSelectedIndex(0);
          pastePendingRef.current = false;
          pastedTextRef.current = '';
          historyIndexRef.current = -1;
          historySnapshotRef.current = '';
        },
        setValue(v: string) {
          setLocalInput(v);
        },
        getValue() {
          return localInputRef.current;
        },
      }),
      []
    );

    // Push a value to history (deduplicates consecutive identical entries)
    const pushToHistory = useCallback((value: string) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) return;

      setHistory((prev) => {
        const next = [...prev];
        // Don't duplicate the most recent entry
        if (next.length > 0 && next[next.length - 1] === trimmed) {
          return next;
        }
        next.push(trimmed);
        // Cap at MAX_HISTORY_SIZE
        if (next.length > MAX_HISTORY_SIZE) {
          return next.slice(next.length - MAX_HISTORY_SIZE);
        }
        return next;
      });
    }, []);

    // Select a suggestion and fill input
    const selectSuggestion = useCallback(
      (index: number) => {
        const suggestion = currentSuggestions[index];
        if (suggestion) {
          if (suggestion.type === 'command') {
            setLocalInput(suggestion.shortcut + ' ');
          } else {
            setLocalInput('@' + suggestion.name + ' ');
          }
          setLocalSelectedIndex(0);
        }
      },
      [currentSuggestions]
    );

    // Handle input changes - intercept paste BEFORE it reaches TextInput value
    const handleChange = useCallback(
      (value: string) => {
        if (disabled || inputBlockedRef?.current) return;

        // Reset history browsing when user types normally
        if (historyIndexRef.current !== -1) {
          historyIndexRef.current = -1;
          historySnapshotRef.current = '';
        }

        // Reset selection when typing
        setLocalSelectedIndex(0);

        // Detect paste: large input or multiline (5+ lines)
        const lineCount = (value.match(/\n/g) || []).length + 1;
        if (value.length > PASTE_LENGTH_THRESHOLD || lineCount >= 5) {
          // Store FULL text in ref, NOT in state that TextInput manages
          pastedTextRef.current = value;
          pastePendingRef.current = true;

          // Show indicator instead of corrupted text
          // The key insight: we never pass the corrupted text to setLocalInput
          return;
        }

        // Normal typing - allow through
        pastePendingRef.current = false;
        pastedTextRef.current = '';
        setLocalInput(value);
      },
      [disabled, inputBlockedRef]
    );

    const handleSubmit = useCallback(
      (_value: string) => {
        if (disabled || inputBlockedRef?.current) return;

        // If suggestions are visible, fill input with selected suggestion
        if (hasSuggestions && currentSuggestions.length > 0) {
          selectSuggestion(localSelectedIndex);
          return; // Don't submit, let user review and press Enter again
        }

        // Submit from ref if paste pending, otherwise from localInput
        const textToSubmit = pastePendingRef.current ? pastedTextRef.current : localInputRef.current;

        if (textToSubmit.trim().length > 0) {
          // Record in history before submitting
          pushToHistory(textToSubmit);
          onSubmit(textToSubmit);
        }

        // Reset history browsing state after submit
        historyIndexRef.current = -1;
        historySnapshotRef.current = '';

        // Clear paste buffer after submit
        pastedTextRef.current = '';
        pastePendingRef.current = false;

        // Clear local input
        setLocalInput('');
        setLocalSelectedIndex(0);
      },
      [disabled, inputBlockedRef, hasSuggestions, currentSuggestions, localSelectedIndex, selectSuggestion, onSubmit, pushToHistory]
    );

    // Handle arrow keys - suggestion navigation takes priority,
    // otherwise perform history navigation when input is empty
    useInput(
      (_inputChar, key) => {
        // If suggestions are active, handle arrow navigation locally
        if (suggestionsActiveRef.current) {
          if (key.upArrow) {
            setLocalSelectedIndex((prev) => Math.max(0, prev - 1));
            return;
          }
          if (key.downArrow) {
            setLocalSelectedIndex((prev) => Math.min(currentSuggestions.length - 1, prev + 1));
            return;
          }
          return;
        }

        // History navigation (only when input is empty or already browsing)
        const currentInput = localInputRef.current;
        const browsingHistory = historyIndexRef.current !== -1;

        if (key.upArrow) {
          if (history.length === 0) return;

          if (!browsingHistory) {
            // Start browsing: snapshot the current unsent input
            historySnapshotRef.current = currentInput;
            // Move to the most recent history entry
            historyIndexRef.current = history.length - 1;
          } else if (historyIndexRef.current > 0) {
            // Go further back in history
            historyIndexRef.current -= 1;
          } else {
            // Already at the oldest entry, nothing to do
            return;
          }

          setLocalInput(history[historyIndexRef.current]);
          return;
        }

        if (key.downArrow && browsingHistory) {
          if (historyIndexRef.current < history.length - 1) {
            // Move forward in history
            historyIndexRef.current += 1;
            setLocalInput(history[historyIndexRef.current]);
          } else {
            // Past the last entry: restore the original unsent input
            historyIndexRef.current = -1;
            setLocalInput(historySnapshotRef.current);
            historySnapshotRef.current = '';
          }
          return;
        }
      },
      { isActive: !disabled && !inputBlockedRef?.current }
    );

    // Handle Escape to stop processing
    useInput(
      (_input, key) => {
        if (key.escape && isProcessingRef.current) {
          onStopProcessingRef.current?.();
          return;
        }
      },
      { isActive: isProcessing }
    );

    // Block y/n input when approval is pending (prevent leakage into input field)
    useInput(
      (inputChar, key) => {
        // Block single-character y/n input when approval is pending
        if (hasPendingApproval && inputChar && inputChar.length === 1) {
          const char = inputChar.toLowerCase();
          if (char === 'y' || char === 'n') {
            return; // Consume the input, don't pass to TextInput
          }
        }
      },
      { isActive: hasPendingApproval }
    );

    // Display value for TextInput - show indicator if paste pending
    const displayValue = pastePendingRef.current
      ? '' // Show empty to prevent corruption
      : localInput;

    // Character and line counts for the indicator
    const charCount = displayValue.length;
    const displayLineCount = getLineCount(displayValue);
    const showCountIndicator = !pastePendingRef.current && charCount > 0;

    // Suggestion count for header
    const visibleCount = currentSuggestions.length;
    const totalCount = totalSuggestionCount ?? visibleCount;

    return (
      <>
        {hasSuggestions && !disabled && !inputBlockedRef?.current && currentSuggestions.length > 0 && (
          <Box flexDirection="column" marginBottom={1}>
            <Text color={COLORS.muted}>
              {isSlashMode ? 'Commands' : 'Agents'} ({visibleCount} of {totalCount}){GLYPHS.separator}{' '}
              use arrows, Enter to select, then Enter again:
            </Text>
            <Box flexDirection="column">
              {currentSuggestions.map((suggestion, index) => {
                const isSelected = index === localSelectedIndex;

                // Extract name, description, and hint based on suggestion type
                let name: string;
                let desc: string;
                let hint: string | undefined;
                let prefix: string;

                if (suggestion.type === 'command') {
                  name = suggestion.shortcut ?? suggestion.name;
                  desc = suggestion.description;
                  hint = suggestion.argumentHint;
                  prefix = '';
                } else {
                  // recent suggestion
                  name = suggestion.name;
                  desc = suggestion.description;
                  hint = undefined;
                  prefix = '@';
                }

                return (
                  <Box key={name}>
                    {isSelected ? (
                      <Text color={COLORS.highlight}>
                        {'[>] '}
                        {prefix}
                        {name}
                      </Text>
                    ) : (
                      <Text color={isSlashMode ? COLORS.accent : COLORS.highlight}>
                        {'  '}
                        {prefix}
                        {name}
                      </Text>
                    )}
                    {hint && <Text dimColor> {hint}</Text>}
                    <Text dimColor>
                      {' '}
                      {GLYPHS.separator} {desc}
                    </Text>
                  </Box>
                );
              })}
            </Box>
          </Box>
        )}

        <Box flexDirection="row" alignItems="center">
          <Text color={COLORS.muted} bold>
            {'> '}
          </Text>
          {pastePendingRef.current && (
            <Text dimColor>
              [Pasted ~{pastedTextRef.current.length} chars, {lineCount} lines - press Enter to
              send]{' '}
            </Text>
          )}
          <TextInput
            value={displayValue}
            onChange={handleChange}
            onSubmit={handleSubmit}
            placeholder={localInput.length === 0 && !pastePendingRef.current ? placeholder : ''}
          />
        </Box>
      </>
    );
  }
);
