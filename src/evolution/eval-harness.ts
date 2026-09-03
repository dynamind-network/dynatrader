import type { EvaluationTrace, EvolutionTask } from './types';

export type EvolutionRunner = (task: EvolutionTask, instructions: string) => Promise<Omit<EvaluationTrace, 'taskId'>>;

export interface EvalHarnessOptions { concurrency?: number; }

/** Runs repeatable benchmark tasks against a candidate skill/prompt. */
export class EvalHarness {
  private readonly concurrency: number;
  constructor(private readonly runner: EvolutionRunner, options: EvalHarnessOptions = {}) { this.concurrency = Math.max(1, options.concurrency ?? 2); }

  async run(tasks: EvolutionTask[], instructions: string): Promise<EvaluationTrace[]> {
    const traces: EvaluationTrace[] = [];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < tasks.length) {
        const task = tasks[cursor++];
        if (!task) return;
        const result = await this.runner(task, instructions);
        traces.push({ ...result, taskId: task.id });
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, tasks.length) }, () => worker()));
    return traces.sort((a, b) => a.taskId.localeCompare(b.taskId));
  }
}
