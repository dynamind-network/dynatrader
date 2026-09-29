import { useCallback, useEffect, useRef, useState } from 'react';
import { useInput } from 'ink';
import type { ExecutionMode } from '../core/types.js';

const SHORTCUT_INPUT_BLOCK_MS = 150;
const ALT_PREFIX_TIMEOUT_MS = 50;
const ESC_INTERRUPT_DELAY_MS = 20; // Short delay for Alt+letter detection, then interrupt immediately

interface KeyboardShortcutsOptions {
  agentLoop?: any;
  onEscape?: () => void;
  onEscapeWithQueue?: () => void;
  onModeChange?: (mode: ExecutionMode) => void;
  onApprovalKey?: (choice: number) => void;
  onQuestionSelect?: (optionIndex: number) => void;
  onQuestionReject?: () => void;
  onQuestionNavigate?: (direction: 'up' | 'down') => void;
  hasPendingQuestion?: boolean;
  hasPendingApproval?: boolean;
  onHistoryPageUp?: () => void;
  onHistoryPageDown?: () => void;
  onHistoryLineUp?: () => void;
  onHistoryLineDown?: () => void;
  onHistoryJumpTop?: () => void;
  onHistoryJumpBottom?: () => void;
  currentMode?: ExecutionMode;
  onNavigate?: (screen: string) => void;
  onSuggestionSelect?: (index: number) => void;
  suggestions?: any[];
  showSuggestions?: boolean;
  isProcessing?: boolean;
  activeScreen?: string;
  onBlockInput?: (ms: number) => void;
  onToggleTranscript?: () => void;
  onToggleShowAllInTranscript?: () => void;
  onToggleThinking?: () => void;
  isTranscriptMode?: boolean;
  showAllInTranscript?: boolean;
  isCommandPaletteOpen?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  onToggleTimeline?: () => void;
  // Sessions screen
  sessions?: SessionSummary[];
  selectedSessionIndex?: number;
  onSessionIndexChange?: (index: number) => void;
  onSessionSelect?: () => void;
  // Models screen
  models?: ModelSummary[];
  selectedModelIndex?: number;
  onModelIndexChange?: (index: number) => void;
  onModelSelect?: () => void;
  onModelConnect?: () => void;
  modelPickerPhase?: 'models' | 'effort';
  effortOptionCount?: number;
  selectedEffortIndex?: number;
  onEffortIndexChange?: (index: number) => void;
  onEffortSelect?: () => void;
  onEffortSkip?: () => void;
  // MCP screen
  mcpServers?: MCPServerSummary[];
  selectedMCPIndex?: number;
  onMCPIndexChange?: (index: number) => void;
  onMCPSelect?: () => void;
}

interface SessionSummary {
  id: string;
  title: string;
}

interface ModelSummary {
  id: string;
  name: string;
}

interface MCPServerSummary {
  name: string;
  status: 'connected' | 'disconnected' | 'error';
  toolCount?: number;
}

/**
 * Custom hook for handling keyboard shortcuts
 */
export function useKeyboardShortcuts({
  agentLoop,
  onEscape,
  onEscapeWithQueue,
  onModeChange,
  onApprovalKey,
  onQuestionSelect,
  onQuestionReject,
  onQuestionNavigate,
  hasPendingQuestion = false,
  hasPendingApproval = false,
  onHistoryPageUp,
  onHistoryPageDown,
  onHistoryLineUp,
  onHistoryLineDown,
  onHistoryJumpTop,
  onHistoryJumpBottom,
  currentMode = 'normal',
  onNavigate,
  onSuggestionSelect,
  suggestions = [],
  showSuggestions = false,
  isProcessing = false,
  activeScreen = 'chat',
  onBlockInput,
  onToggleTranscript,
  onToggleShowAllInTranscript,
  onToggleThinking,
  isTranscriptMode = false,
  showAllInTranscript = false,
  isCommandPaletteOpen = false,
  sessions = [],
  selectedSessionIndex = 0,
  onSessionIndexChange,
  onSessionSelect,
  models = [],
  selectedModelIndex = 0,
  onModelIndexChange,
  onModelSelect,
  onModelConnect,
  modelPickerPhase = 'models',
  effortOptionCount = 5,
  selectedEffortIndex = 0,
  onEffortIndexChange,
  onEffortSelect,
  onEffortSkip,
  mcpServers = [],
  selectedMCPIndex = 0,
  onMCPIndexChange,
  onMCPSelect,
  onUndo,
  onRedo,
  onToggleTimeline,
}: KeyboardShortcutsOptions) {
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);

  // Track escape prefix for Alt+letter combos (cross-platform: Windows/macOS/Linux)
  // All terminals send Alt+letter as ESC + letter sequence
  const altPrefixRef = useRef(false);
  const altTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Clean up timeout on unmount
  useEffect(() => {
    return () => {
      if (altTimeoutRef.current) {
        clearTimeout(altTimeoutRef.current);
      }
    };
  }, []);

  const navigateToScreen = useCallback(
    (screen: string) => {
      onBlockInput?.(SHORTCUT_INPUT_BLOCK_MS);
      onNavigate?.(screen);
    },
    [onBlockInput, onNavigate]
  );

  // Reset suggestion index when suggestions change
  useEffect(() => {
    setSelectedSuggestionIndex(0);
    if (onSuggestionSelect) {
      onSuggestionSelect(0);
    }
  }, [suggestions.length, onSuggestionSelect]);

  useInput(
    (inputChar, key) => {
      if (isCommandPaletteOpen) {
        return;
      }

      // ESC key - could be start of Alt+letter combo OR standalone escape
      if (key.escape) {
        // For sessions/models/mcp screens, navigate directly without timeout
        if (activeScreen === 'sessions' || activeScreen === 'models' || activeScreen === 'mcp') {
          onNavigate?.('chat');
          return;
        }

        // IMMEDIATELY interrupt if processing in chat mode - don't wait
        if (agentLoop && isProcessing && activeScreen === 'chat') {
          agentLoop.handleEscapeKey();
          if (onEscapeWithQueue) {
            onEscapeWithQueue();
          } else if (onEscape) {
            onEscape();
          }
          return;
        }

        // Set up timeout to detect Alt+letter combos
        // If another character arrives within timeout, it's Alt+letter
        // If no character arrives, it's a standalone ESC (interrupt after short delay)
        if (altTimeoutRef.current) {
          clearTimeout(altTimeoutRef.current);
        }
        altPrefixRef.current = true;
        altTimeoutRef.current = setTimeout(() => {
          altPrefixRef.current = false;
          // No letter followed ESC within timeout -> this was a standalone ESC
          // If on a non-chat screen, navigate back to chat
          if (activeScreen !== 'chat') {
            onNavigate?.('chat');
            return;
          }
          // In chat mode: interrupt if processing
          if (agentLoop && isProcessing) {
            agentLoop.handleEscapeKey();
          }
          if (onEscapeWithQueue) {
            onEscapeWithQueue();
          } else if (onEscape) {
            onEscape();
          }
        }, ESC_INTERRUPT_DELAY_MS);
        return;
      }

      // Handle Alt+letter navigation - when escape prefix was received
      if (altPrefixRef.current && inputChar && inputChar.length === 1) {
        clearTimeout(altTimeoutRef.current);
        altPrefixRef.current = false;

        onBlockInput?.(SHORTCUT_INPUT_BLOCK_MS);
        const char = inputChar.toLowerCase();

        switch (char) {
          case 'h':
            navigateToScreen('help');
            return;
          case 'm':
            navigateToScreen('markets');
            return;
          case 'p':
            navigateToScreen('portfolio');
            return;
          case 'g':
            navigateToScreen('chart');
            return;
          case 't':
            navigateToScreen('trades');
            return;
          case 'a':
            navigateToScreen('alerts');
            return;
          case 'y':
            navigateToScreen('analysis');
            return;
          case 'n':
            navigateToScreen('news');
            return;
          case 'w':
            navigateToScreen('watchlist');
            return;
          case 's':
            navigateToScreen('search');
            return;
          case 'r':
            navigateToScreen('chat');
            return;
          case 'o':
            navigateToScreen('models');
            return;
          case 'd':
            navigateToScreen('orderbook');
            return;
        }
      }

      // Standard ESC key handling (when not part of Alt+letter combo)
      // Already handled in timeout callback above
      if (altPrefixRef.current) {
        return;
      }

      if (hasPendingApproval && activeScreen === 'chat' && inputChar && inputChar.length === 1) {
        const char = inputChar.toLowerCase();
        if (key.ctrl && (char === 'c' || inputChar === '\u0003')) {
          onBlockInput?.(SHORTCUT_INPUT_BLOCK_MS);
          onApprovalKey?.(3);
          return;
        }
        if (char === '1' || char === '2' || char === '3' || char === 'y' || char === 'n') {
          onBlockInput?.(SHORTCUT_INPUT_BLOCK_MS);
          onApprovalKey?.(char === '1' || char === 'y' ? 1 : char === 'n' ? 3 : Number(char));
          return;
        }
        if (key.ctrl && (char === 'o' || inputChar === '\u000f')) {
          onBlockInput?.(SHORTCUT_INPUT_BLOCK_MS);
          onApprovalKey?.(1);
          return;
        }
      }

      // Handle question option selection (number keys 1-9)
      if (hasPendingQuestion && activeScreen === 'chat' && inputChar && inputChar.length === 1) {
        const num = parseInt(inputChar, 10);
        if (num >= 1 && num <= 9) {
          onBlockInput?.(SHORTCUT_INPUT_BLOCK_MS);
          onQuestionSelect?.(num - 1);
          return;
        }
        // Escape to reject question
        if (inputChar === '\u001b') {
          onBlockInput?.(SHORTCUT_INPUT_BLOCK_MS);
          onQuestionReject?.();
          return;
        }
      }

      // Handle question navigation with arrow keys
      if (hasPendingQuestion && activeScreen === 'chat') {
        if (key.upArrow) {
          onBlockInput?.(SHORTCUT_INPUT_BLOCK_MS);
          onQuestionNavigate?.('up');
          return;
        }
        if (key.downArrow) {
          onBlockInput?.(SHORTCUT_INPUT_BLOCK_MS);
          onQuestionNavigate?.('down');
          return;
        }
        // Enter to select highlighted option
        if (key.return) {
          onBlockInput?.(SHORTCUT_INPUT_BLOCK_MS);
          onQuestionSelect?.(-1); // -1 means use current selection
          return;
        }
      }

      if (activeScreen === 'chat' && !showSuggestions) {
        if ((key as { pageUp?: boolean }).pageUp) {
          onHistoryPageUp?.();
          return;
        }

        if ((key as { pageDown?: boolean }).pageDown) {
          onHistoryPageDown?.();
          return;
        }

        // Arrow key scrolling
        if (key.upArrow && onHistoryLineUp) {
          onHistoryLineUp();
          return;
        }

        if (key.downArrow && onHistoryLineDown) {
          onHistoryLineDown();
          return;
        }

        if ((key as { home?: boolean }).home) {
          onHistoryJumpTop?.();
          return;
        }

        if ((key as { end?: boolean }).end) {
          onHistoryJumpBottom?.();
          return;
        }
      }

      // Shift+Tab - cycle through execution modes
      if (key.tab && key.shift) {
        onBlockInput?.(SHORTCUT_INPUT_BLOCK_MS);
        const modes: ExecutionMode[] = ['normal', 'auto-approve'];
        const currentIndex = modes.indexOf(currentMode);
        const nextIndex = (currentIndex + 1) % modes.length;
        const newMode = modes[nextIndex];
        if (onModeChange) {
          onModeChange(newMode);
        }
        if (agentLoop) {
          agentLoop.setExecutionMode(newMode);
        }
        return;
      }

      // Handle suggestion navigation
      if (showSuggestions && activeScreen === 'chat' && !isProcessing) {
        if (key.downArrow) {
          setSelectedSuggestionIndex((prev) => Math.min(suggestions.length - 1, prev + 1));
          if (onSuggestionSelect) {
            onSuggestionSelect(Math.min(suggestions.length - 1, selectedSuggestionIndex + 1));
          }
          return;
        }
        if (key.upArrow) {
          setSelectedSuggestionIndex((prev) => Math.max(0, prev - 1));
          if (onSuggestionSelect) {
            onSuggestionSelect(Math.max(0, selectedSuggestionIndex - 1));
          }
          return;
        }
      }

      // Handle sessions screen navigation
      if (activeScreen === 'sessions') {
        if (key.escape) {
          onNavigate?.('chat');
          return;
        }
        if (key.upArrow && sessions.length > 0) {
          const newIndex = (selectedSessionIndex - 1 + sessions.length) % sessions.length;
          onSessionIndexChange?.(newIndex);
          return;
        }
        if (key.downArrow && sessions.length > 0) {
          const newIndex = (selectedSessionIndex + 1) % sessions.length;
          onSessionIndexChange?.(newIndex);
          return;
        }
        if (key.return && sessions.length > 0) {
          onSessionSelect?.();
          return;
        }
        return;
      }

      // Handle models screen navigation
      if (activeScreen === 'models') {
        if (modelPickerPhase === 'effort') {
          if (key.escape) {
            onEffortSkip?.();
            return;
          }
          if (key.upArrow && effortOptionCount > 0) {
            onEffortIndexChange?.(
              (selectedEffortIndex - 1 + effortOptionCount) % effortOptionCount
            );
            return;
          }
          if (key.downArrow && effortOptionCount > 0) {
            onEffortIndexChange?.((selectedEffortIndex + 1) % effortOptionCount);
            return;
          }
          if (key.return) {
            onEffortSelect?.();
            return;
          }
          return;
        }

        if (key.escape) {
          onNavigate?.('chat');
          return;
        }
        if (key.upArrow && models.length > 0) {
          const newIndex = (selectedModelIndex - 1 + models.length) % models.length;
          onModelIndexChange?.(newIndex);
          return;
        }
        if (key.downArrow && models.length > 0) {
          const newIndex = (selectedModelIndex + 1) % models.length;
          onModelIndexChange?.(newIndex);
          return;
        }
        if (key.return && models.length > 0) {
          onModelSelect?.();
          return;
        }
        if ((inputChar === 'c' || inputChar === 'C') && models.length > 0) {
          onModelConnect?.();
          return;
        }
        return;
      }

      // Handle MCP screen navigation
      if (activeScreen === 'mcp') {
        if (key.escape) {
          onNavigate?.('chat');
          return;
        }
        if (key.upArrow && mcpServers.length > 0) {
          const newIndex = (selectedMCPIndex - 1 + mcpServers.length) % mcpServers.length;
          onMCPIndexChange?.(newIndex);
          return;
        }
        if (key.downArrow && mcpServers.length > 0) {
          const newIndex = (selectedMCPIndex + 1) % mcpServers.length;
          onMCPIndexChange?.(newIndex);
          return;
        }
        if (key.return && mcpServers.length > 0) {
          onMCPSelect?.();
          return;
        }
        return;
      }

      // Handle Alt+key navigation shortcuts - works from chat AND other screens
      // Windows terminals: Alt+letter typically sends escape prefix + letter (ESC = \x1b = charCode 27)
      // We detect Alt combos by: (1) key.meta on macOS, or (2) inputChar being single high-ascii letter
      // Exclude Ctrl+O (transcript) and Ctrl+E (show all) from this check
      const isCtrlShortcut = key.ctrl && (inputChar === 'o' || inputChar === 'e');
      const isAltCombo =
        key.meta ||
        (inputChar &&
          inputChar.length === 1 &&
          !isCtrlShortcut &&
          (inputChar as string).charCodeAt(0) >= 128 &&
          !key.ctrl);
      if (isAltCombo && inputChar && inputChar.length === 1 && !key.ctrl && !key.shift) {
        const char = inputChar.toLowerCase();

        // Check if this is a navigation key (Alt + single letters)
        switch (char) {
          case 'h':
            navigateToScreen('help');
            return;
          case 'm':
            navigateToScreen('markets');
            return;
          case 'p':
            navigateToScreen('portfolio');
            return;
          case 'g':
            navigateToScreen('chart');
            return;
          case 't':
            navigateToScreen('trades');
            return;
          case 'a':
            navigateToScreen('alerts');
            return;
          case 'y':
            navigateToScreen('analysis');
            return;
          case 'n':
            navigateToScreen('news');
            return;
          case 'w':
            navigateToScreen('watchlist');
            return;
          case 's':
            navigateToScreen('search');
            return;
          case 'r':
            navigateToScreen('chat');
            return;
          case 'o':
            navigateToScreen('models');
            return;
          case 'd':
            navigateToScreen('orderbook');
            return;
        }
      }

      // Ctrl+O: Toggle transcript mode (works in chat and transcript screens)
      if (
        key.ctrl &&
        inputChar === 'o' &&
        (activeScreen === 'chat' || activeScreen === 'transcript') &&
        !isProcessing
      ) {
        onBlockInput?.(SHORTCUT_INPUT_BLOCK_MS);
        onToggleTranscript?.();
        return;
      }

      // Ctrl+E: Toggle show all in transcript (only when in transcript mode)
      if (key.ctrl && inputChar === 'e' && isTranscriptMode && !isProcessing) {
        onBlockInput?.(SHORTCUT_INPUT_BLOCK_MS);
        onToggleShowAllInTranscript?.();
        return;
      }

      // Ctrl+S: Open Settings screen (works from any screen)
      if (key.ctrl && inputChar === 's') {
        onBlockInput?.(SHORTCUT_INPUT_BLOCK_MS);
        onNavigate?.('settings');
        return;
      }

      if (
        key.ctrl &&
        inputChar === 'y' &&
        (activeScreen === 'chat' || activeScreen === 'transcript' || activeScreen === 'settings')
      ) {
        onBlockInput?.(SHORTCUT_INPUT_BLOCK_MS);
        onToggleThinking?.();
      }

      // Ctrl+T: Toggle timeline sidebar
      if (key.ctrl && inputChar === 't' && activeScreen === 'chat') {
        onBlockInput?.(SHORTCUT_INPUT_BLOCK_MS);
        onToggleTimeline?.();
        return;
      }

      // Ctrl+Z: Undo (git-backed file revert)
      if (key.ctrl && inputChar === 'z' && !key.shift) {
        onBlockInput?.(SHORTCUT_INPUT_BLOCK_MS);
        onUndo?.();
        return;
      }

      // Ctrl+Shift+Z: Redo
      if (key.ctrl && key.shift && inputChar === 'z') {
        onBlockInput?.(SHORTCUT_INPUT_BLOCK_MS);
        onRedo?.();
        return;
      }
    },
    { isActive: true }
  );

  return { selectedSuggestionIndex, setSelectedSuggestionIndex };
}
