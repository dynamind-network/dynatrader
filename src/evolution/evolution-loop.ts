import { SkillWorkshop } from '../agent/skills/skill-workshop';
import type { SkillMetadata, SkillProposal } from '../agent/skills/skill-types';
import { EvalHarness } from './eval-harness';
import { validateConstraints, type EvolutionConstraints } from './constraints';
import { scoreFitness } from './fitness';
import { SkillMutator } from './mutator';
import type { EvolutionTask, FitnessScore } from './types';

export interface EvolutionRequest { skill: SkillMetadata; instructions: string; tasks: EvolutionTask[]; constraints?: EvolutionConstraints; maxCandidates?: number; minImprovement?: number; }
export interface EvolutionResult { baseline: FitnessScore; selected?: { instructions: string; fitness: FitnessScore; rationale: string }; proposal?: SkillProposal; rejected: Array<{ rationale: string; reasons: string[] }>; }

/** Evaluate -> mutate -> constrain -> select -> submit to the human-gated workshop. */
export class EvolutionLoop {
  constructor(private readonly harness: EvalHarness, private readonly mutator: SkillMutator, private readonly workshop: SkillWorkshop) {}

  async run(request: EvolutionRequest): Promise<EvolutionResult> {
    const baselineTraces = await this.harness.run(request.tasks, request.instructions);
    const baseline = scoreFitness(request.tasks, baselineTraces);
    const candidates = (await this.mutator.propose({ instructions: request.instructions, tasks: request.tasks, traces: baselineTraces })).slice(0, request.maxCandidates ?? 4);
    const rejected: EvolutionResult['rejected'] = [];
    let selected: EvolutionResult['selected'];
    for (const candidate of candidates) {
      const constraints = validateConstraints(candidate.instructions, request.constraints);
      if (!constraints.passed) { rejected.push({ rationale: candidate.rationale, reasons: constraints.reasons }); continue; }
      const traces = await this.harness.run(request.tasks, candidate.instructions);
      const fitness = scoreFitness(request.tasks, traces);
      if (fitness.aggregate >= baseline.aggregate + (request.minImprovement ?? 0.01) && (!selected || fitness.aggregate > selected.fitness.aggregate)) selected = { instructions: candidate.instructions, fitness, rationale: candidate.rationale };
    }
    let proposal: SkillProposal | undefined;
    if (selected) proposal = await this.workshop.proposeSkill({ ...request.skill, confidence: selected.fitness.aggregate }, selected.instructions);
    return { baseline, ...(selected ? { selected } : {}), ...(proposal ? { proposal } : {}), rejected };
  }
}
