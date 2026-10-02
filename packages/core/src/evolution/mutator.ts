import type { EvaluationTrace, EvolutionTask, SkillCandidate } from './types';

export interface MutationRequest { instructions: string; tasks: EvolutionTask[]; traces: EvaluationTrace[]; }
export type MutationGenerator = (request: MutationRequest) => Promise<SkillCandidate[]> | SkillCandidate[];

/** Produces bounded reflective variants; callers may inject an LLM-backed generator. */
export class SkillMutator {
  constructor(private readonly generator?: MutationGenerator) {}

  async propose(request: MutationRequest): Promise<SkillCandidate[]> {
    if (this.generator) return this.generator(request);
    const failed = request.traces.filter((trace) => !trace.success).map((trace) => trace.taskId);
    const suffix = failed.length ? `\n\n## Failure handling\n\n- Re-check assumptions and explicitly report uncertainty for failed tasks: ${failed.join(', ')}.` : '';
    return [{ id: 'mutation-safety-checklist', instructions: `${request.instructions.trim()}\n\n## Verification checklist\n\n- State assumptions and evidence.\n- Validate risk and permission constraints before acting.\n- Report uncertainty instead of inventing results.${suffix}`, rationale: 'Add explicit verification and safety behavior based on evaluation traces.' }];
  }
}
