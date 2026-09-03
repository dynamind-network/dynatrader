import { describe, expect, it } from 'vitest';
import { formatPlanTimelineMessage } from './useTimelineEventHandler.js';

describe('formatPlanTimelineMessage', () => {
  it('formats plan mode entry with and without a goal', () => {
    expect(formatPlanTimelineMessage({ type: 'plan_mode_entered' })).toBe('Plan mode enabled.');
    expect(
      formatPlanTimelineMessage({
        type: 'plan_mode_entered',
        goal: 'refactor the terminal plan flow',
      })
    ).toBe('Plan mode enabled: refactor the terminal plan flow');
  });

  it('formats plan mode exit for approval and review states', () => {
    expect(
      formatPlanTimelineMessage({
        type: 'plan_mode_exited',
        approved: true,
      })
    ).toBe('Plan approved. Switching to build mode.');

    expect(
      formatPlanTimelineMessage({
        type: 'plan_mode_exited',
        plan: {
          id: 'plan-1',
          title: 'Refactor the terminal plan flow',
          description: 'Improve plan mode',
          steps: [],
          status: 'proposed',
          createdAt: new Date(),
        },
      })
    ).toBe('Plan submitted for review: Refactor the terminal plan flow');
  });

  it('formats plan step updates with status and description', () => {
    expect(
      formatPlanTimelineMessage({
        type: 'plan_step_update',
        planId: 'plan-1',
        step: {
          id: 'step-1',
          description: 'Inspect current workspace',
          reasoning: 'Read-only discovery',
          status: 'in_progress',
        },
      })
    ).toBe('Plan step update [in_progress]: Inspect current workspace');
  });
});
