/**
 * BatchExecutor — Resource-Class-Aware Parallel Tool Execution
 *
 * Groups tool calls by ResourceClass:
 * - `pure_read` / `market`: fan out via Promise.allSettled
 * - `serial_write` / `browser` / `exec` / `session_spawn`: serialize within group
 * - `terminal`: runs solo after all other groups complete
 *
 * Distinct groups run concurrently. Failures of one call never abort siblings.
 */

import type { ToolCall, ToolResult, ToolRegistry } from "@dyna/contracts";
import { GraduatedLoopDetector, type BatchLoopSignal, formatRepeatNotice, formatWanderingRedirect, formatForcedLoopReply } from "./graduated-loop-detector";

/**
 * Resource class derived from ToolDefinition's native `readOnly` and `canRunInParallel` fields.
 * - `parallel`: readOnly=true or canRunInParallel=true — fan out via Promise.allSettled
 * - `serial`: readOnly=false and canRunInParallel≠true — serialize within group
 * - `terminal`: reply/finish tools — runs solo after all others complete
 */
export type ResourceClass = "parallel" | "serial" | "terminal";

const TERMINAL_TOOLS = new Set(["reply", "finish", "send_message", "end_session"]);

export function resourceClassFor(tool: string, def?: { readOnly?: boolean; canRunInParallel?: boolean; category?: string }): ResourceClass {
  if (TERMINAL_TOOLS.has(tool)) return "terminal";
  if (def?.readOnly === true || def?.canRunInParallel === true) return "parallel";
  return "serial";
}

export function isParallelWithinGroup(cls: ResourceClass): boolean {
  return cls === "parallel";
}

export interface BatchCallInput {
  batchIndex: number;
  call: ToolCall;
  resourceClass: ResourceClass;
  approvalGranted?: boolean;
}

export interface BatchExecutionContext {
  sessionId: string;
  stepIndex: number;
  signal: AbortSignal;
  onCallStarted?: (info: { batchIndex: number; batchSize: number }) => void;
  onCallFinished?: (info: { batchIndex: number; batchSize: number; result: ToolResult; durationMs: number }) => void;
  tracker?: GraduatedLoopDetector;
  maxWaveSize?: number;
}

export interface BatchCallResult {
  batchIndex: number;
  call: ToolCall;
  resourceClass: ResourceClass;
  result?: ToolResult;
  durationMs: number;
  cancelled: boolean;
}

export interface BatchExecutionResult {
  results: BatchCallResult[];
  cancelled: boolean;
  loopSignals: BatchLoopSignal[];
}

/**
 * Group calls by ResourceClass, preserving batch-index order within groups.
 */
export function planBatch(inputs: readonly BatchCallInput[]): Map<ResourceClass, BatchCallInput[]> {
  const groups = new Map<ResourceClass, BatchCallInput[]>();
  for (const input of inputs) {
    const list = groups.get(input.resourceClass) ?? [];
    list.push(input);
    groups.set(input.resourceClass, list);
  }
  return groups;
}

/**
 * Execute a batch of tool calls with resource-class-aware parallelism.
 */
export async function executeBatch(
  inputs: readonly BatchCallInput[],
  registry: ToolRegistry,
  ctx: BatchExecutionContext,
): Promise<BatchExecutionResult> {
  const legacyRegistry = registry as ToolRegistry & {
    execute?: (call: ToolCall, context?: { signal?: AbortSignal; approvalGranted?: boolean }) => Promise<ToolResult>;
    executeBatch?: (calls: ToolCall[]) => Promise<Array<{ call: ToolCall; result: ToolResult }>>;
  };
  const legacyBatch = legacyRegistry.executeBatch;
  if (legacyBatch && typeof legacyRegistry.execute !== "function" && !inputs.some((input) => input.approvalGranted)) {
    // Compatibility for older test/custom registries without per-call execute.
    // Production registries must use this executor so cancellation and loop
    // detection reach each individual tool call.
    const results = await legacyBatch.call(registry, inputs.map(input => input.call));
    return {
      results: inputs.map(input => ({
        batchIndex: input.batchIndex,
        call: input.call,
        resourceClass: input.resourceClass,
        result: results.find(item => item.call === input.call)?.result,
        durationMs: 0,
        cancelled: false,
      })),
      cancelled: false,
      loopSignals: [],
    };
  }
  const batchSize = inputs.length;
  if (batchSize === 0) {
    return { results: [], cancelled: false, loopSignals: [] };
  }

  const slots: BatchCallResult[] = inputs.map((input) => ({
    batchIndex: input.batchIndex,
    call: input.call,
    resourceClass: input.resourceClass,
    durationMs: 0,
    cancelled: false,
  }));
  const loopSignals: BatchLoopSignal[] = [];

  // Split off terminal call (must be last)
  const tailIsTerminal =
    inputs.length > 1 &&
    inputs[inputs.length - 1]!.resourceClass === "terminal";
  const nonTerminalInputs = tailIsTerminal ? inputs.slice(0, -1) : inputs;
  const terminalInput = tailIsTerminal ? inputs[inputs.length - 1]! : null;

  // Phase 1: Run loop gate for every non-terminal call before dispatch
  const toInvoke: BatchCallInput[] = [];
  for (const input of nonTerminalInputs) {
    if (ctx.signal.aborted) {
      slots[input.batchIndex] = { ...slots[input.batchIndex]!, cancelled: true };
      continue;
    }

    // Loop detection gate
    const gate = runSyncLoopGate(input, ctx, loopSignals);
    if (!gate.proceed && gate.vetoResult) {
      ctx.onCallStarted?.({ batchIndex: input.batchIndex, batchSize });
      slots[input.batchIndex] = {
        ...slots[input.batchIndex]!,
        result: gate.vetoResult,
        durationMs: 0,
      };
      ctx.onCallFinished?.({
        batchIndex: input.batchIndex,
        batchSize,
        result: gate.vetoResult,
        durationMs: 0,
      });
      continue;
    }

    toInvoke.push(input);
  }

  // Phase 2: Group by class and execute
  const groups = planBatch(toInvoke);

  const invokeOne = async (input: BatchCallInput): Promise<void> => {
    if (ctx.signal.aborted) {
      slots[input.batchIndex] = { ...slots[input.batchIndex]!, cancelled: true };
      return;
    }

    ctx.onCallStarted?.({ batchIndex: input.batchIndex, batchSize });
    const startedAt = Date.now();

    let result: ToolResult;
    try {
      result = await registry.execute(input.call, {
        signal: ctx.signal,
        sessionId: ctx.sessionId,
        approvalGranted: input.approvalGranted === true,
      });
    } catch (err) {
      result = {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
        truncated: false,
      };
    }

    const durationMs = Date.now() - startedAt;
    slots[input.batchIndex] = { ...slots[input.batchIndex]!, result, durationMs };

    // Record outcome for loop detection
    if (ctx.tracker && input.resourceClass !== "terminal") {
      ctx.tracker.recordOutcome(input.call.tool, input.call.args, result);
    }

    ctx.onCallFinished?.({
      batchIndex: input.batchIndex,
      batchSize,
      result,
      durationMs,
    });
  };

  // Execute groups concurrently
  const groupTasks: Array<Promise<void>> = [];
  for (const [cls, calls] of groups) {
    if (isParallelWithinGroup(cls)) {
      // Fan out, optionally bounded by maxWaveSize
      const waveSize = ctx.maxWaveSize ?? calls.length;
      groupTasks.push(
        (async () => {
          for (let i = 0; i < calls.length; i += waveSize) {
            const wave = calls.slice(i, i + waveSize);
            await Promise.allSettled(wave.map(invokeOne));
          }
        })(),
      );
    } else {
      // Serialize within group
      groupTasks.push(
        (async () => {
          for (const call of calls) {
            if (ctx.signal.aborted) {
              slots[call.batchIndex] = { ...slots[call.batchIndex]!, cancelled: true };
              continue;
            }
            await invokeOne(call);
          }
        })(),
      );
    }
  }

  let cancelled = false;
  try {
    await Promise.all(groupTasks);
  } catch {
    cancelled = true;
  }

  // Terminal barrier: run terminal call solo after all others complete
  if (terminalInput !== null) {
    if (ctx.signal.aborted) {
      slots[terminalInput.batchIndex] = { ...slots[terminalInput.batchIndex]!, cancelled: true };
    } else {
      await invokeOne(terminalInput);
    }
  }

  // Mark any remaining slots as cancelled
  for (const slot of slots) {
    if (!slot.result && !slot.cancelled) {
      slot.cancelled = true;
    }
  }

  return {
    results: slots,
    cancelled: cancelled || ctx.signal.aborted,
    loopSignals,
  };
}

function runSyncLoopGate(
  input: BatchCallInput,
  ctx: BatchExecutionContext,
  loopSignals: BatchLoopSignal[],
): { proceed: boolean; vetoResult?: ToolResult } {
  if (input.resourceClass === "terminal" || !ctx.tracker) {
    return { proceed: true };
  }

  const verdict = ctx.tracker.check(input.call.tool, input.call.args);
  ctx.tracker.recordCall(input.call.tool, input.call.args);

  if (verdict.level === "critical") {
    ctx.tracker.recordVeto();
    const vetoResult: ToolResult = {
      success: false,
      error: formatVetoInstruction(input.call.tool, verdict.count, verdict.detector),
      durationMs: 0,
      truncated: false,
    };
    loopSignals.push({
      level: "critical",
      tool: input.call.tool,
      count: verdict.count,
      detector: verdict.detector,
      warningKey: verdict.warningKey,
    });
    return { proceed: false, vetoResult };
  }

  if (verdict.level === "breaker") {
    loopSignals.push({
      level: "breaker",
      tool: input.call.tool,
      count: verdict.count,
      detector: verdict.detector,
      warningKey: verdict.warningKey,
    });
    return { proceed: false, vetoResult: { success: false, error: "breaker", durationMs: 0, truncated: false } };
  }

  if (verdict.level === "warn") {
    loopSignals.push({
      level: "warn",
      tool: input.call.tool,
      count: verdict.count,
      detector: verdict.detector,
      warningKey: verdict.warningKey,
    });
  }

  return { proceed: true };
}

function formatVetoInstruction(tool: string, count: number, detector: string): string {
  if (detector === "wandering") {
    return `Vetoed: "${tool}" has been called ${count} times with different arguments but the same result. Try a fundamentally different approach or reply with what you know.`;
  }
  return `Vetoed: "${tool}" has been called ${count} times consecutively with identical arguments. This is a no-progress loop. Change your approach or reply with your answer.`;
}

/**
 * Format a breaker message for the agent loop to use as a forced reply.
 */
export { formatForcedLoopReply, formatRepeatNotice, formatWanderingRedirect };
