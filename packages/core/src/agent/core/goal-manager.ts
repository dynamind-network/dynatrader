/**
 * Research Goal Runtime
 *
 * Tracks structured research with claims, evidence, budgets, and completion policy.
 * Inspired by Vibe-Trading's Research Goal layer.
 */

export interface Claim {
  id: string;
  statement: string;
  status: "hypothesis" | "supported" | "refuted" | "pending";
  evidenceIds: string[];
}

export interface Evidence {
  id: string;
  claimId: string;
  source: string;
  content: string;
  confidence: number; // 0-1
  toolUsed: string;
  timestamp: Date;
}

export interface GoalBudget {
  maxTurns: number;
  maxToolCalls: number;
  maxTokens: number;
  currentTurns: number;
  currentToolCalls: number;
  currentTokens: number;
}

export interface CompletionPolicy {
  requireAllClaimsResolved: boolean;
  minEvidencePerClaim: number;
  minConfidenceThreshold: number;
}

export type GoalPriority = "low" | "normal" | "high" | "urgent";

export interface ResearchGoal {
  id: string;
  sessionId: string;
  title: string;
  description: string;
  status: "active" | "completed" | "failed" | "paused";
  claims: Claim[];
  evidence: Evidence[];
  budget: GoalBudget;
  completionPolicy: CompletionPolicy;
  priority: GoalPriority;
  tokenBudgetRemaining: number;
  timeBudgetRemaining: number;
  selfScheduled: boolean;
  continuationPolicy: {
    autoContinue: boolean;
    maxAutoContinuations: number;
    autoContinuationsUsed: number;
  };
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

export interface GoalStep {
  id: string;
  goalId: string;
  title: string;
  description: string;
  order: number;
  status: "pending" | "in_progress" | "completed" | "blocked" | "failed";
  dependsOn: string[];
  assignableTools?: string[];
  budget: {
    maxTurns: number;
    currentTurns: number;
  };
  output?: string;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export class GoalManager {
  private goals: Map<string, ResearchGoal> = new Map();
  private steps: Map<string, Map<string, GoalStep>> = new Map();
  private counter = 0;
  private db?: import('../../state-db').StateDb;

  /**
   * @param db Optional StateDb instance for SQLite persistence.
   *           When omitted, all data stays in memory (backward compat).
   */
  constructor(db?: import('../../state-db').StateDb) {
    this.db = db;
  }

  createGoal(
    sessionId: string,
    title: string,
    description: string,
    budget?: Partial<GoalBudget>,
    policy?: Partial<CompletionPolicy>,
    options?: { priority?: GoalPriority; tokenBudget?: number; timeBudgetMs?: number; selfScheduled?: boolean },
  ): ResearchGoal {
    const id = `goal-${Date.now()}-${++this.counter}`;
    const goal: ResearchGoal = {
      id,
      sessionId,
      title,
      description,
      status: "active",
      claims: [],
      evidence: [],
      budget: {
        maxTurns: budget?.maxTurns ?? 20,
        maxToolCalls: budget?.maxToolCalls ?? 50,
        maxTokens: budget?.maxTokens ?? 100000,
        currentTurns: 0,
        currentToolCalls: 0,
        currentTokens: 0,
      },
      completionPolicy: {
        requireAllClaimsResolved: policy?.requireAllClaimsResolved ?? true,
        minEvidencePerClaim: policy?.minEvidencePerClaim ?? 2,
        minConfidenceThreshold: policy?.minConfidenceThreshold ?? 0.6,
      },
      priority: options?.priority ?? "normal",
      tokenBudgetRemaining: options?.tokenBudget ?? 100000,
      timeBudgetRemaining: options?.timeBudgetMs ?? 3600000,
      selfScheduled: options?.selfScheduled ?? false,
      continuationPolicy: {
        autoContinue: false,
        maxAutoContinuations: 3,
        autoContinuationsUsed: 0,
      },
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.goals.set(id, goal);
    this.#persistGoal(goal);
    return goal;
  }

  /** Persist a goal to StateDb if available */
  #persistGoal(goal: ResearchGoal): void {
    if (!this.db) return;
    try {
      this.db.saveGoal({
        id: goal.id,
        session_id: goal.sessionId,
        title: goal.title,
        description: goal.description,
        status: goal.status,
        claims: JSON.stringify(goal.claims),
        evidence: JSON.stringify(goal.evidence),
        budget: JSON.stringify(goal.budget),
        completion_policy: JSON.stringify(goal.completionPolicy),
        created_at: goal.createdAt.getTime(),
        updated_at: goal.updatedAt.getTime(),
        priority: goal.priority,
        token_budget_remaining: goal.tokenBudgetRemaining,
        time_budget_remaining: goal.timeBudgetRemaining,
        self_scheduled: goal.selfScheduled ? 1 : 0,
        continuation_policy: JSON.stringify(goal.continuationPolicy),
        metadata: JSON.stringify(goal.metadata),
      });
    } catch (err) {
      console.warn(`[GoalManager] Failed to persist goal ${goal.id}:`, err);
    }
  }

  /** Persist a step to StateDb if available */
  #persistStep(step: GoalStep): void {
    if (!this.db) return;
    try {
      this.db.saveGoalStep({
        id: step.id,
        goal_id: step.goalId,
        title: step.title,
        description: step.description,
        order: step.order,
        status: step.status,
        depends_on: JSON.stringify(step.dependsOn),
        assignable_tools: step.assignableTools ? JSON.stringify(step.assignableTools) : null,
        budget: JSON.stringify(step.budget),
        output: step.output ?? null,
        completed_at: step.completedAt ? step.completedAt.getTime() : null,
        created_at: step.createdAt.getTime(),
        updated_at: step.updatedAt.getTime(),
      });
    } catch (err) {
      console.error(`[GoalManager] Failed to persist step ${step.id}:`, err);
    }
  }

  addClaim(goalId: string, statement: string): Claim {
    const goal = this.goals.get(goalId);
    if (!goal) throw new Error(`Goal not found: ${goalId}`);
    const claim: Claim = {
      id: `claim-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      statement,
      status: "hypothesis",
      evidenceIds: [],
    };
    goal.claims.push(claim);
    goal.updatedAt = new Date();
    this.#persistGoal(goal);
    return claim;
  }

  addEvidence(
    goalId: string,
    claimId: string,
    evidence: Omit<Evidence, "id" | "timestamp">,
  ): Evidence {
    const goal = this.goals.get(goalId);
    if (!goal) throw new Error(`Goal not found: ${goalId}`);
    const claim = goal.claims.find(c => c.id === claimId);
    if (!claim) throw new Error(`Claim not found: ${claimId}`);

    const ev: Evidence = {
      ...evidence,
      id: `ev-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      timestamp: new Date(),
    };
    goal.evidence.push(ev);
    claim.evidenceIds.push(ev.id);
    goal.updatedAt = new Date();
    this.#persistGoal(goal);
    return ev;
  }

  updateGoalStatus(goalId: string, status: ResearchGoal["status"]): void {
    const goal = this.goals.get(goalId);
    if (!goal) throw new Error(`Goal not found: ${goalId}`);
    goal.status = status;
    goal.updatedAt = new Date();
    this.#persistGoal(goal);
  }

  getGoal(goalId: string): ResearchGoal | undefined {
    return this.goals.get(goalId);
  }

  listGoals(sessionId: string): ResearchGoal[] {
    return Array.from(this.goals.values()).filter(g => g.sessionId === sessionId);
  }

  listAllGoals(): ResearchGoal[] {
    return Array.from(this.goals.values());
  }

  checkCompletion(goalId: string): { complete: boolean; reasons: string[] } {
    const goal = this.goals.get(goalId);
    if (!goal) return { complete: false, reasons: ["Goal not found"] };

    const reasons: string[] = [];
    const policy = goal.completionPolicy;

    if (policy.requireAllClaimsResolved) {
      const unresolved = goal.claims.filter(c => c.status === "hypothesis" || c.status === "pending");
      if (unresolved.length > 0) {
        reasons.push(`${unresolved.length} claims unresolved`);
      }
    }

    for (const claim of goal.claims) {
      const claimEvidence = goal.evidence.filter(e => e.claimId === claim.id);
      if (claimEvidence.length < policy.minEvidencePerClaim) {
        reasons.push(`Claim "${claim.statement.slice(0, 50)}..." has ${claimEvidence.length}/${policy.minEvidencePerClaim} evidence`);
      }
      const avgConfidence = claimEvidence.length > 0
        ? claimEvidence.reduce((sum, e) => sum + e.confidence, 0) / claimEvidence.length
        : 0;
      if (avgConfidence < policy.minConfidenceThreshold) {
        reasons.push(`Claim "${claim.statement.slice(0, 50)}..." avg confidence ${avgConfidence.toFixed(2)} < ${policy.minConfidenceThreshold}`);
      }
    }

    return { complete: reasons.length === 0, reasons };
  }

  incrementBudget(goalId: string, field: "currentTurns" | "currentToolCalls" | "currentTokens", amount: number = 1): void {
    const goal = this.goals.get(goalId);
    if (!goal) throw new Error(`Goal not found: ${goalId}`);
    goal.budget[field] += amount;
    goal.updatedAt = new Date();
    this.#persistGoal(goal);
  }

  recordTurn(goalId: string, tokensUsed: number, toolCalls: number): void {
    const goal = this.goals.get(goalId);
    if (!goal || goal.status !== "active") return;
    goal.budget.currentTurns++;
    goal.budget.currentToolCalls += toolCalls;
    goal.budget.currentTokens += tokensUsed;
    goal.tokenBudgetRemaining -= tokensUsed;
    goal.updatedAt = new Date();
    if (
      goal.budget.currentTurns >= goal.budget.maxTurns ||
      goal.budget.currentToolCalls >= goal.budget.maxToolCalls ||
      goal.tokenBudgetRemaining <= 0
    ) {
      goal.status = "failed";
      goal.metadata.budgetExhausted = true;
    }
    this.#persistGoal(goal);
  }

  exportGoal(goalId: string): string {
    const goal = this.goals.get(goalId);
    if (!goal) throw new Error(`Goal not found: ${goalId}`);

    const lines: string[] = [
      `# ${goal.title}`,
      "",
      `**Status:** ${goal.status}`,
      `**Session:** ${goal.sessionId}`,
      `**Created:** ${goal.createdAt.toISOString()}`,
      `**Updated:** ${goal.updatedAt.toISOString()}`,
      "",
      goal.description,
      "",
      "## Claims",
      "",
    ];

    for (const claim of goal.claims) {
      const evidenceForClaim = goal.evidence.filter(e => e.claimId === claim.id);
      lines.push(`### [${claim.status}] ${claim.statement}`);
      lines.push("");
      if (evidenceForClaim.length > 0) {
        for (const ev of evidenceForClaim) {
          lines.push(`- **${ev.source}** (${ev.toolUsed}, confidence: ${(ev.confidence * 100).toFixed(0)}%): ${ev.content}`);
        }
      } else {
        lines.push("- No evidence yet.");
      }
      lines.push("");
    }

    lines.push("## Budget");
    lines.push(`- Turns: ${goal.budget.currentTurns}/${goal.budget.maxTurns}`);
    lines.push(`- Tool calls: ${goal.budget.currentToolCalls}/${goal.budget.maxToolCalls}`);
    lines.push(`- Tokens: ${goal.budget.currentTokens}/${goal.budget.maxTokens}`);

    return lines.join("\n");
  }

  deleteGoal(goalId: string): boolean {
    this.steps.delete(goalId);
    const removed = this.goals.delete(goalId);
    if (this.db) {
      try {
        this.db.deleteGoalSteps(goalId);
        this.db.deleteGoal(goalId);
      } catch (err) {
        console.warn(`[GoalManager] Failed to delete goal ${goalId} from DB:`, err);
      }
    }
    return removed;
  }

  // -------------------------------------------------------------------------
  // Step-Based Goals (added in Stream A)
  // -------------------------------------------------------------------------

  addStep(
    goalId: string,
    stepData: Omit<GoalStep, 'id' | 'goalId' | 'status' | 'budget' | 'dependsOn' | 'createdAt' | 'updatedAt'> & {
      budget?: Partial<GoalStep['budget']>;
      dependsOn?: string[];
    },
  ): GoalStep {
    const goal = this.goals.get(goalId);
    if (!goal) throw new Error(`Goal not found: ${goalId}`);
    if (!this.steps.has(goalId)) this.steps.set(goalId, new Map());
    const stepMap = this.steps.get(goalId)!;
    const stepId = `step-${Date.now()}-${++this.counter}`;
    const order = stepData.order ?? stepMap.size;
    const step: GoalStep = {
      id: stepId,
      goalId,
      title: stepData.title,
      description: stepData.description,
      order,
      status: "pending",
      dependsOn: stepData.dependsOn ?? [],
      assignableTools: stepData.assignableTools,
      budget: {
        maxTurns: stepData.budget?.maxTurns ?? 10,
        currentTurns: 0,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    stepMap.set(stepId, step);
    goal.updatedAt = new Date();
    this.#persistStep(step);
    this.#persistGoal(goal);
    return step;
  }

  updateStepStatus(goalId: string, stepId: string, status: GoalStep['status'], output?: string): void {
    const step = this.getStep(goalId, stepId);
    if (!step) throw new Error(`Step not found: ${goalId}/${stepId}`);
    step.status = status;
    step.updatedAt = new Date();
    if (status === "completed") {
      step.completedAt = new Date();
    }
    if (output !== undefined) {
      step.output = output;
    }
    this.#persistStep(step);
    const goal = this.goals.get(goalId);
    if (goal) {
      goal.updatedAt = new Date();
      this.#persistGoal(goal);
    }
  }

  getStep(goalId: string, stepId: string): GoalStep | undefined {
    return this.steps.get(goalId)?.get(stepId);
  }

  listSteps(goalId: string): GoalStep[] {
    const stepMap = this.steps.get(goalId);
    if (!stepMap) return [];
    return Array.from(stepMap.values()).sort((a, b) => a.order - b.order);
  }

  getNextSteps(goalId: string): GoalStep[] {
    const steps = this.listSteps(goalId);
    if (steps.length === 0) return [];

    const depMap = new Map<string, Set<string>>();
    for (const step of steps) {
      depMap.set(step.id, new Set(step.dependsOn));
    }

    return steps.filter((step) => {
      if (step.status !== "pending") return false;
      for (const depId of step.dependsOn) {
        const depStep = this.getStep(goalId, depId);
        if (!depStep || depStep.status !== "completed") return false;
      }
      return true;
    }).sort((a, b) => a.order - b.order);
  }

  getGoalProgress(goalId: string): {
    total: number;
    completed: number;
    blocked: number;
    failed: number;
    pending: number;
    inProgress: number;
    percentComplete: number;
  } {
    const steps = this.listSteps(goalId);
    const total = steps.length;
    if (total === 0) return { total: 0, completed: 0, blocked: 0, failed: 0, pending: 0, inProgress: 0, percentComplete: 100 };

    let completed = 0, blocked = 0, failed = 0, pending = 0, inProgress = 0;
    for (const step of steps) {
      if (step.status === "completed") completed++;
      else if (step.status === "blocked") blocked++;
      else if (step.status === "failed") failed++;
      else if (step.status === "in_progress") inProgress++;
      else pending++;
    }
    return {
      total, completed, blocked, failed, pending, inProgress,
      percentComplete: Math.round((completed / total) * 100),
    };
  }

  autoAdvance(goalId: string): { advanced: boolean; nextSteps: GoalStep[] } {
    const steps = this.listSteps(goalId);
    if (steps.length === 0) return { advanced: false, nextSteps: [] };

    const allDone = steps.every((s) => s.status === "completed" || s.status === "failed");
    if (allDone) {
      const goal = this.goals.get(goalId);
      if (goal) {
        goal.status = "completed";
        goal.updatedAt = new Date();
        this.#persistGoal(goal);
      }
      return { advanced: true, nextSteps: [] };
    }

    const ready = this.getNextSteps(goalId);
    if (ready.length === 0) return { advanced: false, nextSteps: [] };

    // Set the first ready step to in_progress
    const next = ready[0]!;
    this.updateStepStatus(goalId, next.id, "in_progress");
    const remainingReady = ready.slice(1);

    return { advanced: true, nextSteps: [next, ...remainingReady] };
  }

  // -------------------------------------------------------------------------
  // StateDb integration
  // -------------------------------------------------------------------------

  /**
   * Create a GoalManager, load all goals+steps from StateDb, and return it.
   */
  static fromDb(db: import('../../state-db').StateDb): GoalManager {
    const manager = new GoalManager(db);
    manager.loadFromDb();
    return manager;
  }

  /**
   * Clear in-memory Maps and reload all data from StateDb.
   */
  loadFromDb(): void {
    if (!this.db) return;
    this.goals.clear();
    this.steps.clear();
    this.counter = 0;

    try {
      const goals = this.db.listGoals();
      const allStepRows = this.db.listAllGoalSteps();

      // Group steps by goal_id in JS (single query instead of N)
      const stepsByGoal = new Map<string, import('../../state-db/types').GoalStepRow[]>();
      for (const sr of allStepRows) {
        const list = stepsByGoal.get(sr.goal_id) ?? [];
        list.push(sr);
        stepsByGoal.set(sr.goal_id, list);
      }

      for (const row of goals) {
        const goal = this.#rowToGoal(row);
        this.goals.set(goal.id, goal);

        const stepRows = stepsByGoal.get(goal.id);
        if (stepRows && stepRows.length > 0) {
          const stepMap = new Map<string, GoalStep>();
          for (const sr of stepRows) {
            const step = this.#rowToStep(sr);
            stepMap.set(step.id, step);
          }
          this.steps.set(goal.id, stepMap);
        }
      }
    } catch (err) {
      console.warn('[GoalManager] Failed to load from StateDb:', err);
    }
  }

  /** Convert a GoalRow from DB to a ResearchGoal */
  #rowToGoal(row: import('../../state-db/types').GoalRow): ResearchGoal {
    const claims: Claim[] = JSON.parse(row.claims || '[]');
    const evidence: Evidence[] = JSON.parse(row.evidence || '[]');
    const budget: GoalBudget = JSON.parse(row.budget || '{}');
    const completionPolicy: CompletionPolicy = JSON.parse(row.completion_policy || '{}');
    const continuationPolicy = JSON.parse(row.continuation_policy || '{}');

    return {
      id: row.id,
      sessionId: row.session_id,
      title: row.title,
      description: row.description,
      status: row.status,
      claims: claims.map((c) => ({ ...c, evidenceIds: c.evidenceIds ?? [] })),
      evidence: evidence.map((e) => ({ ...e, timestamp: new Date(e.timestamp) })),
      budget,
      completionPolicy,
      priority: (row.priority as GoalPriority) ?? "normal",
      tokenBudgetRemaining: row.token_budget_remaining ?? 100000,
      timeBudgetRemaining: row.time_budget_remaining ?? 3600000,
      selfScheduled: (row.self_scheduled ?? 0) === 1,
      continuationPolicy: {
        autoContinue: continuationPolicy.autoContinue ?? false,
        maxAutoContinuations: continuationPolicy.maxAutoContinuations ?? 3,
        autoContinuationsUsed: continuationPolicy.autoContinuationsUsed ?? 0,
      },
      metadata: JSON.parse(row.metadata || '{}'),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  /** Convert a GoalStepRow from DB to a GoalStep */
  #rowToStep(row: import('../../state-db/types').GoalStepRow): GoalStep {
    const dependsOn: string[] = JSON.parse(row.depends_on || '[]');
    const assignableTools: string[] | undefined = row.assignable_tools ? JSON.parse(row.assignable_tools) : undefined;
    const budget: { maxTurns: number; currentTurns: number } = JSON.parse(row.budget || '{}');

    return {
      id: row.id,
      goalId: row.goal_id,
      title: row.title,
      description: row.description,
      order: row.order,
      status: row.status,
      dependsOn,
      assignableTools,
      budget,
      output: row.output ?? undefined,
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  /**
   * @deprecated Use StateDb for persistence instead of JSON files.
   *             Kept for backward compatibility.
   */
  async persist(workspacePath: string): Promise<void> {
    const dir = (await import("node:path")).join(workspacePath, "goals");
    const filePath = (await import("node:path")).join(dir, "goals.json");
    const fs = await import("node:fs/promises");
    await fs.mkdir(dir, { recursive: true });

    const goals: Record<string, unknown> = {};
    for (const [id, goal] of this.goals) {
      goals[id] = JSON.parse(JSON.stringify(goal));
    }

    const steps: Record<string, Record<string, unknown>> = {};
    for (const [goalId, stepMap] of this.steps) {
      steps[goalId] = {};
      for (const [stepId, step] of stepMap) {
        steps[goalId]![stepId] = JSON.parse(JSON.stringify(step));
      }
    }

    await fs.writeFile(filePath, JSON.stringify({ goals, steps, counter: this.counter }, null, 2), "utf8");
  }

  /**
   * @deprecated Use StateDb for persistence instead of JSON files.
   *             Kept for backward compatibility.
   */
  async load(workspacePath: string): Promise<void> {
    const filePath = (await import("node:path")).join(workspacePath, "goals", "goals.json");
    const fs = await import("node:fs/promises");
    let data: string;
    try {
      data = await fs.readFile(filePath, "utf8");
    } catch {
      return;
    }
    const parsed = JSON.parse(data) as {
      goals: Record<string, ResearchGoal>;
      steps: Record<string, Record<string, GoalStep>>;
      counter: number;
    };

    for (const [id, goal] of Object.entries(parsed.goals ?? {})) {
      this.goals.set(id, {
        ...goal,
        createdAt: new Date(goal.createdAt),
        updatedAt: new Date(goal.updatedAt),
        claims: (goal.claims ?? []).map((c) => ({
          ...c,
          evidenceIds: c.evidenceIds ?? [],
        })),
        evidence: (goal.evidence ?? []).map((e) => ({
          ...e,
          timestamp: new Date(e.timestamp),
        })),
        budget: { ...goal.budget },
        completionPolicy: { ...goal.completionPolicy },
        priority: goal.priority ?? "normal",
        tokenBudgetRemaining: goal.tokenBudgetRemaining ?? 100000,
        timeBudgetRemaining: goal.timeBudgetRemaining ?? 3600000,
        selfScheduled: goal.selfScheduled ?? false,
        continuationPolicy: goal.continuationPolicy ?? {
          autoContinue: false,
          maxAutoContinuations: 3,
          autoContinuationsUsed: 0,
        },
        metadata: goal.metadata ?? {},
      });
    }

    for (const [goalId, stepMap] of Object.entries(parsed.steps ?? {})) {
      this.steps.set(goalId, new Map());
      for (const [stepId, step] of Object.entries(stepMap)) {
        this.steps.get(goalId)!.set(stepId, {
          ...step,
          createdAt: new Date(step.createdAt),
          updatedAt: new Date(step.updatedAt),
          completedAt: step.completedAt ? new Date(step.completedAt) : undefined,
        });
      }
    }

    this.counter = parsed.counter ?? 0;
  }
}
