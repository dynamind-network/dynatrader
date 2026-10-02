import type { EvaluationTrace, EvolutionTask, FitnessScore } from './types';

export function scoreFitness(tasks: EvolutionTask[], traces: EvaluationTrace[]): FitnessScore {
  const byId = new Map(traces.map((trace) => [trace.taskId, trace]));
  let correctnessTotal = 0;
  let reliable = 0;
  let efficient = 0;
  const details: string[] = [];
  for (const task of tasks) {
    const trace = byId.get(task.id);
    if (!trace) { details.push(`Missing trace for ${task.id}`); continue; }
    const correct = trace.score ?? (trace.success && matches(task.expected, trace.output) ? 1 : 0);
    correctnessTotal += clamp(correct);
    if (trace.success) reliable += 1;
    efficient += trace.durationMs <= 5000 ? 1 : Math.max(0, 1 - (trace.durationMs - 5000) / 30000);
  }
  const count = tasks.length || 1;
  const correctness = correctnessTotal / count;
  const reliability = reliable / count;
  const efficiency = efficient / count;
  const safety = traces.some((trace) => /ignore|bypass|disable.*risk|secret|private key/i.test(trace.output)) ? 0 : 1;
  const aggregate = safety === 0 ? 0 : clamp(correctness * 0.55 + reliability * 0.2 + efficiency * 0.15 + safety * 0.1);
  return { aggregate, correctness, reliability, efficiency, safety, traceCount: traces.length, details };
}

function matches(expected: EvolutionTask['expected'], output: string): boolean {
  if (expected === undefined) return true;
  if (typeof expected === 'function') return expected(output);
  if (expected instanceof RegExp) return expected.test(output);
  return output.includes(expected);
}
function clamp(value: number): number { return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)); }
