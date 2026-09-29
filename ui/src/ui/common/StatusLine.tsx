import React from 'react';
import { Box, Text } from 'ink';
import type { ExecutionMode } from '../../index.js';
import type { EffortLevel } from '../../core/providers/catalog.js';
import { getModelDisplayName } from '../../core/providers.js';
import type { GitStatus } from '../../services/GitService.js';
import type { ContextUsage } from '../../services/ContextUsageService.js';
import { ContextProgressBar } from './ContextProgressBar.js';
import { TokenBudgetDisplay } from './TokenBudgetDisplay.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { COLORS, GLYPHS } from '../design/tokens.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StatusLineProps {
  executionMode: ExecutionMode;
  currentModel?: string;
  currentEffort?: EffortLevel;
  isProcessing?: boolean;
  workspaceAgentCount?: number;
  activeTools?: string[];
  gitStatus?: GitStatus | null;
  contextUsage?: ContextUsage | null;
  tokenBudgetUsed?: number;
  tokenBudgetTotal?: number;
  tokenBudgetElapsedMs?: number;
  rateLimitRemaining?: number | null;
  /** Current working directory — truncated with `...` when too long */
  cwd?: string;
  /** Current turn number for progress display */
  turnNumber?: number;
  /** Total turns for progress display */
  totalTurns?: number;
  /** Undo/redo stack indicators */
  undoCount?: number;
  redoCount?: number;
  /** Queued message count */
  queueCount?: number;
  /** Vim mode indicator */
  vimMode?: string;
  /** Auto-lint status */
  autoLintErrors?: number;
}

interface BuildStatusLineOptions {
  executionMode: ExecutionMode;
  currentModel?: string;
  currentEffort?: EffortLevel;
  isProcessing?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function buildStatusLineText(options: BuildStatusLineOptions): string {
  const { executionMode, currentModel, currentEffort, isProcessing } = options;
  const modeLabel = executionMode === 'auto-approve' ? 'AUTO' : 'NORMAL';
  const modelName = currentModel ? getModelDisplayName(currentModel) : 'no model';
  const effortLabel = currentEffort && currentEffort !== 'none' ? `effort:${currentEffort}` : '';
  const thinking = isProcessing ? 'thinking' : '';
  const parts = [modeLabel, modelName, effortLabel, thinking].filter(Boolean);
  return parts.join(` ${GLYPHS.separator} `);
}

function formatGitIndicator(status: GitStatus | null): string | null {
  if (!status?.branch) return null;
  let indicator = status.branch;
  if (status.modified > 0) indicator += '*';
  if (status.staged > 0) indicator += '+';
  if (status.untracked > 0) indicator += '~';
  return indicator;
}

/** Truncate a path string from the left, keeping the tail visible. */
function truncatePath(path: string, maxLen: number): string {
  if (path.length <= maxLen) return path;
  return `...${path.slice(path.length - maxLen + 3)}`;
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
 * Custom props equality function for React.memo on StatusLine.
 * Prevents re-renders when props haven't meaningfully changed.
 */
export function statusLinePropsEqual(prev: StatusLineProps, next: StatusLineProps): boolean {
  return (
    prev.executionMode === next.executionMode &&
    prev.currentModel === next.currentModel &&
    prev.currentEffort === next.currentEffort &&
    prev.isProcessing === next.isProcessing &&
    prev.cwd === next.cwd &&
    prev.turnNumber === next.turnNumber &&
    prev.totalTurns === next.totalTurns &&
    prev.undoCount === next.undoCount &&
    prev.redoCount === next.redoCount &&
    prev.queueCount === next.queueCount &&
    prev.vimMode === next.vimMode &&
    prev.autoLintErrors === next.autoLintErrors &&
    arraysEqual(prev.activeTools, next.activeTools) &&
    prev.gitStatus === next.gitStatus &&
    prev.contextUsage === next.contextUsage &&
    prev.tokenBudgetUsed === next.tokenBudgetUsed &&
    prev.tokenBudgetTotal === next.tokenBudgetTotal &&
    prev.tokenBudgetElapsedMs === next.tokenBudgetElapsedMs &&
    prev.rateLimitRemaining === next.rateLimitRemaining
  );
}

// ---------------------------------------------------------------------------
// Separator helper — renders ` · ` between status elements
// ---------------------------------------------------------------------------

function Sep() {
  return <Text color={COLORS.muted}> {GLYPHS.separator} </Text>;
}

// ---------------------------------------------------------------------------
// Execution mode badge
// ---------------------------------------------------------------------------

function ExecutionModeBadge({ mode }: { mode: ExecutionMode }) {
  const isAuto = mode === 'auto-approve';
  return (
    <Text color={isAuto ? COLORS.warning : COLORS.success} bold>
      {isAuto ? 'AUTO' : 'NORMAL'}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * Status line showing execution mode, git status, context usage, and model.
 * Always reserves space for the thinking animation to prevent layout shifts
 * when processing starts/stops.
 */
function StatusLineComponent(props: StatusLineProps) {
  const {
    executionMode,
    currentModel,
    currentEffort,
    workspaceAgentCount,
    gitStatus,
    contextUsage,
    tokenBudgetUsed,
    tokenBudgetTotal,
    tokenBudgetElapsedMs,
    rateLimitRemaining,
    cwd,
    turnNumber,
    totalTurns,
    undoCount,
    redoCount,
    queueCount,
    vimMode,
    autoLintErrors,
  } = props;
  const { width } = useTerminalSize();
  const rawGitIndicator = formatGitIndicator(gitStatus ?? null);
  const gitIndicator =
    rawGitIndicator && rawGitIndicator.length > 22
      ? `${rawGitIndicator.slice(0, 19)}...`
      : rawGitIndicator;
  const modelName = currentModel ? getModelDisplayName(currentModel) : 'no model configured';
  const compact = width < 170;

  const hasTokenBudget =
    tokenBudgetUsed != null && tokenBudgetTotal != null && tokenBudgetTotal > 0;
  // Agent count removed — getVisible() counts configured definitions, not running agents

  // Cwd display — truncated from the left so the leaf directory stays visible
  const cwdDisplay =
    cwd && !compact ? truncatePath(cwd, Math.min(30, Math.floor(width * 0.25))) : null;

  // Turn progress display
  const turnDisplay =
    typeof turnNumber === 'number' && typeof totalTurns === 'number' && totalTurns > 0
      ? `${turnNumber}/${totalTurns}`
      : null;

  // Keep the footer to one terminal row at normal console widths. The chat
  // pane already owns a separate row for the thinking indicator.
  if (compact) {
    const fixedWidth = 22 + (turnDisplay ? turnDisplay.length + 3 : 0) + (contextUsage ? 13 : 0) + ((queueCount ?? 0) > 0 ? 11 : 0);
    const compactModel = modelName.length > Math.max(10, width - fixedWidth)
      ? `${modelName.slice(0, Math.max(7, width - fixedWidth - 3))}...`
      : modelName;
    return (
      <Box flexDirection="row" flexWrap="nowrap" width={Math.max(20, width)}>
        <ExecutionModeBadge mode={executionMode} />
        <Sep />
        <Text color={currentModel ? COLORS.accent : COLORS.muted} wrap="truncate">{compactModel}</Text>
        {turnDisplay && <><Sep /><Text color={COLORS.accent}>{turnDisplay}</Text></>}
        {contextUsage && <><Sep /><ContextProgressBar usage={contextUsage} width={8} /></>}
        {(queueCount ?? 0) > 0 && <><Sep /><Text color={COLORS.warning}>q:{queueCount}</Text></>}
      </Box>
    );
  }

  return (
    <Box flexDirection="row" width={Math.max(20, width)}>
      <Box flexDirection="row" flexWrap="nowrap" flexShrink={1}>
        {/* Execution mode badge */}
        <ExecutionModeBadge mode={executionMode} />

        {/* Cwd display */}
        {cwdDisplay && (
          <>
            <Sep />
            <Text color={COLORS.muted} wrap="truncate">
              {cwdDisplay}
            </Text>
          </>
        )}

        {/* Git indicator */}
        {gitIndicator && (
          <>
            <Sep />
            <Text color={COLORS.highlight}>{gitIndicator}</Text>
          </>
        )}

        {/* Model name */}
        <Sep />
        <Text color={currentModel ? COLORS.accent : COLORS.muted} wrap="truncate">
          {compact && modelName.length > 18 ? `${modelName.slice(0, 15)}...` : modelName}
        </Text>

        {/* Effort level */}
        {currentEffort && currentEffort !== 'none' && (
          <>
            <Sep />
            <Text color={COLORS.highlight}>{currentEffort}</Text>
          </>
        )}

        {/* Turn progress */}
        {turnDisplay && (
          <>
            <Sep />
            <Text color={COLORS.accent}>
              {GLYPHS.diamond} {turnDisplay}
            </Text>
          </>
        )}

        {/* Undo/Redo indicators */}
        {(undoCount ?? 0) > 0 && (
          <>
            <Sep />
            <Text color={COLORS.muted}>undo:{undoCount}</Text>
          </>
        )}
        {(redoCount ?? 0) > 0 && (
          <>
            <Sep />
            <Text color={COLORS.muted}>redo:{redoCount}</Text>
          </>
        )}

        {/* Queue count */}
        {(queueCount ?? 0) > 0 && (
          <>
            <Sep />
            <Text color={COLORS.warning}>queued:{queueCount}</Text>
          </>
        )}

        {/* Vim mode */}
        {vimMode && (
          <>
            <Sep />
            <Text color={COLORS.accent} bold>[{vimMode}]</Text>
          </>
        )}

        {/* Auto-lint errors */}
        {(autoLintErrors ?? 0) > 0 && (
          <>
            <Sep />
            <Text color={COLORS.error}>lint:{autoLintErrors}</Text>
          </>
        )}

        {/* Context usage bar */}
        {contextUsage && (
          <>
            <Sep />
            <ContextProgressBar usage={contextUsage} width={compact ? 10 : 16} />
          </>
        )}

        {/* Token budget */}
        {hasTokenBudget && !compact && (
          <>
            <Sep />
            <TokenBudgetDisplay
              used={tokenBudgetUsed ?? 0}
              budget={tokenBudgetTotal ?? 0}
              elapsedMs={tokenBudgetElapsedMs ?? 0}
              rateLimitRemaining={rateLimitRemaining}
            />
          </>
        )}

        {/* Keyboard shortcut hints — shown on wide terminals */}
        {!compact && (
          <>
            <Sep />
            <Text color={COLORS.muted}>{GLYPHS.expandHint} Ctrl+K</Text>
          </>
        )}
      </Box>
    </Box>
  );
}

export const StatusLine = React.memo(StatusLineComponent, statusLinePropsEqual);
