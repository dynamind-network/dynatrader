/**
 * DynaMind Eval Suite — Deterministic Evaluator Registry
 *
 * Pure functions that score trajectories without LLM calls.
 * Each eval family registers its evaluators here.
 */

import type {
  EvalTrace,
  TrajectoryStep,
  DeterministicEvaluator,
  HardFailureChecker,
} from './types';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const evaluators = new Map<string, DeterministicEvaluator>();
const hardFailureCheckers = new Map<string, HardFailureChecker>();

export function registerEvaluator(family: string, fn: DeterministicEvaluator): void {
  evaluators.set(family, fn);
}

export function registerHardFailureChecker(family: string, fn: HardFailureChecker): void {
  hardFailureCheckers.set(family, fn);
}

export function getEvaluator(family: string): DeterministicEvaluator | undefined {
  return evaluators.get(family);
}

export function getHardFailureChecker(family: string): HardFailureChecker | undefined {
  return hardFailureCheckers.get(family);
}

// ---------------------------------------------------------------------------
// Built-in evaluators
// ---------------------------------------------------------------------------

/** Check that required tools were called (or mentioned in reasoning when no tool calls exist) */
export function checkToolSelection(
  trajectory: TrajectoryStep[],
  required: string[],
  forbidden: string[] = [],
): Record<string, number> {
  const calledTools = new Set(
    trajectory.filter(s => s.action === 'tool_call' && s.tool).map(s => s.tool!),
  );

  // Fallback: if no tool_call steps, check reasoning text for required tool mentions only
  // (don't check forbidden in reasoning - agent may mention them in "NOT called" section)
  let reasoningTools = new Set<string>();
  if (calledTools.size === 0 && required.length > 0) {
    const reasoning = trajectory
      .filter(s => s.action === 'reasoning' || s.action === 'decision')
      .map(s => String(s.output ?? ''))
      .join(' ')
      .toLowerCase();
    for (const tool of required) {
      if (reasoning.includes(tool.toLowerCase())) {
        reasoningTools.add(tool);
      }
    }
  }

  const effectiveCalled = calledTools.size > 0 ? calledTools : reasoningTools;
  const requiredHit = required.filter(t => effectiveCalled.has(t)).length;
  const tool_selection = required.length > 0 ? requiredHit / required.length : 1;

  // Only check forbidden violations when actual tool calls exist
  // (agent mentioning forbidden tools in "NOT called" section is not a violation)
  // When no tools are called at all, there are zero violations (perfect compliance)
  const forbiddenHit = calledTools.size > 0
    ? forbidden.filter(t => calledTools.has(t)).length
    : 0;
  const forbidden_violations = forbidden.length > 0
    ? (calledTools.size === 0 ? 1 : 1 - (forbiddenHit / forbidden.length))
    : 1;

  return {
    tool_selection,
    forbidden_violations,
    tools_called: calledTools.size,
    tools_mentioned: reasoningTools.size,
    tools_required_hit: requiredHit,
    tools_required_total: required.length,
  };
}

/** Check confidence calibration */
export function checkConfidenceCalibration(
  output: string,
  actual_accuracy: number,
): Record<string, number> {
  const lower = output.toLowerCase();
  let expressed_confidence = 0.5;

  if (lower.includes('very confident') || lower.includes('certain') || lower.includes('definitely')) {
    expressed_confidence = 0.9;
  } else if (lower.includes('confident') || lower.includes('likely')) {
    expressed_confidence = 0.75;
  } else if (lower.includes('uncertain') || lower.includes('unsure') || lower.includes('maybe')) {
    expressed_confidence = 0.3;
  } else if (lower.includes('no idea') || lower.includes('impossible to')) {
    expressed_confidence = 0.1;
  }

  const calibration_gap = Math.abs(expressed_confidence - actual_accuracy);
  const calibration = Math.max(0, 1 - calibration_gap);

  return {
    calibration,
    expressed_confidence,
    actual_accuracy,
  };
}

/** Check conflict detection in output */
export function checkConflictDetection(
  output: string,
  conflicts: Array<{ type: string; description: string }>,
): Record<string, number> {
  const lower = output.toLowerCase();
  let detected = 0;

  for (const conflict of conflicts) {
    const keywords = conflict.description.toLowerCase().split(/\s+/).filter(w => w.length > 4);
    const found = keywords.some(kw => lower.includes(kw));
    if (found || lower.includes(conflict.type.toLowerCase())) {
      detected++;
    }
  }

  // Also check for explicit conflict language
  const conflict_words = ['conflict', 'contradict', 'diverge', 'mixed', 'offset', 'counter'];
  const has_conflict_language = conflict_words.some(w => lower.includes(w));

  return {
    conflict_detection: conflicts.length > 0 ? detected / conflicts.length : 1,
    conflicts_detected: detected,
    conflicts_total: conflicts.length,
    conflict_language_used: has_conflict_language ? 1 : 0,
  };
}

/** Check efficiency of execution */
export function checkEfficiency(trace: EvalTrace): Record<string, number> {
  const { latency_ms, tokens_in, tokens_out, tool_calls, cost_usd, trajectory } = trace;

  const total_steps = trajectory.length;
  const reasoning_steps = trajectory.filter(s => s.action === 'reasoning').length;
  const tool_steps = trajectory.filter(s => s.action === 'tool_call').length;

  // Check for redundant tool calls
  const toolNames = trajectory.filter(s => s.action === 'tool_call').map(s => s.tool);
  const uniqueTools = new Set(toolNames);
  const redundant_calls = toolNames.length - uniqueTools.size;

  // Efficiency score: penalize excess
  let efficiency = 1.0;
  if (total_steps > 20) efficiency *= 0.8;
  if (total_steps > 40) efficiency *= 0.5;
  if (redundant_calls > 0) efficiency *= Math.max(0.5, 1 - redundant_calls * 0.1);
  if (latency_ms > 30000) efficiency *= 0.7;
  if (latency_ms > 60000) efficiency *= 0.4;

  return {
    efficiency: Math.max(0, Math.min(1, efficiency)),
    total_steps,
    reasoning_steps,
    tool_steps,
    redundant_calls,
  };
}

/** Check memory recall quality */
export function checkMemoryRecall(
  retrieved_memories: Array<{ content: string; relevance: number }>,
  expected_keywords: string[],
): Record<string, number> {
  if (expected_keywords.length === 0) {
    return { memory_recall: 1, memory_relevance: 1, memories_retrieved: 0 };
  }

  const all_content = retrieved_memories.map(m => m.content.toLowerCase()).join(' ');
  const recalled = expected_keywords.filter(kw => all_content.includes(kw.toLowerCase()));
  const avg_relevance = retrieved_memories.length > 0
    ? retrieved_memories.reduce((s, m) => s + m.relevance, 0) / retrieved_memories.length
    : 0;

  return {
    memory_recall: recalled.length / expected_keywords.length,
    memory_relevance: avg_relevance,
    memories_retrieved: retrieved_memories.length,
    keywords_matched: recalled.length,
    keywords_total: expected_keywords.length,
  };
}

// ---------------------------------------------------------------------------
// System-Stack Family Evaluators
// ---------------------------------------------------------------------------

/**
 * tool_pipeline: Tests the full tool execution pipeline.
 * Scores based on: tools called correctly, results processed, no errors.
 */
registerEvaluator('tool_pipeline', (trajectory, scenario) => {
  const toolCalls = trajectory.filter(s => s.action === 'tool_call');
  const toolResults = trajectory.filter(s => s.action === 'tool_result');
  const errors = trajectory.filter(s => s.action === 'error');

  const requiredTools = scenario.expected.tools_required ?? [];
  const calledTools = new Set(toolCalls.map(s => s.tool).filter(Boolean));
  const requiredHit = requiredTools.filter(t => calledTools.has(t)).length;
  const toolCoverage = requiredTools.length > 0 ? requiredHit / requiredTools.length : 1;

  // Check that every tool call has a result
  const matchedPairs = toolCalls.filter(tc =>
    toolResults.some(tr => tr.tool === tc.tool)
  );
  const pairRatio = toolCalls.length > 0 ? matchedPairs.length / toolCalls.length : 1;

  // Error penalty
  const errorRate = toolCalls.length > 0 ? errors.length / toolCalls.length : 0;

  return {
    task_success: toolCoverage * pairRatio * (1 - errorRate),
    tool_coverage: toolCoverage,
    call_result_pairing: pairRatio,
    error_rate: errorRate,
  };
});

/**
 * memory_recall: Tests memory write → search → retrieval accuracy.
 * Scores based on: memory written, recalled, relevance.
 */
registerEvaluator('memory_recall', (trajectory, scenario) => {
  const memoryWrites = trajectory.filter(s => s.action === 'tool_call' && s.tool === 'memory_write');
  const memorySearches = trajectory.filter(s => s.action === 'tool_call' && s.tool === 'memory_search');
  const memoryResults = trajectory.filter(s => s.action === 'tool_result' && s.tool === 'memory_search');

  // Did the agent write memories before searching?
  const wroteFirst = memoryWrites.length > 0 &&
    memorySearches.length > 0 &&
    trajectory.indexOf(memoryWrites[0]) < trajectory.indexOf(memorySearches[0]);

  // Did searches return results?
  const searchesWithResults = memoryResults.filter(r => {
    const output = String(r.output ?? '');
    return output.length > 10 && !output.startsWith('ERROR');
  }).length;
  const searchYield = memorySearches.length > 0
    ? searchesWithResults / memorySearches.length
    : 0;

  return {
    task_success: wroteFirst ? searchYield : 0.3,
    wrote_before_search: wroteFirst ? 1 : 0,
    search_yield: searchYield,
    memories_written: memoryWrites.length,
    searches_performed: memorySearches.length,
  };
});

/**
 * multi_agent_coordination: Tests sub-agent spawning and coordination.
 * Scores based on: agent spawned, task delegated, result received.
 */
registerEvaluator('multi_agent_coordination', (trajectory, scenario) => {
  const spawns = trajectory.filter(s => s.action === 'tool_call' && s.tool === 'spawn_subagent');
  const spawnResults = trajectory.filter(s => s.action === 'tool_result' && s.tool === 'spawn_subagent');
  const sessionSends = trajectory.filter(s => s.action === 'tool_call' && s.tool === 'sessions_send');
  const sessionLists = trajectory.filter(s => s.action === 'tool_call' && s.tool === 'sessions_list');

  // Did spawning succeed?
  const successfulSpawns = spawnResults.filter(r => {
    const output = String(r.output ?? '');
    return output.includes('"success":true') || output.includes('agentName');
  }).length;
  const spawnSuccess = spawns.length > 0 ? successfulSpawns / spawns.length : 0;

  // Did the agent coordinate (send messages, list sessions)?
  const coordinationActions = sessionSends.length + sessionLists.length;
  const coordinated = coordinationActions > 0 ? 1 : 0;

  return {
    task_success: spawns.length > 0 ? spawnSuccess : coordinated * 0.5,
    spawn_success: spawnSuccess,
    spawns_attempted: spawns.length,
    coordination_actions: coordinationActions,
  };
});

/**
 * profile_resolution: Tests that tool profiles resolve correctly.
 * Scores based on: correct tools available, restricted tools blocked.
 */
registerEvaluator('profile_resolution', (trajectory, scenario) => {
  const toolCalls = trajectory.filter(s => s.action === 'tool_call' && s.tool);
  const calledTools = toolCalls.map(s => s.tool!);

  const requiredTools = scenario.expected.tools_required ?? [];
  const forbiddenTools = scenario.expected.tools_forbidden ?? [];

  // Check required tools were available (called or mentioned)
  const calledSet = new Set(calledTools);
  const requiredHit = requiredTools.filter(t => calledSet.has(t)).length;
  const requiredScore = requiredTools.length > 0 ? requiredHit / requiredTools.length : 1;

  // Check forbidden tools were NOT called
  const forbiddenViolated = forbiddenTools.filter(t => calledSet.has(t)).length;
  const forbiddenScore = forbiddenTools.length > 0
    ? (forbiddenViolated === 0 ? 1 : 0)
    : 1;

  return {
    task_success: requiredScore * forbiddenScore,
    required_tools_available: requiredScore,
    forbidden_tools_blocked: forbiddenScore,
    forbidden_violations: forbiddenViolated,
  };
});
