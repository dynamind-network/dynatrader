import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Spinner } from './design/Spinner.js';
import { COLORS, GLYPHS, SPACING } from './design/tokens.js';
import type { Plan, PlanStep } from '../core/plan-manager.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface PlanDisplayProps {
  plan: Plan;
  selectedAction?: 'approve' | 'revise';
  showActions?: boolean;
  /** Called when the user reorders a step via arrow keys. */
  onReorder?: (fromIndex: number, toIndex: number) => void;
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

function statusLabel(status: Plan['status']): string {
  switch (status) {
    case 'approved':
      return 'Approved';
    case 'executing':
      return 'Approved and executing';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return 'Pending review';
  }
}

/**
 * Render the status glyph for a step: spinner for in-progress,
 * check/cross/pending glyphs for terminal states.
 */
function StepGlyph({ status }: { status: PlanStep['status'] }) {
  switch (status) {
    case 'in_progress':
      return <Spinner color={COLORS.warning} />;
    case 'completed':
      return <Text color={COLORS.success}>{GLYPHS.check}</Text>;
    case 'failed':
      return <Text color={COLORS.error}>{GLYPHS.cross}</Text>;
    case 'skipped':
      return <Text color={COLORS.muted}>{GLYPHS.toolPending}</Text>;
    case 'pending':
    default:
      return <Text color={COLORS.muted}>{GLYPHS.toolPending}</Text>;
  }
}

/**
 * Derive the color for the step description text based on status.
 */
function stepTextColor(status: PlanStep['status']): string | undefined {
  switch (status) {
    case 'failed':
      return COLORS.error;
    case 'completed':
      return COLORS.success;
    case 'in_progress':
      return COLORS.warning;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** Plan display card with expandable steps, progress indicators, and reordering. */
export function PlanDisplay({
  plan,
  selectedAction = 'approve',
  showActions = true,
  onReorder,
}: PlanDisplayProps) {
  // Track which steps are expanded (keyed by step id)
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());

  // Track which step index is selected for reordering
  const [selectedIndex, setSelectedIndex] = useState<number>(0);

  const toggleExpand = (stepId: string) => {
    setExpandedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(stepId)) {
        next.delete(stepId);
      } else {
        next.add(stepId);
      }
      return next;
    });
  };

  // Tab expands/collapses the currently selected step
  // Arrow keys reorder when onReorder is provided
  useInput((input, key) => {
    if (key.tab) {
      const step = plan.steps[selectedIndex];
      if (step) {
        toggleExpand(step.id);
      }
      return;
    }

    if (!onReorder) return;

    if (key.upArrow) {
      const newIndex = selectedIndex - 1;
      if (newIndex >= 0) {
        setSelectedIndex(newIndex);
        onReorder(selectedIndex, newIndex);
      }
    } else if (key.downArrow) {
      const newIndex = selectedIndex + 1;
      if (newIndex < plan.steps.length) {
        setSelectedIndex(newIndex);
        onReorder(selectedIndex, newIndex);
      }
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={COLORS.borderAccent}
      paddingX={SPACING.xs}
      paddingY={0}
    >
      <Box justifyContent="space-between" alignItems="center">
        <Text dimColor>Read-only plan review</Text>
        <Text dimColor>{plan.steps.length} steps</Text>
      </Box>

      <Text bold color={COLORS.accent}>
        {plan.title}
      </Text>
      <Text dimColor>{plan.description}</Text>

      <Text dimColor>
        Status: {plan.status} | Approval: {statusLabel(plan.status)} | {plan.steps.length} steps
      </Text>
      <Text dimColor>File: {plan.filePath ?? 'Plan ready for review'}</Text>

      <Box marginTop={1} flexDirection="column">
        {plan.steps.map((step, index) => {
          const isExpanded = expandedSteps.has(step.id);
          const isSelected = index === selectedIndex;
          const textFirstLine = step.description.split('\n')[0];

          return (
            <Box key={step.id} flexDirection="column" marginBottom={0}>
              <Box flexDirection="row" alignItems="center" gap={SPACING.xs}>
                {/* Selection indicator */}
                {isSelected ? <Text color={COLORS.accent}>{GLYPHS.arrow}</Text> : <Text> </Text>}

                {/* Step number */}
                <Text dimColor>{index + 1}.</Text>

                {/* Status glyph */}
                <StepGlyph status={step.status} />

                {/* Step description (first line when collapsed, full when expanded) */}
                <Text color={stepTextColor(step.status)}>
                  {isExpanded ? step.description : textFirstLine}
                </Text>

                {/* Expand hint — every step can be expanded to show full details */}
                {!isExpanded && <Text color={COLORS.muted}> {GLYPHS.expandHint}</Text>}
              </Box>

              {/* Expanded details: reasoning + remaining lines */}
              {isExpanded && (
                <Box marginLeft={SPACING.lg} flexDirection="column">
                  <Text dimColor>{step.reasoning}</Text>
                  {step.error && (
                    <Text color={COLORS.error}>
                      {GLYPHS.cross} {step.error}
                    </Text>
                  )}
                  {step.toolName && <Text dimColor>Tool: {step.toolName}</Text>}
                </Box>
              )}

              {/* Reorder hints on selected step */}
              {isSelected && onReorder && (
                <Box marginLeft={SPACING.sm} flexDirection="row" gap={SPACING.sm}>
                  {index > 0 && <Text color={COLORS.muted}>[{'\u2191'}]</Text>}
                  {index < plan.steps.length - 1 && <Text color={COLORS.muted}>[down]</Text>}
                </Box>
              )}
            </Box>
          );
        })}
      </Box>

      {showActions && (
        <Box marginTop={1} gap={SPACING.sm}>
          <Text inverse={selectedAction === 'approve'} color={COLORS.success}>
            Approve & build
          </Text>
          <Text inverse={selectedAction === 'revise'} color={COLORS.warning}>
            Revise plan
          </Text>
        </Box>
      )}
    </Box>
  );
}

export default PlanDisplay;
