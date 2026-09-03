/**
 * Goal Manager — Persistent goal tracking (Codex /goal equivalent)
 *
 * SQLite-backed goal persistence with token budgets, auto-continuation,
 * and budget enforcement.
 */

import { randomUUID } from 'crypto';
import type { StateDb } from 'dynatrader';

export type GoalStatus = 'active' | 'paused' | 'completed' | 'failed' | 'budget_limited';

export interface Goal {
  id: string;
  objective: string;
  status: GoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  sessionId: string | null;
  planId: string | null;
  progress: {
    stepsCompleted: number;
    totalSteps: number;
    percentComplete: number;
  };
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  validationCriteria: string | null;
  exclusions: string[];
}

export interface GoalOptions {
  tokenBudget?: number;
  sessionId?: string;
  planId?: string;
  validationCriteria?: string;
  exclusions?: string[];
}

export class GoalManager {
  private db: StateDb;
  private currentGoal: Goal | null = null;

  constructor(db: StateDb) {
    this.db = db;
    this.loadCurrentGoal();
  }

  private loadCurrentGoal(): void {
    const active = this.db.loadActiveGoalCompat();
    if (active) {
      this.currentGoal = {
        id: active.id,
        objective: active.objective,
        status: active.status as GoalStatus,
        tokenBudget: active.tokenBudget,
        tokensUsed: active.tokensUsed,
        sessionId: active.sessionId,
        planId: active.planId,
        progress: active.progress as Goal['progress'],
        createdAt: active.createdAt,
        updatedAt: active.updatedAt,
        completedAt: active.completedAt,
        validationCriteria: active.validationCriteria,
        exclusions: active.exclusions,
      };
    }
  }

  setGoal(objective: string, options?: GoalOptions): Goal {
    if (this.currentGoal?.status === 'active') {
      this.pauseGoal();
    }

    const id = `goal_${randomUUID().slice(0, 8)}`;
    const now = Date.now();

    const goal: Goal = {
      id,
      objective,
      status: 'active',
      tokenBudget: options?.tokenBudget ?? null,
      tokensUsed: 0,
      sessionId: options?.sessionId ?? null,
      planId: options?.planId ?? null,
      progress: { stepsCompleted: 0, totalSteps: 0, percentComplete: 0 },
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      validationCriteria: options?.validationCriteria ?? null,
      exclusions: options?.exclusions ?? [],
    };

    this.db.saveGoalCompat({
      id: goal.id,
      objective: goal.objective,
      status: goal.status,
      tokenBudget: goal.tokenBudget ?? undefined,
      tokensUsed: goal.tokensUsed,
      sessionId: goal.sessionId ?? undefined,
      planId: goal.planId ?? undefined,
      progress: goal.progress,
      createdAt: goal.createdAt,
      updatedAt: goal.updatedAt,
      completedAt: goal.completedAt ?? undefined,
      validationCriteria: goal.validationCriteria ?? undefined,
      exclusions: goal.exclusions,
    });

    this.currentGoal = goal;
    return goal;
  }

  getGoal(): Goal | null {
    return this.currentGoal;
  }

  updateProgress(tokensUsed: number): Goal | null {
    if (!this.currentGoal) return null;

    this.currentGoal.tokensUsed += tokensUsed;
    this.currentGoal.updatedAt = Date.now();

    if (
      this.currentGoal.tokenBudget !== null &&
      this.currentGoal.tokensUsed >= this.currentGoal.tokenBudget
    ) {
      this.currentGoal.status = 'budget_limited';
    }

    this.db.saveGoalCompat({
      id: this.currentGoal.id,
      objective: this.currentGoal.objective,
      status: this.currentGoal.status,
      tokenBudget: this.currentGoal.tokenBudget ?? undefined,
      tokensUsed: this.currentGoal.tokensUsed,
      sessionId: this.currentGoal.sessionId ?? undefined,
      planId: this.currentGoal.planId ?? undefined,
      progress: this.currentGoal.progress,
      createdAt: this.currentGoal.createdAt,
      updatedAt: this.currentGoal.updatedAt,
      completedAt: this.currentGoal.completedAt ?? undefined,
      validationCriteria: this.currentGoal.validationCriteria ?? undefined,
      exclusions: this.currentGoal.exclusions,
    });

    return this.currentGoal;
  }

  updateSteps(completed: number, total: number): Goal | null {
    if (!this.currentGoal) return null;

    this.currentGoal.progress = {
      stepsCompleted: completed,
      totalSteps: total,
      percentComplete: total > 0 ? Math.round((completed / total) * 100) : 0,
    };
    this.currentGoal.updatedAt = Date.now();

    this.db.saveGoalCompat({
      id: this.currentGoal.id,
      objective: this.currentGoal.objective,
      status: this.currentGoal.status,
      tokenBudget: this.currentGoal.tokenBudget ?? undefined,
      tokensUsed: this.currentGoal.tokensUsed,
      sessionId: this.currentGoal.sessionId ?? undefined,
      planId: this.currentGoal.planId ?? undefined,
      progress: this.currentGoal.progress,
      createdAt: this.currentGoal.createdAt,
      updatedAt: this.currentGoal.updatedAt,
      completedAt: this.currentGoal.completedAt ?? undefined,
      validationCriteria: this.currentGoal.validationCriteria ?? undefined,
      exclusions: this.currentGoal.exclusions,
    });

    return this.currentGoal;
  }

  completeGoal(): Goal | null {
    if (!this.currentGoal) return null;

    this.currentGoal.status = 'completed';
    this.currentGoal.completedAt = Date.now();
    this.currentGoal.updatedAt = Date.now();
    this.currentGoal.progress = {
      ...this.currentGoal.progress,
      percentComplete: 100,
    };

    this.db.saveGoalCompat({
      id: this.currentGoal.id,
      objective: this.currentGoal.objective,
      status: 'completed',
      tokenBudget: this.currentGoal.tokenBudget ?? undefined,
      tokensUsed: this.currentGoal.tokensUsed,
      sessionId: this.currentGoal.sessionId ?? undefined,
      planId: this.currentGoal.planId ?? undefined,
      progress: this.currentGoal.progress,
      createdAt: this.currentGoal.createdAt,
      updatedAt: this.currentGoal.updatedAt,
      completedAt: this.currentGoal.completedAt,
      validationCriteria: this.currentGoal.validationCriteria ?? undefined,
      exclusions: this.currentGoal.exclusions,
    });

    const completed = this.currentGoal;
    this.currentGoal = null;
    return completed;
  }

  pauseGoal(): Goal | null {
    if (!this.currentGoal) return null;

    this.currentGoal.status = 'paused';
    this.currentGoal.updatedAt = Date.now();

    this.db.saveGoalCompat({
      id: this.currentGoal.id,
      objective: this.currentGoal.objective,
      status: 'paused',
      tokenBudget: this.currentGoal.tokenBudget ?? undefined,
      tokensUsed: this.currentGoal.tokensUsed,
      sessionId: this.currentGoal.sessionId ?? undefined,
      planId: this.currentGoal.planId ?? undefined,
      progress: this.currentGoal.progress,
      createdAt: this.currentGoal.createdAt,
      updatedAt: this.currentGoal.updatedAt,
      completedAt: this.currentGoal.completedAt ?? undefined,
      validationCriteria: this.currentGoal.validationCriteria ?? undefined,
      exclusions: this.currentGoal.exclusions,
    });

    return this.currentGoal;
  }

  resumeGoal(): Goal | null {
    if (!this.currentGoal || this.currentGoal.status !== 'paused') return null;

    this.currentGoal.status = 'active';
    this.currentGoal.updatedAt = Date.now();

    this.db.saveGoalCompat({
      id: this.currentGoal.id,
      objective: this.currentGoal.objective,
      status: 'active',
      tokenBudget: this.currentGoal.tokenBudget ?? undefined,
      tokensUsed: this.currentGoal.tokensUsed,
      sessionId: this.currentGoal.sessionId ?? undefined,
      planId: this.currentGoal.planId ?? undefined,
      progress: this.currentGoal.progress,
      createdAt: this.currentGoal.createdAt,
      updatedAt: this.currentGoal.updatedAt,
      completedAt: this.currentGoal.completedAt ?? undefined,
      validationCriteria: this.currentGoal.validationCriteria ?? undefined,
      exclusions: this.currentGoal.exclusions,
    });

    return this.currentGoal;
  }

  failGoal(reason?: string): Goal | null {
    if (!this.currentGoal) return null;

    this.currentGoal.status = 'failed';
    this.currentGoal.updatedAt = Date.now();

    this.db.saveGoalCompat({
      id: this.currentGoal.id,
      objective: this.currentGoal.objective,
      status: 'failed',
      tokenBudget: this.currentGoal.tokenBudget ?? undefined,
      tokensUsed: this.currentGoal.tokensUsed,
      sessionId: this.currentGoal.sessionId ?? undefined,
      planId: this.currentGoal.planId ?? undefined,
      progress: this.currentGoal.progress,
      createdAt: this.currentGoal.createdAt,
      updatedAt: this.currentGoal.updatedAt,
      completedAt: this.currentGoal.completedAt ?? undefined,
      validationCriteria: this.currentGoal.validationCriteria ?? undefined,
      exclusions: this.currentGoal.exclusions,
    });

    const failed = this.currentGoal;
    this.currentGoal = null;
    return failed;
  }

  clearGoal(): void {
    this.currentGoal = null;
  }

  buildContinuationPrompt(): string | null {
    if (!this.currentGoal || this.currentGoal.status !== 'active') return null;

    const { objective, progress, tokenBudget, tokensUsed } = this.currentGoal;
    const budgetInfo = tokenBudget
      ? ` Token budget: ${tokensUsed}/${tokenBudget} (${Math.round((tokensUsed / tokenBudget) * 100)}% used).`
      : '';

    return [
      `You have an active goal: "${objective}"`,
      `Progress: ${progress.stepsCompleted}/${progress.totalSteps} steps (${progress.percentComplete}%).`,
      budgetInfo,
      'Continue working toward this goal. Do not stop until the goal is completed or paused.',
    ]
      .filter(Boolean)
      .join(' ');
  }
}

export default GoalManager;
