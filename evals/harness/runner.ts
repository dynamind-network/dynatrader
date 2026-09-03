/**
 * DynaMind Eval Suite — Scenario Runner
 *
 * Orchestrates running scenarios through an agent, collecting trajectories,
 * and producing EvalTraces.
 */

import type {
  EvalScenario,
  EvalTrace,
  TrajectoryStep,
  EvalScores,
} from './types';
import { getEvaluator, getHardFailureChecker } from './evaluators';

// ---------------------------------------------------------------------------
// Agent Runner Interface
// ---------------------------------------------------------------------------

/**
 * The agent runner is injected. The harness doesn't know how the agent works —
 * it just receives a trajectory back.
 */
export interface AgentRunner {
  /** Run a single scenario and return the trajectory + decision */
  run(scenario: EvalScenario): Promise<{
    trajectory: TrajectoryStep[];
    decision: string;
    cost_usd: number;
    tokens_in: number;
    tokens_out: number;
    model: string;
  }>;
}

// ---------------------------------------------------------------------------
// Runner Config
// ---------------------------------------------------------------------------

export interface RunnerConfig {
  /** Max concurrent scenario runs (default: 2) */
  concurrency?: number;
  /** Agent name for traces */
  agent_name?: string;
}

// ---------------------------------------------------------------------------
// EvalRunner
// ---------------------------------------------------------------------------

export class EvalRunner {
  private config: Required<RunnerConfig>;

  constructor(config?: RunnerConfig) {
    this.config = {
      concurrency: config?.concurrency ?? 2,
      agent_name: config?.agent_name ?? 'dynamind',
    };
  }

  /**
   * Run a single scenario and produce an EvalTrace.
   */
  async runScenario(
    scenario: EvalScenario,
    agent: AgentRunner,
  ): Promise<EvalTrace> {
    const startMs = Date.now();

    try {
      const result = await agent.run(scenario);
      const elapsedMs = Date.now() - startMs;

      // Build trace so we can pass it to evaluators
      const trace: EvalTrace = {
        task_id: scenario.id,
        family: scenario.family,
        agent: this.config.agent_name,
        model: result.model,
        timestamp: new Date().toISOString(),
        trajectory: result.trajectory,
        decision: result.decision,
        scores: { task_success: 0, family_specific: {} },
        cost_usd: result.cost_usd,
        latency_ms: elapsedMs,
        tokens_in: result.tokens_in,
        tokens_out: result.tokens_out,
        tool_calls: result.trajectory.filter(s => s.action === 'tool_call').length,
        passed: false,
        hard_failures: [],
      };

      // Run deterministic evaluators — family evaluator is the authority
      const familyEvaluator = getEvaluator(scenario.family);
      const familyScores = familyEvaluator
        ? familyEvaluator(result.trajectory, scenario, trace)
        : {};

      // Run hard failure checker
      const hardFailureChecker = getHardFailureChecker(scenario.family);
      const hardFailures = hardFailureChecker
        ? hardFailureChecker(result.trajectory, scenario)
        : [];

      // Add any hard failures from the scenario definition
      if (scenario.hard_failures) {
        hardFailures.push(...scenario.hard_failures);
      }

      // Run expected checks (lightweight — only exact match checks)
      const expectedScores = this.checkExpected(result.trajectory, result.decision, scenario);

      // Compose scores — family evaluator is the authority on task_success
      const scores: EvalScores = {
        task_success: familyScores.task_success ?? expectedScores.task_success ?? 0,
        family_specific: { ...expectedScores, ...familyScores },
      };

      // Check pass thresholds
      const passed = this.checkPassThresholds(scores, hardFailures, scenario);

      trace.scores = scores;
      trace.passed = passed;
      trace.hard_failures = [...new Set(hardFailures)];

      return trace;
    } catch (err) {
      const elapsedMs = Date.now() - startMs;
      return {
        task_id: scenario.id,
        family: scenario.family,
        agent: this.config.agent_name,
        model: 'unknown',
        timestamp: new Date().toISOString(),
        trajectory: [],
        decision: `ERROR: ${(err as Error).message}`,
        scores: {
          task_success: 0,
          family_specific: {},
        },
        cost_usd: 0,
        latency_ms: elapsedMs,
        tokens_in: 0,
        tokens_out: 0,
        tool_calls: 0,
        passed: false,
        hard_failures: ['AGENT_ERROR'],
      };
    }
  }

  /**
   * Run a full eval suite (list of scenarios).
   */
  async runSuite(
    scenarios: EvalScenario[],
    agent: AgentRunner,
    onProgress?: (completed: number, total: number, trace: EvalTrace) => void,
  ): Promise<EvalTrace[]> {
    const results: EvalTrace[] = [];
    const queue = [...scenarios];
    const running: Promise<void>[] = [];

    const runNext = async (): Promise<void> => {
      while (queue.length > 0) {
        const scenario = queue.shift()!;
        const trace = await this.runScenario(scenario, agent);
        results.push(trace);
        onProgress?.(results.length, scenarios.length, trace);
      }
    };

    // Start workers
    for (let i = 0; i < this.config.concurrency; i++) {
      running.push(runNext());
    }

    await Promise.all(running);
    return results.sort((a, b) => a.task_id.localeCompare(b.task_id));
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * Check expected outputs from the scenario definition.
   * This only handles lightweight keyword matching checks.
   * The family evaluator is the authority on composite scores.
   */
  private checkExpected(
    trajectory: TrajectoryStep[],
    decision: string,
    scenario: EvalScenario,
  ): Record<string, number> {
    const scores: Record<string, number> = {};
    const expected = scenario.expected;

    // Check decision — produce binary score only as fallback
    if (expected.decision) {
      const validDecisions = Array.isArray(expected.decision) ? expected.decision : [expected.decision];
      const normalised = decision.toUpperCase().trim();
      scores.task_success = validDecisions.some(d => normalised.includes(d.toUpperCase())) ? 1 : 0;
    }

    // Check regime — only as lightweight check, family evaluator handles full scoring
    if (expected.regime) {
      const validRegimes = Array.isArray(expected.regime) ? expected.regime : [expected.regime];
      const normalised = decision.toLowerCase().trim();
      scores.regime_accuracy = validRegimes.some(r => normalised.includes(r.toLowerCase())) ? 1 : 0;
    }

    // Check tool selection — only as fallback, family evaluator handles full scoring
    if (expected.tools_required || expected.tools_forbidden) {
      const calledTools = trajectory
        .filter(s => s.action === 'tool_call' && s.tool)
        .map(s => s.tool!);
      const calledSet = new Set(calledTools);

      if (expected.tools_required) {
        const hit = expected.tools_required.filter(t => calledSet.has(t)).length;
        scores.tool_selection = hit / expected.tools_required.length;
      }

      if (expected.tools_forbidden) {
        const violated = expected.tools_forbidden.filter(t => calledSet.has(t)).length;
        scores.forbidden_violations = violated > 0 ? 0 : 1;
      }
    }

    // Custom scorer
    if (expected.custom_scorer) {
      const customScores = expected.custom_scorer(
        {
          task_id: scenario.id,
          family: scenario.family,
          agent: '',
          model: '',
          timestamp: '',
          trajectory,
          decision,
          scores: { task_success: 0, family_specific: {} },
          cost_usd: 0,
          latency_ms: 0,
          tokens_in: 0,
          tokens_out: 0,
          tool_calls: 0,
          passed: false,
          hard_failures: [],
        },
        scenario,
      );
      Object.assign(scores, customScores);
    }

    return scores;
  }

  private checkPassThresholds(
    scores: EvalScores,
    hardFailures: string[],
    scenario: EvalScenario,
  ): boolean {
    // Hard failures = instant fail
    if (hardFailures.length > 0) return false;

    // Check pass thresholds
    const thresholds = scenario.expected.pass_thresholds;
    if (thresholds) {
      const allScores = {
        task_success: scores.task_success,
        ...scores.family_specific,
      };

      for (const [key, minScore] of Object.entries(thresholds)) {
        const actual = allScores[key] ?? 0;
        if (actual < minScore) return false;
      }
    }

    // Default: task_success >= 0.5
    return scores.task_success >= 0.5;
  }
}
