/**
 * Goal Tool (Unified)
 *
 * Single unified tool that lets the agent create goals with steps,
 * manage steps, check progress, and advance the goal workflow.
 * Implements ToolHandler interface for integration with the tool registry.
 *
 * Follows the same action-based dispatch pattern as CronTool.
 */

import type { ToolCall, ToolResult, ToolHandler, ToolDefinition } from '@dyna/contracts';
import type { GoalStep } from '@dyna/agent-core';
import { GoalManager } from '@dyna/agent-core';

export class GoalTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'goal',
    description: 'Manage step-based goals. Actions: create, add_step, complete_step, status, list, update_step',
    category: 'session',
    inputSchema: {
      action: 'string',
      goalId: 'string?',
      title: 'string?',
      description: 'string?',
      stepId: 'string?',
      status: 'string?',
      output: 'string?',
      steps: 'any?',
      dependsOn: 'string[]?',
      assignableTools: 'string[]?',
    },
    outputSchema: { success: 'boolean', message: 'string', data: 'object?' },
    permissionsRequired: [],
    sideEffects: ['goal_created', 'goal_updated', 'step_updated'],
    riskLevel: 'low',
    timeoutMs: 10000,
  };

  constructor(private goalManager: GoalManager) {}

  async execute(call: ToolCall): Promise<ToolResult> {
    const start = Date.now();
    try {
      const action = call.args.action as string | undefined;
      if (!action || typeof action !== 'string') {
        return {
          success: false,
          error: 'action is required (create, add_step, complete_step, status, list, update_step)',
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      switch (action) {
        case 'create':
          return this.handleCreate(call, start);
        case 'add_step':
          return this.handleAddStep(call, start);
        case 'complete_step':
          return this.handleCompleteStep(call, start);
        case 'status':
          return this.handleStatus(call, start);
        case 'list':
          return this.handleList(call, start);
        case 'update_step':
          return this.handleUpdateStep(call, start);
        default:
          return {
            success: false,
            error: `Unknown action: "${action}". Valid actions: create, add_step, complete_step, status, list, update_step`,
            durationMs: Date.now() - start,
            truncated: false,
          };
      }
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message ?? String(err),
        durationMs: Date.now() - start,
        truncated: false,
      };
    }
  }

  private async handleCreate(call: ToolCall, start: number): Promise<ToolResult> {
    const title = call.args.title as string | undefined;
    if (!title || typeof title !== 'string') {
      return {
        success: false,
        error: 'title must be a non-empty string',
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    const description = (call.args.description as string) ?? '';
    const sessionId = (call.args.sessionId as string) ?? 'default';

    const goal = this.goalManager.createGoal(sessionId, title, description);

    const steps = call.args.steps as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(steps)) {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i]!;
        this.goalManager.addStep(goal.id, {
          title: (step.title as string) ?? `Step ${i + 1}`,
          description: (step.description as string) ?? '',
          order: (step.order as number) ?? i,
          dependsOn: (step.dependsOn as string[]) ?? [],
          assignableTools: step.assignableTools as string[] | undefined,
        });
      }
      const progress = this.goalManager.getGoalProgress(goal.id);
      const nextSteps = this.goalManager.getNextSteps(goal.id);

      return {
        success: true,
        data: {
          goalId: goal.id,
          title: goal.title,
          stepCount: steps.length,
          progress,
          nextSteps: nextSteps.length > 0 ? nextSteps.map((s) => ({ id: s.id, title: s.title, order: s.order })) : [],
        },
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    return {
      success: true,
      data: {
        goalId: goal.id,
        title: goal.title,
        stepCount: 0,
      },
      durationMs: Date.now() - start,
      truncated: false,
    };
  }

  private async handleAddStep(call: ToolCall, start: number): Promise<ToolResult> {
    const goalId = call.args.goalId as string | undefined;
    if (!goalId || typeof goalId !== 'string') {
      return {
        success: false,
        error: 'goalId must be a non-empty string',
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    const title = call.args.title as string | undefined;
    if (!title || typeof title !== 'string') {
      return {
        success: false,
        error: 'title must be a non-empty string',
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    const description = (call.args.description as string) ?? '';
    const dependsOn = (call.args.dependsOn as string[]) ?? [];
    const assignableTools = call.args.assignableTools as string[] | undefined;
    const existingSteps = this.goalManager.listSteps(goalId);

    const step = this.goalManager.addStep(goalId, {
      title,
      description,
      order: existingSteps.length,
      dependsOn,
      assignableTools,
    });

    return {
      success: true,
      data: {
        stepId: step.id,
        title: step.title,
        order: step.order,
        status: step.status,
      },
      durationMs: Date.now() - start,
      truncated: false,
    };
  }

  private async handleCompleteStep(call: ToolCall, start: number): Promise<ToolResult> {
    const goalId = call.args.goalId as string | undefined;
    if (!goalId || typeof goalId !== 'string') {
      return {
        success: false,
        error: 'goalId must be a non-empty string',
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    const stepId = call.args.stepId as string | undefined;
    if (!stepId || typeof stepId !== 'string') {
      return {
        success: false,
        error: 'stepId must be a non-empty string',
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    const output = call.args.output as string | undefined;
    this.goalManager.updateStepStatus(goalId, stepId, 'completed', output);

    const advance = this.goalManager.autoAdvance(goalId);
    const progress = this.goalManager.getGoalProgress(goalId);

    return {
      success: true,
      data: {
        completedStepId: stepId,
        goalProgress: progress,
        advanced: advance.advanced,
        nextSteps: advance.nextSteps.map((s) => ({ id: s.id, title: s.title, order: s.order, status: s.status })),
        goalCompleted: progress.percentComplete === 100,
      },
      durationMs: Date.now() - start,
      truncated: false,
    };
  }

  private async handleStatus(call: ToolCall, start: number): Promise<ToolResult> {
    const goalId = call.args.goalId as string | undefined;
    if (!goalId || typeof goalId !== 'string') {
      return {
        success: false,
        error: 'goalId must be a non-empty string',
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    const goal = this.goalManager.getGoal(goalId);
    if (!goal) {
      return {
        success: false,
        error: `Goal not found: ${goalId}`,
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    const progress = this.goalManager.getGoalProgress(goalId);
    const nextSteps = this.goalManager.getNextSteps(goalId);
    const allSteps = this.goalManager.listSteps(goalId);

    return {
      success: true,
      data: {
        goalId: goal.id,
        title: goal.title,
        status: goal.status,
        description: goal.description,
        sessionId: goal.sessionId,
        progress,
        steps: allSteps.map((s) => ({
          id: s.id,
          title: s.title,
          order: s.order,
          status: s.status,
          dependsOn: s.dependsOn,
          output: s.output,
        })),
        nextSteps: nextSteps.map((s) => ({ id: s.id, title: s.title, order: s.order })),
        budget: {
          turns: `${goal.budget.currentTurns}/${goal.budget.maxTurns}`,
          toolCalls: `${goal.budget.currentToolCalls}/${goal.budget.maxToolCalls}`,
        },
      },
      durationMs: Date.now() - start,
      truncated: false,
    };
  }

  private async handleList(call: ToolCall, start: number): Promise<ToolResult> {
    const sessionId = (call.args.sessionId as string) ?? 'default';
    const goals = this.goalManager.listGoals(sessionId);
    let filtered = goals;
    const statusFilter = call.args.status as string | undefined;
    if (statusFilter) {
      filtered = filtered.filter((g) => g.status === statusFilter);
    }

    const data = filtered.map((goal) => {
      const progress = this.goalManager.getGoalProgress(goal.id);
      return {
        id: goal.id,
        title: goal.title,
        status: goal.status,
        stepCount: progress.total,
        percentComplete: progress.percentComplete,
      };
    });

    return {
      success: true,
      data: { goals: data, count: data.length },
      durationMs: Date.now() - start,
      truncated: false,
    };
  }

  private async handleUpdateStep(call: ToolCall, start: number): Promise<ToolResult> {
    const goalId = call.args.goalId as string | undefined;
    if (!goalId || typeof goalId !== 'string') {
      return {
        success: false,
        error: 'goalId must be a non-empty string',
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    const stepId = call.args.stepId as string | undefined;
    if (!stepId || typeof stepId !== 'string') {
      return {
        success: false,
        error: 'stepId must be a non-empty string',
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    const newStatus = call.args.status as string | undefined;
    const output = call.args.output as string | undefined;

    if (newStatus) {
      const validStatuses = ['pending', 'in_progress', 'completed', 'blocked', 'failed'];
      if (!validStatuses.includes(newStatus)) {
        return {
          success: false,
          error: `Invalid status "${newStatus}". Valid: ${validStatuses.join(', ')}`,
          durationMs: Date.now() - start,
          truncated: false,
        };
      }
      this.goalManager.updateStepStatus(goalId, stepId, newStatus as GoalStep['status'], output);
    }

    const step = this.goalManager.getStep(goalId, stepId);
    if (!step) {
      return {
        success: false,
        error: `Step not found after update: ${stepId}`,
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    return {
      success: true,
      data: {
        stepId: step.id,
        title: step.title,
        status: step.status,
        order: step.order,
        output: step.output,
      },
      durationMs: Date.now() - start,
      truncated: false,
    };
  }
}
