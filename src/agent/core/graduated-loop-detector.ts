import type { ToolCall, ToolResult } from "@dyna/contracts";
import { createHash } from "node:crypto";

/**
 * Graduated loop detection — Atomic Agent pattern.
 *
 * Three-tier escalation per tool call:
 * - `warn`: inject a notice into the next step's prompt
 * - `critical`: veto the call, return synthetic result with instruction
 * - `breaker`: force a graceful reply to end the turn
 *
 * Also detects composite batch loops (same batch of calls repeated)
 * and wandering loops (same tool, different args, same outcome).
 */

export type LoopSignalLevel = "ok" | "warn" | "critical" | "breaker";

export interface GraduatedLoopConfig {
  /** Consecutive identical calls before warn. Default: 3 */
  warnThreshold?: number;
  /** Consecutive identical calls before critical (veto). Default: 5 */
  criticalThreshold?: number;
  /** Consecutive vetoes before breaker (force reply). Default: 3 */
  breakerVetoStreak?: number;
  /** History window size for composite/wandering detection. Default: 20 */
  historySize?: number;
  /** Distinct-args repetitions before wandering warn. Default: 4 */
  wanderingThreshold?: number;
  /** Distinct-args repetitions before wandering escalation. Default: 6 */
  wanderingEscalation?: number;
  /** Max assistant outputs to track for repeated-text detection. Default: 20 */
  outputWindowSize?: number;
}

export interface LoopVerdict {
  level: LoopSignalLevel;
  count: number;
  detector: "generic_repeat" | "wandering" | "composite_batch";
  /** Stable key for deduplicating warning injection per step. */
  warningKey: string;
}

export interface BatchLoopSignal {
  level: "warn" | "critical" | "breaker";
  tool: string;
  count: number;
  detector: LoopVerdict["detector"];
  warningKey: string;
}

interface ToolHistoryEntry {
  tool: string;
  argsHash: string;
  resultHash: string;
  timestamp: number;
}

export class GraduatedLoopDetector {
  private readonly warnThreshold: number;
  private readonly criticalThreshold: number;
  private readonly breakerVetoStreak: number;
  private readonly historySize: number;
  private readonly wanderingThreshold: number;
  private readonly wanderingEscalation: number;

  private history: ToolHistoryEntry[] = [];
  private consecutiveStreak = new Map<string, number>();
  private vetoStreak = 0;
  private breakerTripped = false;
  private emittedWarnings = new Set<string>();

  private outputSignatures: string[] = [];
  private outputWindowSize: number;
  private lastOutputHash: string | null = null;
  private outputStreakCount = 0;

  constructor(config?: GraduatedLoopConfig) {
    this.warnThreshold = config?.warnThreshold ?? 3;
    this.criticalThreshold = config?.criticalThreshold ?? 5;
    this.breakerVetoStreak = config?.breakerVetoStreak ?? 3;
    this.historySize = config?.historySize ?? 20;
    this.wanderingThreshold = config?.wanderingThreshold ?? 4;
    this.wanderingEscalation = config?.wanderingEscalation ?? 6;
    this.outputWindowSize = config?.outputWindowSize ?? 20;
  }

  /**
   * Check a single tool call before execution. Returns a verdict
   * indicating whether the call should proceed.
   */
  check(tool: string, args: Record<string, unknown>): LoopVerdict {
    const argsHash = this.hashArgs(args);
    const key = `${tool}:${argsHash}`;

    // Check breaker
    if (this.breakerTripped) {
      return {
        level: "breaker",
        count: this.criticalThreshold,
        detector: "generic_repeat",
        warningKey: key,
      };
    }

    // Check generic repeat
    const streak = this.consecutiveStreak.get(key) ?? 0;
    if (streak >= this.criticalThreshold) {
      return {
        level: "critical",
        count: streak,
        detector: "generic_repeat",
        warningKey: key,
      };
    }
    if (streak >= this.warnThreshold) {
      return {
        level: "warn",
        count: streak,
        detector: "generic_repeat",
        warningKey: key,
      };
    }

    // Check wandering (same tool, different args, same outcome)
    const wandering = this.checkWandering(tool);
    if (wandering.level !== "ok") {
      return wandering;
    }

    return { level: "ok", count: 0, detector: "generic_repeat", warningKey: key };
  }

  /**
   * Record a tool call and its outcome after execution.
   */
  recordCall(tool: string, args: Record<string, unknown>): void {
    const argsHash = this.hashArgs(args);
    const key = `${tool}:${argsHash}`;
    const prev = this.consecutiveStreak.get(key) ?? 0;
    this.consecutiveStreak.set(key, prev + 1);
  }

  recordOutcome(tool: string, args: Record<string, unknown>, result: ToolResult): void {
    const argsHash = this.hashArgs(args);
    const resultHash = this.hashResult(result);
    this.history.push({ tool, argsHash, resultHash, timestamp: Date.now() });
    if (this.history.length > this.historySize) {
      this.history = this.history.slice(-this.historySize);
    }
  }

  /**
   * Record a veto (critical-level check that blocked execution).
   */
  recordVeto(): void {
    this.vetoStreak++;
    if (this.vetoStreak >= this.breakerVetoStreak) {
      this.breakerTripped = true;
    }
  }

  /**
   * Check composite batch (same set of calls repeated).
   */
  observeBatchComposite(
    calls: Array<{ tool: string; args: Record<string, unknown> }>,
    results: ToolResult[],
  ): { level: LoopSignalLevel; tool: string; count: number; detector: LoopVerdict["detector"]; warningKey: string } {
    const batchHash = calls
      .map((c) => `${c.tool}:${this.hashArgs(c.args)}`)
      .sort()
      .join("|");
    const key = `batch:${batchHash}`;
    const streak = this.consecutiveStreak.get(key) ?? 0;
    this.consecutiveStreak.set(key, streak + 1);

    if (streak + 1 >= this.criticalThreshold) {
      return { level: "critical", tool: calls[0]?.tool ?? "batch", count: streak + 1, detector: "composite_batch", warningKey: key };
    }
    if (streak + 1 >= this.warnThreshold) {
      return { level: "warn", tool: calls[0]?.tool ?? "batch", count: streak + 1, detector: "composite_batch", warningKey: key };
    }
    return { level: "ok", tool: calls[0]?.tool ?? "batch", count: 0, detector: "composite_batch", warningKey: key };
  }

  /**
   * Check if a warning should be emitted (deduplicated per key per step).
   */
  shouldEmitWarning(warningKey: string, count: number): boolean {
    const dedupKey = `${warningKey}:${count}`;
    if (this.emittedWarnings.has(dedupKey)) return false;
    this.emittedWarnings.add(dedupKey);
    return true;
  }

  /**
   * Whether the breaker has been tripped (force graceful reply).
   */
  isBreakerTripped(): boolean {
    return this.breakerTripped;
  }

  /**
   * Reset per-step state (called at step boundaries).
   */
  resetForStep(): void {
    this.emittedWarnings.clear();
  }

  /**
   * Full reset (called on new user message).
   */
  reset(): void {
    this.history = [];
    this.consecutiveStreak.clear();
    this.vetoStreak = 0;
    this.breakerTripped = false;
    this.emittedWarnings.clear();
    this.outputSignatures = [];
    this.lastOutputHash = null;
    this.outputStreakCount = 0;
  }

  /**
   * Record an assistant output and detect repeated text loops.
   * Returns the severity level of the output loop.
   */
  recordOutput(output: string): "ok" | "warning" | "critical" | "halt" {
    const normalized = output.trim().replace(/\s+/g, " ");
    if (!normalized) {
      this.lastOutputHash = null;
      this.outputStreakCount = 0;
      return "ok";
    }

    const hash = createHash("sha256").update(normalized).digest("hex");
    this.outputSignatures.push(hash);
    if (this.outputSignatures.length > this.outputWindowSize) {
      this.outputSignatures = this.outputSignatures.slice(-this.outputWindowSize);
    }

    if (this.lastOutputHash === hash) {
      this.outputStreakCount += 1;
    } else {
      this.lastOutputHash = hash;
      this.outputStreakCount = 1;
    }

    if (this.outputStreakCount >= 30) return "halt";
    if (this.outputStreakCount >= 20) return "critical";
    if (this.outputStreakCount >= 10) return "warning";
    return "ok";
  }

  /**
   * Guidance to inject into the next prompt when repeated output has been seen.
   */
  getOutputLoopGuidance(): string {
    if (this.outputStreakCount < 10) return "";

    const level =
      this.outputStreakCount >= 30 ? "CIRCUIT BREAKER"
        : this.outputStreakCount >= 20 ? "CRITICAL"
          : "WARNING";

    return [
      `Loop guard ${level}: the last assistant output repeated ${this.outputStreakCount} times.`,
      `If this pattern recurs, stop, summarize the blocker, and change direction.`,
    ].join("\n");
  }

  private checkWandering(tool: string): LoopVerdict {
    const toolHistory = this.history.filter((h) => h.tool === tool);
    if (toolHistory.length < 2) return { level: "ok", count: 0, detector: "wandering", warningKey: "" };

    const recent = toolHistory.slice(-this.wanderingEscalation);
    const distinctArgs = new Set(recent.map((h) => h.argsHash));
    const sameResult = new Set(recent.map((h) => h.resultHash)).size === 1;

    if (distinctArgs.size >= this.wanderingEscalation && sameResult) {
      return {
        level: "critical",
        count: distinctArgs.size,
        detector: "wandering",
        warningKey: `wandering:${tool}`,
      };
    }
    if (distinctArgs.size >= this.wanderingThreshold && sameResult) {
      return {
        level: "warn",
        count: distinctArgs.size,
        detector: "wandering",
        warningKey: `wandering:${tool}`,
      };
    }
    return { level: "ok", count: 0, detector: "wandering", warningKey: "" };
  }

  private hashArgs(args: Record<string, unknown>): string {
    return createHash("sha256")
      .update(JSON.stringify(this.stableValue(args)))
      .digest("hex")
      .slice(0, 16);
  }

  private hashResult(result: ToolResult): string {
    const data = typeof result.data === "string"
      ? result.data.slice(0, 500)
      : JSON.stringify(result.data)?.slice(0, 500) ?? "";
    return createHash("sha256")
      .update(`${result.success}:${data}`)
      .digest("hex")
      .slice(0, 16);
  }

  private stableValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((v) => this.stableValue(v));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.keys(value as Record<string, unknown>)
          .sort()
          .map((k) => [k, this.stableValue((value as Record<string, unknown>)[k])]),
      );
    }
    return value;
  }
}

/**
 * Format a warning notice for injection into the next prompt.
 */
export function formatRepeatNotice(signal: BatchLoopSignal): string {
  const target = signal.detector === "wandering" ? "with varying arguments" : "with identical arguments";
  return [
    `[Loop guard WARNING] Tool "${signal.tool}" has been called ${signal.count} times consecutively ${target}.`,
    `Change approach or use a different tool. If the goal is achieved, reply with your answer.`,
  ].join("\n");
}

/**
 * Format a wandering redirect notice.
 */
export function formatWanderingRedirect(tool: string, count: number): string {
  return [
    `[Loop guard WARNING] Tool "${tool}" called ${count} times with different arguments but same result.`,
    `The current approach is not producing new information. Try a fundamentally different strategy.`,
  ].join("\n");
}

/**
 * Format a forced graceful reply when breaker trips.
 */
export function formatForcedLoopReply(tool: string, count: number): string {
  return `(Loop breaker tripped: "${tool}" was called ${count} times without progress. Providing best-effort answer based on available context.)`;
}
