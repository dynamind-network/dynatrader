import React, { useRef, useCallback, useEffect, useState, useImperativeHandle, useMemo } from 'react';
import { Box, Text, useInput } from '@dynatrader/ink/terminal';
import type { ExecutionMode } from '../../index.js';
import { COLORS, GLYPHS, SPACING } from '../design/tokens.js';
import { getCommandRegistry, registerBuiltinCommands } from '../../commands/index.js';

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
  searchPrompts?: (query: string) => Promise<Array<{ sessionId: string; prompt: string }>>;
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
      searchPrompts,
    },
    ref
  ) {
    // --- Local input state (isolated from App re-renders) ---
    const [localInput, setLocalInput] = useState('');
    const [cursorIndex, setCursorIndex] = useState(0);
    const [promptSearch, setPromptSearch] = useState<string | null>(null);
    const [promptMatches, setPromptMatches] = useState<Array<{ sessionId: string; prompt: string }>>([]);
    const [promptMatchIndex, setPromptMatchIndex] = useState(0);
    const [localSelectedIndex, setLocalSelectedIndex] = useState(0);

    // Paste buffer - stores full pasted text in a REF (not state that TextInput sees)

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
    const cursorRef = useRef(cursorIndex);
    cursorRef.current = cursorIndex;

    useEffect(() => {
      if (promptSearch === null || !searchPrompts || !promptSearch.trim()) { setPromptMatches([]); return; }
      let cancelled = false;
      void searchPrompts(promptSearch).then((results) => { if (!cancelled) { setPromptMatches(results); setPromptMatchIndex(0); } });
      return () => { cancelled = true; };
    }, [promptSearch, searchPrompts]);

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
    // --- Imperative handle ---
    useImperativeHandle(
      ref,
      () => ({
        clear() {
          setLocalInput('');
          setCursorIndex(0);
          setLocalSelectedIndex(0);
          historyIndexRef.current = -1;
          historySnapshotRef.current = '';
        },
        setValue(v: string) {
          setLocalInput(v);
          setCursorIndex(v.length);
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
            const value = suggestion.shortcut + ' ';
            setLocalInput(value);
            setCursorIndex(value.length);
          } else {
            const value = '@' + suggestion.name + ' ';
            setLocalInput(value);
            setCursorIndex(value.length);
          }
          setLocalSelectedIndex(0);
        }
      },
      [currentSuggestions]
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
        const textToSubmit = localInputRef.current;

        if (textToSubmit.trim().length > 0) {
          // Record in history before submitting
          pushToHistory(textToSubmit);
          onSubmit(textToSubmit);
        }

        // Reset history browsing state after submit
        historyIndexRef.current = -1;
        historySnapshotRef.current = '';

        // Clear paste buffer after submit

        // Clear local input
        setLocalInput('');
        setCursorIndex(0);
        setLocalSelectedIndex(0);
      },
      [disabled, inputBlockedRef, hasSuggestions, currentSuggestions, localSelectedIndex, selectSuggestion, onSubmit, pushToHistory]
    );

    // Handle arrow keys - suggestion navigation takes priority,
    // otherwise perform history navigation when input is empty
    useInput(
      (_inputChar, key) => {
        if (promptSearch !== null) {
          if (key.escape) { setPromptSearch(null); return; }
          if (key.upArrow) { setPromptMatchIndex((i) => Math.max(0, i - 1)); return; }
          if (key.downArrow) { setPromptMatchIndex((i) => Math.min(promptMatches.length - 1, i + 1)); return; }
          if (key.return) {
            const match = promptMatches[promptMatchIndex];
            if (match) { setLocalInput(match.prompt); setCursorIndex(match.prompt.length); }
            setPromptSearch(null); return;
          }
          if (key.backspace) { setPromptSearch((q) => (q ?? '').slice(0, -1)); return; }
          if (_inputChar && !key.ctrl && _inputChar.length === 1 && _inputChar >= ' ') setPromptSearch((q) => (q ?? '') + _inputChar);
          return;
        }
        if (key.ctrl && _inputChar.toLowerCase() === 'r') { setPromptSearch(''); return; }
        const current = localInputRef.current;
        const cursor = cursorRef.current;
        if (key.return) { handleSubmit(current); return; }
        if (key.ctrl && (_inputChar === 'j' || _inputChar === '\n')) {
          const next = current.slice(0, cursor) + '\n' + current.slice(cursor);
          setLocalInput(next); setCursorIndex(cursor + 1); return;
        }
        if (key.leftArrow) { setCursorIndex(Math.max(0, cursor - 1)); return; }
        if (key.rightArrow) { setCursorIndex(Math.min(current.length, cursor + 1)); return; }
        if (key.upArrow || key.downArrow) {
          const lineStart = current.lastIndexOf('\n', cursor - 1) + 1;
          const column = cursor - lineStart;
          const previousBreak = lineStart > 0 ? current.lastIndexOf('\n', lineStart - 2) : -1;
          const nextBreak = current.indexOf('\n', cursor);
          if (key.upArrow && lineStart > 0) setCursorIndex(Math.min(lineStart - 1, previousBreak + 1 + column));
          else if (key.downArrow && nextBreak >= 0) setCursorIndex(Math.min(current.length, nextBreak + 1 + column));
          else if (current.includes('\n')) return;
          else if (key.upArrow || key.downArrow) {
            // Single-line input continues into command history below.
          }
          if (current.includes('\n')) return;
        }
        if (key.backspace) {
          if (cursor > 0) { setLocalInput(current.slice(0, cursor - 1) + current.slice(cursor)); setCursorIndex(cursor - 1); }
          return;
        }
        if ((key as any).delete) {
          if (cursor < current.length) setLocalInput(current.slice(0, cursor) + current.slice(cursor + 1));
          return;
        }
        if ((key as any).home) { const start = current.lastIndexOf('\n', cursor - 1) + 1; setCursorIndex(start); return; }
        if ((key as any).end) { const end = current.indexOf('\n', cursor); setCursorIndex(end < 0 ? current.length : end); return; }
        if (_inputChar && !_inputChar.startsWith('\u001b') && !key.ctrl && !_inputChar.includes('\u0000') && _inputChar !== '\r') {
          setLocalInput(current.slice(0, cursor) + _inputChar + current.slice(cursor));
          setCursorIndex(cursor + _inputChar.length);
          return;
        }
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
          setCursorIndex(history[historyIndexRef.current]!.length);
          return;
        }

        if (key.downArrow && browsingHistory) {
          if (historyIndexRef.current < history.length - 1) {
            // Move forward in history
            historyIndexRef.current += 1;
            setLocalInput(history[historyIndexRef.current]);
            setCursorIndex(history[historyIndexRef.current]!.length);
          } else {
            // Past the last entry: restore the original unsent input
            historyIndexRef.current = -1;
            setLocalInput(historySnapshotRef.current);
            setCursorIndex(historySnapshotRef.current.length);
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

    const displayValue = localInput.slice(0, cursorIndex) + '▏' + localInput.slice(cursorIndex);

    // Character and line counts for the indicator
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

        <Box
          flexDirection="row"
          alignItems="center"
          borderStyle="round"
          borderColor={COLORS.border}
          paddingX={1}
          width="100%"
        >
          <Text color={COLORS.success} bold>
            {'› '}
          </Text>
          <Text dimColor={localInput.length === 0}>{localInput.length === 0 ? `${placeholder}  (Ctrl+J for newline)` : displayValue}</Text>
        </Box>
        {promptSearch !== null && <Box flexDirection="column" marginTop={1}>
          <Text color={COLORS.highlight}>Reverse prompt search: {promptSearch || 'type to search'} (↑/↓, Enter to load, Esc to close)</Text>
          {promptMatches.slice(Math.max(0, promptMatchIndex - 2), promptMatchIndex + 3).map((match, index) => {
            const actualIndex = Math.max(0, promptMatchIndex - 2) + index;
            return <Text key={`${match.sessionId}-${actualIndex}`} color={actualIndex === promptMatchIndex ? COLORS.success : COLORS.muted} wrap="truncate">{actualIndex === promptMatchIndex ? '› ' : '  '}{match.prompt.replace(/\s+/g, ' ')}</Text>;
          })}
        </Box>}
      </>
    );
  }
);

