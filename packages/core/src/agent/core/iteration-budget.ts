/**
 * Iteration Budget Management
 *
 * Controls agent iteration resources and prevents infinite loops
 */

export interface BudgetAdjustment {
  iterations: number;
  reason: string;
}

const ADAPTIVE_MIN_ITERATIONS = 1;
const ADAPTIVE_MAX_ITERATIONS = 50;
const ADAPTIVE_BASE_ITERATIONS = 5;

export interface BudgetConfig {
  maxIterations: number;
  maxTimeMs: number;
  maxMemoryUsage: number; // in bytes
  maxApiCalls: number;
  warningThreshold: number; // fraction of budget used
  /** Inactivity timeout: if no iteration starts within this many ms, consider stalled (0 = disabled) */
  inactivityTimeoutMs: number;
}

export interface BudgetState {
  iterations: number;
  timeUsed: number;
  memoryUsed: number;
  apiCalls: number;
  startTime: number;
  lastIterationTime: number;
  warnings: string[];
}

export class IterationBudget {
  private config: BudgetConfig;
  private state: BudgetState;
  private lastAdjustmentReason: string = "No adjustment made";

  constructor(config: BudgetConfig) {
    this.config = config;
    const now = Date.now();
    this.state = {
      iterations: 0,
      timeUsed: 0,
      memoryUsed: 0,
      apiCalls: 0,
      startTime: now,
      lastIterationTime: now,
      warnings: [],
    };
  }

  /**
   * Check if we can start an iteration
   */
  canStartIteration(): boolean {
    return !this.isExhausted();
  }

  /**
   * Start an iteration
   */
  startIteration(): void {
    if (!this.canStartIteration()) {
      throw new Error("Iteration budget exhausted");
    }

    this.checkWarnings();
    this.state.iterations++;
    this.state.lastIterationTime = Date.now();
    this.checkBudget("iteration", this.state.iterations, this.config.maxIterations);
  }

  /**
   * Record a single API call (used by tool loop inside iterations)
   */
  recordApiCall(): void {
    this.state.apiCalls++;
    this.checkBudget("api_calls", this.state.apiCalls, this.config.maxApiCalls);
  }

  /**
   * Complete an iteration
   */
  completeIteration(apiCalls: number = 0): void {
    this.state.apiCalls += apiCalls;
    this.checkBudget("api_calls", this.state.apiCalls, this.config.maxApiCalls);
  }

  /**
   * Check if budget is exhausted
   */
  isExhausted(): boolean {
    // Hard limits
    if (this.config.maxIterations > 0 && this.state.iterations >= this.config.maxIterations) return true;
    if (this.config.maxMemoryUsage > 0 && this.getMemoryUsed() >= this.config.maxMemoryUsage) return true;
    if (this.config.maxApiCalls > 0 && this.state.apiCalls >= this.config.maxApiCalls) return true;

    // Wall-clock time limit (safety net)
    if (this.config.maxTimeMs > 0 && this.getTimeUsed() >= this.config.maxTimeMs) return true;

    // Inactivity timeout: if no iteration started recently, agent is stalled
    if (this.config.inactivityTimeoutMs > 0) {
      const idleMs = Date.now() - this.state.lastIterationTime;
      if (idleMs >= this.config.inactivityTimeoutMs) return true;
    }

    return false;
  }

  /**
   * Get remaining budget
   */
  getRemaining(): {
    iterations: number;
    timeMs: number;
    memoryBytes: number;
    apiCalls: number;
  } {
    return {
      iterations: Math.max(0, this.config.maxIterations - this.state.iterations),
      timeMs: Math.max(0, this.config.maxTimeMs - this.getTimeUsed()),
      memoryBytes: Math.max(0, this.config.maxMemoryUsage - this.getMemoryUsed()),
      apiCalls: Math.max(0, this.config.maxApiCalls - this.state.apiCalls),
    };
  }

  /**
   * Get usage statistics
   */
  getUsage(): {
    iterations: number;
    timeUsed: number;
    timeRemaining: number;
    memoryUsed: number;
    memoryRemaining: number;
    apiCalls: number;
    apiRemaining: number;
    usagePercent: number;
    exhausted: boolean;
    idleMs: number;
  } {
    const totalTime = this.config.maxTimeMs;
    const totalMemory = this.config.maxMemoryUsage;
    const totalApi = this.config.maxApiCalls;

    return {
      iterations: this.state.iterations,
      timeUsed: this.getTimeUsed(),
      timeRemaining: Math.max(0, totalTime - this.getTimeUsed()),
      memoryUsed: this.getMemoryUsed(),
      memoryRemaining: Math.max(0, totalMemory - this.getMemoryUsed()),
      apiCalls: this.state.apiCalls,
      apiRemaining: Math.max(0, totalApi - this.state.apiCalls),
      usagePercent: this.getUsagePercent(),
      exhausted: this.isExhausted(),
      idleMs: Date.now() - this.state.lastIterationTime,
    };
  }

  /**
   * Get time used
   */
  private getTimeUsed(): number {
    return Date.now() - this.state.startTime;
  }

  /**
   * Get memory used (approximation)
   */
  private getMemoryUsed(): number {
    // In a real implementation, this would use process.memoryUsage()
    // For now, estimate based on iterations and API calls
    const perIteration = 1024 * 1024; // 1MB per iteration
    const perApiCall = 100 * 1024; // 100KB per API call

    return (this.state.iterations * perIteration) + (this.state.apiCalls * perApiCall);
  }

  /**
   * Check budget limits and warn if approaching
   */
  private checkBudget(type: string, used: number, max: number): void {
    if (max <= 0) return;
    if (used > max) {
      throw new Error(`Budget exhausted: ${type} limit of ${max} reached`);
    }

    const remaining = max - used;
    const threshold = max * this.config.warningThreshold;

    if (remaining <= threshold) {
      const warning = `${type} budget warning: ${used}/${max} used (${Math.round((used / max) * 100)}%)`;
      this.state.warnings.push(warning);
    }
  }

  /**
   * Check for warnings
   */
  private checkWarnings(): void {
    if (this.state.warnings.length > 0) {
      console.warn(`Iteration budget warnings:`, this.state.warnings);
    }
  }

  /**
   * Get usage percentage
   */
  private getUsagePercent(): number {
    const ratios = [
      this.config.maxTimeMs > 0 ? this.getTimeUsed() / this.config.maxTimeMs : 0,
      this.config.maxMemoryUsage > 0 ? this.getMemoryUsed() / this.config.maxMemoryUsage : 0,
      this.config.maxIterations > 0 ? this.state.iterations / this.config.maxIterations : 0,
      this.config.maxApiCalls > 0 ? this.state.apiCalls / this.config.maxApiCalls : 0,
    ];
    return Math.max(...ratios) * 100;
  }

  /**
   * Reset budget state
   */
  reset(): void {
    const now = Date.now();
    this.state = {
      iterations: 0,
      timeUsed: 0,
      memoryUsed: 0,
      apiCalls: 0,
      startTime: now,
      lastIterationTime: now,
      warnings: [],
    };
  }

  /**
   * Dynamically compute an iteration cap based on task complexity.
   * Analyzes text length, word count, and tool/API references.
   */
  adjustBudget(task: string, toolCount?: number): BudgetAdjustment {
    let complexity = 0;
    const parts: string[] = [];

    // Task length scoring
    if (task.length > 5000) { complexity += 8; parts.push("length>5000(+8)"); }
    else if (task.length > 2000) { complexity += 5; parts.push("length>2000(+5)"); }
    else if (task.length > 1000) { complexity += 3; parts.push("length>1000(+3)"); }
    else if (task.length > 500) { complexity += 2; parts.push("length>500(+2)"); }
    else if (task.length > 100) { complexity += 1; parts.push("length>100(+1)"); }

    // Word count scoring
    const wordCount = task.split(/\s+/).filter(Boolean).length;
    if (wordCount > 500) { complexity += 5; parts.push(`words>500(+5)`); }
    else if (wordCount > 200) { complexity += 3; parts.push(`words>200(+3)`); }
    else if (wordCount > 100) { complexity += 1; parts.push(`words>100(+1)`); }

    // Tool/API reference scoring
    const toolRefPattern = /\b(tool|function|api|get|post|fetch)\b/gi;
    const toolRefs = (task.match(toolRefPattern) || []).length;
    if (toolRefs > 10) { complexity += 5; parts.push(`toolRefs>10(+5)`); }
    else if (toolRefs > 5) { complexity += 3; parts.push(`toolRefs>5(+3)`); }
    else if (toolRefs > 2) { complexity += 1; parts.push(`toolRefs>2(+1)`); }

    // Optional toolCount parameter
    if (toolCount !== undefined && toolCount > 0) {
      complexity += toolCount;
      parts.push(`toolCount(${toolCount})`);
    }

    const iterations = Math.min(
      ADAPTIVE_MAX_ITERATIONS,
      Math.max(ADAPTIVE_MIN_ITERATIONS, ADAPTIVE_BASE_ITERATIONS + complexity),
    );

    const detail = parts.length > 0 ? ` (${parts.join(", ")})` : " (simple task)";
    const reason = `Adaptive budget: ${iterations} iterations${detail}`;

    return { iterations, reason };
  }

  /**
   * Apply a budget adjustment, updating maxIterations in config.
   */
  updateBudget(adjustment: BudgetAdjustment): void {
    const previousMax = this.config.maxIterations;
    this.config.maxIterations = Math.min(adjustment.iterations, ADAPTIVE_MAX_ITERATIONS);
    this.lastAdjustmentReason = adjustment.reason;
    console.debug(
      `[IterationBudget] ${adjustment.reason} (was ${previousMax}, now ${this.config.maxIterations})`,
    );
  }

  /**
   * Get the reason string from the last budget adjustment.
   */
  getBudgetAdjustmentReason(): string {
    return this.lastAdjustmentReason;
  }

  /**
   * Create budget with sensible defaults
   */
  static createDefault(): IterationBudget {
    return new IterationBudget({
      maxIterations: 0,
      maxTimeMs: 0,
      maxMemoryUsage: 0,
      maxApiCalls: 0,
      warningThreshold: 0.8, // 80%
      inactivityTimeoutMs: 0,
    });
  }

  /**
   * Create budget for testing
   */
  static createTesting(): IterationBudget {
    return new IterationBudget({
      maxIterations: 3,
      maxTimeMs: 30_000, // 30 seconds
      maxMemoryUsage: 10 * 1024 * 1024, // 10MB
      maxApiCalls: 10,
      warningThreshold: 0.5,
      inactivityTimeoutMs: 10_000, // 10s inactivity
    });
  }
}
