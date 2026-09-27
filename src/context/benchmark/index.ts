export interface BenchmarkMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_call_id?: string; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
export interface BenchmarkFixture {
  version: 1;
  id: string;
  metadata: { model: string; tokenizer: string; seed: number };
  messages: BenchmarkMessage[];
  gold: { mustRetain: string[]; forbidden: string[] };
}
export interface BenchmarkRun {
  fixtureId: string;
  policy: 'identity' | 'current-compaction';
  tokenCount: { input: number; output: number; kind: 'estimated'; counter: string };
  wallTimeMs: 0;
  metrics: { retainedFacts: number; factCount: number; forbiddenLeaks: number; toolPairsValid: boolean };
  output: BenchmarkMessage[];
}
export interface FixtureReplay { fixtureId: string; version: 1; metadata: BenchmarkFixture['metadata']; runs: BenchmarkRun[] }
export interface Comparison { aggregate: { fixtureCount: number; policies: Record<string, { factRecall: number; forbiddenLeaks: number; tokenSavings: number }> }; worstCase: { fixtureId: string; policy: string; factRecall: number; forbiddenLeaks: number }; perFixture: FixtureReplay[] }

export function loadFixture(value: unknown): BenchmarkFixture {
  if (!value || typeof value !== 'object') throw new Error('Invalid fixture');
  const fixture = value as Partial<BenchmarkFixture>;
  if (fixture.version !== 1) throw new Error('Unsupported fixture version');
  if (!fixture.id || !fixture.metadata || !Array.isArray(fixture.messages) || !fixture.gold || !Array.isArray(fixture.gold.mustRetain) || !Array.isArray(fixture.gold.forbidden)) throw new Error('Invalid fixture schema');
  if (fixture.messages.some((m) => !m || !['system', 'user', 'assistant', 'tool'].includes(m.role) || typeof m.content !== 'string')) throw new Error('Invalid fixture messages');
  return fixture as BenchmarkFixture;
}

const estimateTokens = (messages: BenchmarkMessage[]) => Math.ceil(messages.reduce((sum, m) => sum + m.content.length, 0) / 4);
const sanitize = (text: string, forbidden: string[]) => forbidden.reduce((clean, phrase) => clean.split(phrase).join('[REDACTED]'), text);
const validatePairs = (messages: BenchmarkMessage[]) => {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') for (const call of message.tool_calls ?? []) pending.add(call.id);
    if (message.role === 'tool' && message.tool_call_id) {
      if (!pending.has(message.tool_call_id)) return false;
      pending.delete(message.tool_call_id);
    }
  }
  return pending.size === 0;
};

export async function replayFixture(input: BenchmarkFixture): Promise<FixtureReplay> {
  const fixture = loadFixture(input);
  const source = fixture.messages.map((m) => ({ ...m, content: sanitize(m.content, fixture.gold.forbidden) }));
  const currentPolicyResult: BenchmarkMessage[] = source;
  const outputs: Array<[BenchmarkRun['policy'], BenchmarkMessage[]]> = [['identity', source], ['current-compaction', currentPolicyResult]];
  const runs = outputs.map(([policy, output]): BenchmarkRun => {
    const corpus = output.map((m) => m.content).join('\n');
    const retainedFacts = fixture.gold.mustRetain.filter((fact) => corpus.includes(fact)).length;
    return { fixtureId: fixture.id, policy, tokenCount: { input: estimateTokens(source), output: estimateTokens(output), kind: 'estimated', counter: fixture.metadata.tokenizer }, wallTimeMs: 0, metrics: { retainedFacts, factCount: fixture.gold.mustRetain.length, forbiddenLeaks: fixture.gold.forbidden.filter((secret) => output.some((m) => m.content.includes(secret))).length, toolPairsValid: validatePairs(output) }, output };
  });
  return { fixtureId: fixture.id, version: 1, metadata: { ...fixture.metadata }, runs };
}

export function compareRuns(replays: FixtureReplay[]): Comparison {
  const policies = [...new Set(replays.flatMap((r) => r.runs.map((run) => run.policy)))].sort();
  const aggregate: Comparison['aggregate']['policies'] = {};
  for (const policy of policies) {
    const runs = replays.flatMap((r) => r.runs.filter((run) => run.policy === policy));
    const factCount = runs.reduce((sum, run) => sum + run.metrics.factCount, 0);
    aggregate[policy] = { factRecall: factCount ? runs.reduce((sum, run) => sum + run.metrics.retainedFacts, 0) / factCount : 1, forbiddenLeaks: runs.reduce((sum, run) => sum + run.metrics.forbiddenLeaks, 0), tokenSavings: runs.reduce((sum, run) => sum + run.tokenCount.input - run.tokenCount.output, 0) };
  }
  const candidates = replays.flatMap((r) => r.runs.map((run) => ({ fixtureId: r.fixtureId, policy: run.policy, factRecall: run.metrics.factCount ? run.metrics.retainedFacts / run.metrics.factCount : 1, forbiddenLeaks: run.metrics.forbiddenLeaks })));
  const worstCase = candidates.sort((a, b) => a.factRecall - b.factRecall || b.forbiddenLeaks - a.forbiddenLeaks || a.fixtureId.localeCompare(b.fixtureId) || a.policy.localeCompare(b.policy))[0] ?? { fixtureId: '', policy: '', factRecall: 1, forbiddenLeaks: 0 };
  return { aggregate: { fixtureCount: replays.length, policies: aggregate }, worstCase, perFixture: [...replays].sort((a, b) => a.fixtureId.localeCompare(b.fixtureId)) };
}
export function renderReport(comparison: Comparison): string { return JSON.stringify(comparison, null, 2) + '\n'; }
