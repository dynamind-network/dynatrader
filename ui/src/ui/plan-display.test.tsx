import React from 'react';
import { describe, expect, it } from 'vitest';
import { PlanDisplay } from './plan-display.js';

function collectText(node: unknown): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') return [];
  if (typeof node === 'string' || typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap((child) => collectText(child));
  if (React.isValidElement(node)) {
    return collectText((node.props as { children?: unknown }).children);
  }
  return [];
}

function normalizeText(node: unknown): string {
  return collectText(node).join(' ').replace(/\s+/g, ' ').trim();
}

describe('PlanDisplay', () => {
  it('renders the plan title, steps, and actions', () => {
    const element = PlanDisplay({
      plan: {
        id: 'plan-1',
        title: 'Refactor terminal planning',
        description: 'Improve the plan-mode flow',
        steps: [
          {
            id: 'step-1',
            description: 'Inspect current plan wiring',
            reasoning: 'Read-only discovery',
            status: 'pending',
          },
          {
            id: 'step-2',
            description: 'Wire approval handoff',
            reasoning: 'Preserve the review loop',
            status: 'completed',
          },
        ],
        status: 'proposed',
        createdAt: new Date('2026-07-10T00:00:00Z'),
        filePath: '/tmp/.dynamind/plans/refactor-terminal-planning.md',
      },
    });

    const text = normalizeText(element);
    expect(text).toContain('Refactor terminal planning');
    expect(text).toContain('Improve the plan-mode flow');
    expect(text).toContain('File: /tmp/.dynamind/plans/refactor-terminal-planning.md');
    expect(text).toContain('Status: proposed | Approval: Pending review | 2 steps');
    expect(text).toContain('Inspect current plan wiring');
    expect(text).toContain('Approve & build');
    expect(text).toContain('Revise plan');
  });

  it('shows approval state for approved plans', () => {
    const element = PlanDisplay({
      plan: {
        id: 'plan-2',
        title: 'Approved plan',
        description: 'Ready to build',
        steps: [],
        status: 'approved',
        createdAt: new Date('2026-07-10T00:00:00Z'),
      },
      showActions: false,
    });

    const text = normalizeText(element);
    expect(text).toContain('Status: approved | Approval: Approved | 0 steps');
  });
});
