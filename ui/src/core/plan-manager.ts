import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ToolUseContent, AgentEvent } from './types.js';

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';

export interface PlanStep {
  id: string;
  description: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  reasoning: string;
  status: PlanStepStatus;
  result?: string;
  error?: string;
  estimatedDuration?: number;
  dependencies?: string[];
}

export interface Plan {
  id: string;
  title: string;
  description: string;
  steps: PlanStep[];
  status: 'draft' | 'proposed' | 'approved' | 'executing' | 'completed' | 'failed' | 'cancelled';
  createdAt: Date;
  updatedAt?: Date;
  filePath?: string;
  estimatedTotalDuration?: number;
  confidenceScore?: number;
}

export interface PlanningRequest {
  userGoal: string;
  context: {
    workingDirectory: string;
    availableTools: string[];
    constraints?: string[];
    preferences?: Record<string, unknown>;
  };
}

export interface PlanManagerOptions {
  workingDirectory?: string;
  onEvent?: (event: AgentEvent) => void;
}

/** Owns the live, persisted planning-mode state. It never executes tools itself. */
export class PlanManager {
  private currentPlan: Plan | null = null;
  private planHistory: Plan[] = [];
  private planningMode = false;
  private readonly workingDirectory: string;
  private readonly onEvent?: (event: AgentEvent) => void;

  constructor(options?: PlanManagerOptions | ((event: AgentEvent) => void)) {
    this.workingDirectory =
      typeof options === 'object' && options.workingDirectory
        ? options.workingDirectory
        : process.cwd();
    this.onEvent = typeof options === 'function' ? options : options?.onEvent;
  }

  get plansDirectory(): string {
    return path.join(this.workingDirectory, '.dynamind', 'plans');
  }

  isPlanningMode(): boolean {
    return this.planningMode;
  }

  async enterPlanMode(goal?: string): Promise<Plan | null> {
    this.planningMode = true;
    if (!goal) return this.currentPlan;
    return this.createPlan(
      {
        userGoal: goal,
        context: { workingDirectory: this.workingDirectory, availableTools: [] },
      },
      []
    );
  }

  async exitPlanMode(): Promise<Plan | null> {
    if (this.currentPlan && this.currentPlan.status === 'draft') {
      this.currentPlan.status = 'proposed';
      await this.persist(this.currentPlan);
    }
    return this.currentPlan;
  }

  async createPlan(
    request: PlanningRequest,
    tools: Array<{ name: string; description: string }>
  ): Promise<Plan> {
    this.planningMode = true;
    const steps = this.designSteps(request, tools);
    const plan: Plan = {
      id: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      title: `Plan: ${request.userGoal.slice(0, 50)}${request.userGoal.length > 50 ? '...' : ''}`,
      description: request.userGoal,
      steps,
      status: 'proposed',
      createdAt: new Date(),
      updatedAt: new Date(),
      estimatedTotalDuration: steps.reduce((n, step) => n + (step.estimatedDuration ?? 10_000), 0),
      confidenceScore: Math.max(0.5, 0.9 - steps.length * 0.03),
    };
    this.currentPlan = plan;
    this.planHistory.push(plan);
    await this.persist(plan);
    this.emit({
      type: 'text',
      content: `Created plan with ${steps.length} steps\n${this.formatPlanForReview(plan)}`,
    });
    return plan;
  }

  getCurrentPlan(): Plan | null {
    return this.currentPlan;
  }

  async approvePlan(): Promise<boolean> {
    if (!this.currentPlan || !['draft', 'proposed'].includes(this.currentPlan.status)) return false;
    this.currentPlan.status = 'approved';
    this.currentPlan.updatedAt = new Date();
    this.planningMode = false;
    await this.persist(this.currentPlan);
    return true;
  }

  async rejectPlan(reason?: string): Promise<boolean> {
    if (!this.currentPlan) return false;
    this.currentPlan.status = 'draft';
    this.currentPlan.updatedAt = new Date();
    this.planningMode = true;
    await this.persist(this.currentPlan);
    this.emit({ type: 'text', content: `Plan needs revision${reason ? `: ${reason}` : '.'}` });
    return true;
  }

  async cancelPlan(reason?: string): Promise<void> {
    if (!this.currentPlan) return;
    const plan = this.currentPlan;
    plan.status = 'cancelled';
    this.currentPlan = null;
    this.planningMode = false;
    this.emit({ type: 'plan_interrupted', reason: reason ? 'user_cancel' : 'esc_pressed' });
    await this.persist(plan);
  }

  async *executePlan(): AsyncGenerator<PlanStep, void, unknown> {
    if (!this.currentPlan || this.currentPlan.status !== 'approved')
      throw new Error('No approved plan to execute');
    this.currentPlan.status = 'executing';
    await this.persist(this.currentPlan);
    for (const step of this.currentPlan.steps) {
      if (step.status === 'skipped') continue;
      const completed = this.currentPlan.steps
        .filter((s) => s.status === 'completed')
        .map((s) => s.id);
      if (step.dependencies?.some((id) => !completed.includes(id))) {
        step.status = 'skipped';
        continue;
      }
      await this.updateStep(step.id, 'in_progress');
      yield step;
      if (step.status === 'failed' && /critical|essential|required|must/i.test(step.description)) {
        this.currentPlan.status = 'failed';
        break;
      }
    }
    if (this.currentPlan.steps.every((s) => s.status === 'completed' || s.status === 'skipped')) {
      this.currentPlan.status = 'completed';
    }
    await this.persist(this.currentPlan);
  }

  completeStep(id: string, result: string): void {
    void this.updateStep(id, 'completed', result);
  }
  failStep(id: string, error: string): void {
    void this.updateStep(id, 'failed', undefined, error);
  }

  async updateStep(
    id: string,
    status: PlanStepStatus,
    result?: string,
    error?: string
  ): Promise<void> {
    const step = this.currentPlan?.steps.find((item) => item.id === id);
    if (!step || !this.currentPlan) return;
    Object.assign(
      step,
      { status },
      result === undefined ? {} : { result },
      error === undefined ? {} : { error }
    );
    this.currentPlan.updatedAt = new Date();
    await this.persist(this.currentPlan);
  }

  getPlanHistory(): Plan[] {
    return [...this.planHistory];
  }
  planToToolUses(): ToolUseContent[] {
    return (this.currentPlan?.steps ?? [])
      .filter((s) => s.toolName && s.status === 'pending')
      .map((s) => ({
        type: 'tool_use',
        id: `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: s.toolName!,
        input: s.toolInput ?? {},
      }));
  }

  async load(fileOrSlug: string): Promise<Plan> {
    const file = path.isAbsolute(fileOrSlug)
      ? fileOrSlug
      : path.join(
          this.plansDirectory,
          fileOrSlug.endsWith('.md') ? fileOrSlug : `${fileOrSlug}.md`
        );
    const raw = await readFile(file, 'utf8');
    const match = raw.match(/<!-- dynamind-plan\n([\s\S]*?)\n-->/);
    if (!match) throw new Error(`Invalid plan file: ${file}`);
    const plan = JSON.parse(match[1]) as Plan;
    plan.createdAt = new Date(plan.createdAt);
    plan.updatedAt = plan.updatedAt ? new Date(plan.updatedAt) : undefined;
    plan.filePath = file;
    this.currentPlan = plan;
    this.planHistory.push(plan);
    return plan;
  }

  async listPersistedPlans(): Promise<string[]> {
    try {
      return (await readdir(this.plansDirectory)).filter((file) => file.endsWith('.md')).sort();
    } catch {
      return [];
    }
  }

  formatPlanForReview(plan: Plan): string {
    return [
      plan.title,
      plan.description,
      '',
      ...plan.steps.map((s, i) => `${i + 1}. [${s.status}] ${s.description}\n   ${s.reasoning}`),
    ].join('\n');
  }

  private designSteps(
    request: PlanningRequest,
    tools: Array<{ name: string; description: string }>
  ): PlanStep[] {
    const goal = request.userGoal.toLowerCase();
    const descriptions = ['Explore the relevant codebase and constraints'];
    if (/implement|build|create|edit|fix|change/.test(goal))
      descriptions.push('Implement the proposed changes');
    if (/test|implement|build|fix|change/.test(goal))
      descriptions.push('Run focused validation and review the result');
    if (descriptions.length === 1)
      descriptions.push('Synthesize findings and recommended approach');
    return descriptions.map((description, index) => ({
      id: `step_${Date.now()}_${index + 1}`,
      description,
      reasoning:
        index === 0
          ? 'Planning begins with read-only discovery.'
          : 'This advances the requested outcome while keeping work reviewable.',
      status: 'pending',
      estimatedDuration: 10_000,
      toolName:
        index === 0 ? tools.find((t) => /glob|read|grep|search/.test(t.name))?.name : undefined,
    }));
  }

  private async persist(plan: Plan): Promise<void> {
    await mkdir(this.plansDirectory, { recursive: true });
    const slug = this.slug(plan.description) || plan.id;
    const file = plan.filePath ?? path.join(this.plansDirectory, `${slug}.md`);
    plan.filePath = file;
    const metadata = JSON.stringify({ ...plan, filePath: file }, null, 2);
    const body = `# ${plan.title}\n\n${plan.description}\n\n## Steps\n\n${plan.steps.map((s, i) => `${i + 1}. **${s.description}** (${s.status})\n   ${s.reasoning}`).join('\n\n')}\n\n<!-- dynamind-plan\n${metadata}\n-->\n`;
    await writeFile(file, body, 'utf8');
  }

  private slug(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 64);
  }
  private emit(event: AgentEvent): void {
    this.onEvent?.(event);
  }
}
