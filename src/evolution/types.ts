export interface EvolutionTask {
  id: string;
  input: string;
  expected?: string | RegExp | ((output: string) => boolean);
  tags?: string[];
}

export interface EvaluationTrace {
  taskId: string;
  output: string;
  success: boolean;
  score?: number;
  durationMs: number;
  metadata?: Record<string, unknown>;
}

export interface FitnessScore {
  aggregate: number;
  correctness: number;
  reliability: number;
  efficiency: number;
  safety: number;
  traceCount: number;
  details: string[];
}

export interface SkillCandidate {
  id: string;
  instructions: string;
  rationale: string;
}
