/**
 * DynaMind Eval Suite — CLI Entry Point
 *
 * Usage:
 *   bun run evals/cli.ts                                                    # Run all families
 *   bun run evals/cli.ts --mode baseline                                    # Raw model, no harness
 *   bun run evals/cli.ts --mode dynamind                                    # Full agent runtime
 *   bun run evals/cli.ts --family market_understanding                      # Run one family
 *   bun run evals/cli.ts --families market_understanding,trading_decision    # Run specific families
 *   bun run evals/cli.ts --exclude memory                                   # Exclude a family
 *   bun run evals/cli.ts --suite trading-v1                                 # Run named suite
 *   bun run evals/cli.ts --list                                             # List all scenarios
 *   bun run evals/cli.ts --id trade-bull-entry-001                          # Run single scenario
 *   bun run evals/cli.ts --compare baseline.json dynamind.json              # Compare two runs
 *
 * Families:
 *   market_understanding, tool_selection, trading_decision, multi_agent, memory
 */

import { EvalRunner } from './harness/runner';
import { generateReport, formatReport, exportReportJson } from './harness/report';
import { createDynaMindRunner } from './harness/dynamind-runner';
import { ALL_SCENARIOS, ALL_SCENARIOS_FLAT, getScenariosByFamily, getScenarioById } from './families';
import type { EvalScenario, EvalTrace, EvalFamily, EvalReport } from './harness/types';
import type { AgentRunner } from './harness/runner';

// ---------------------------------------------------------------------------
// LM Studio agent runner (baseline - raw model, no harness)
// ---------------------------------------------------------------------------

const LM_STUDIO_URL = process.env['LM_STUDIO_BASE_URL'] ?? 'http://localhost:1234';

async function resolveModel(): Promise<string> {
  try {
    const res = await fetch(`${LM_STUDIO_URL}/v1/models`);
    if (!res.ok) return 'local-model';
    const data = await res.json() as { data?: Array<{ id?: string }> };
    return data?.data?.[0]?.id ?? 'local-model';
  } catch {
    return 'local-model';
  }
}

async function callLMStudio(
  systemPrompt: string,
  userPrompt: string,
  model: string,
): Promise<{
  content: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}> {
  const response = await fetch(`${LM_STUDIO_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 4096,
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    throw new Error(`LM Studio error: ${response.status}`);
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
    usage: { prompt_tokens: number; completion_tokens: number };
  };

  return {
    content: data.choices?.[0]?.message?.content ?? '',
    tokens_in: data.usage?.prompt_tokens ?? 0,
    tokens_out: data.usage?.completion_tokens ?? 0,
    cost_usd: 0,
  };
}

// ---------------------------------------------------------------------------
// System prompts per family (used by baseline runner)
// ---------------------------------------------------------------------------

const FAMILY_SYSTEM_PROMPTS: Partial<Record<EvalFamily, string>> = {
  market_understanding: `You are DynaMind, an autonomous trading agent. Analyze the market data provided and classify the current regime.

Respond in EXACTLY this format (no other text before or after):

1. Market regime: [bull_trend|bear_trend|high_volatility|range_bound|breakout|breakdown|reversal]
2. Confidence level: [0-100]%
3. Supporting evidence:
   - [bullet point with specific data from the snapshot]
   - [bullet point]
4. Any contradictions you notice:
   - [bullet point] or None`,

  tool_selection: `You are DynaMind, an autonomous trading agent. You have access to these tools: read_market_data, get_portfolio, check_risk, execute_trade, web_search, write_file, edit_file, spawn_subagent.

Analyze the scenario and decide which tools you would call, in what order, and why. Be specific about each tool call you would make.

Respond in this format:
1. Tools to call (in order): [tool1, tool2, ...]
2. Reasoning for each:
   - tool1: [why]
   - tool2: [why]
3. Tools explicitly NOT called and why: [tool: reason, ...]`,

  trading_decision: `You are DynaMind, an autonomous trading agent. Analyze the market data and portfolio state.

Respond in EXACTLY this format:

1. Decision: [LONG|SHORT|HOLD|CLOSE|REDUCE]
2. Reasoning: [2-3 sentences with specific data]
3. Position sizing: [percentage of equity]
4. Entry/exit price: [specific price level]
5. Stop loss: [specific price level]
6. Risk assessment: [LOW|MEDIUM|HIGH]`,

  multi_agent: `You are DynaMind, an autonomous trading agent working with other agents.

Analyze the scenario and provide your perspective. If other agents have provided opinions, address their points directly.

Respond in this format:
1. Your position: [specific recommendation]
2. Supporting evidence: [data points]
3. Response to other agents (if any): [address their arguments]
4. Final recommendation: [consensus position or dissent]`,

  memory: `You are DynaMind, an autonomous trading agent. You have access to your memory of past decisions.

Analyze the scenario using both current data and your memory.

Respond in this format:
1. Current analysis: [what the data shows]
2. Relevant memories: [what past experience says]
3. Decision: [action]
4. Reasoning: [how memory and current data informed your decision]`,
};

const DEFAULT_SYSTEM_PROMPT = `You are DynaMind, an autonomous trading agent. Analyze the situation and provide your decision with clear reasoning. Be specific and cite exact numbers from the data provided. Be concise but thorough.`;

/**
 * Baseline agent runner — calls LM Studio directly, no harness.
 * This measures raw model capability.
 */
function createBaselineRunner(model: string): AgentRunner {
  return {
    async run(scenario: EvalScenario) {
      const trajectory: EvalTrace['trajectory'] = [];
      let stepNum = 0;

      const systemPrompt = FAMILY_SYSTEM_PROMPTS[scenario.family] ?? DEFAULT_SYSTEM_PROMPT;

      // Step 1: Reasoning
      const reasoningStart = performance.now();
      const llmResponse = await callLMStudio(systemPrompt, scenario.task, model);
      trajectory.push({
        step: stepNum++,
        action: 'reasoning',
        output: llmResponse.content,
        latency_ms: performance.now() - reasoningStart,
        timestamp: new Date().toISOString(),
        token_usage: { prompt: llmResponse.tokens_in, completion: llmResponse.tokens_out },
      });

      // Step 2: Decision
      trajectory.push({
        step: stepNum++,
        action: 'decision',
        output: llmResponse.content,
        latency_ms: 0,
        timestamp: new Date().toISOString(),
      });

      return {
        trajectory,
        decision: llmResponse.content,
        cost_usd: llmResponse.cost_usd,
        tokens_in: llmResponse.tokens_in,
        tokens_out: llmResponse.tokens_out,
        model,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Compare two eval runs
// ---------------------------------------------------------------------------

function compareRuns(baselinePath: string, dynamindPath: string): string {
  const fs = require('node:fs') as typeof import('fs');

  const baselineRaw = JSON.parse(fs.readFileSync(baselinePath, 'utf-8')) as { traces: EvalTrace[]; suite: string; timestamp: string };
  const dynamindRaw = JSON.parse(fs.readFileSync(dynamindPath, 'utf-8')) as { traces: EvalTrace[]; suite: string; timestamp: string };

  const baseline = baselineRaw.traces;
  const dynamind = dynamindRaw.traces;

  // Build lookup by task_id
  const baselineMap = new Map(baseline.map(t => [t.task_id, t]));
  const dynamindMap = new Map(dynamind.map(t => [t.task_id, t]));

  // Calculate metrics
  const allIds = new Set([...baselineMap.keys(), ...dynamindMap.keys()]);

  let baselinePass = 0;
  let dynamindPass = 0;
  let baselineScore = 0;
  let dynamindScore = 0;
  let baselineHardFails = 0;
  let dynamindHardFails = 0;
  let baselineTokens = 0;
  let dynamindTokens = 0;
  let baselineLatency = 0;
  let dynamindLatency = 0;
  let count = 0;

  const improved: string[] = [];
  const regressed: string[] = [];
  const unchanged: string[] = [];

  for (const id of allIds) {
    const b = baselineMap.get(id);
    const d = dynamindMap.get(id);

    if (b) {
      baselinePass += b.passed ? 1 : 0;
      baselineScore += b.scores.task_success;
      baselineHardFails += b.hard_failures.length;
      baselineTokens += b.tokens_in + b.tokens_out;
      baselineLatency += b.latency_ms;
    }

    if (d) {
      dynamindPass += d.passed ? 1 : 0;
      dynamindScore += d.scores.task_success;
      dynamindHardFails += d.hard_failures.length;
      dynamindTokens += d.tokens_in + d.tokens_out;
      dynamindLatency += d.latency_ms;
    }

    if (b && d) {
      count++;
      const bScore = b.scores.task_success;
      const dScore = d.scores.task_success;
      if (dScore > bScore) improved.push(id);
      else if (dScore < bScore) regressed.push(id);
      else unchanged.push(id);
    }
  }

  const n = count || 1;

  const lines: string[] = [];
  lines.push('');
  lines.push('DYNAMIND HARNESS LIFT COMPARISON');
  lines.push('='.repeat(70));
  lines.push('');
  lines.push(`  Baseline: ${baselineRaw.suite} (${baselinePath})`);
  lines.push(`  DynaMind: ${dynamindRaw.suite} (${dynamindPath})`);
  lines.push(`  Scenarios: ${count}`);
  lines.push('');
  lines.push('METRIC                        BASELINE    DYNAMIND     LIFT');
  lines.push('-'.repeat(70));

  const bPassRate = ((baselinePass / n) * 100).toFixed(1);
  const dPassRate = ((dynamindPass / n) * 100).toFixed(1);
  const passLift = ((dynamindPass - baselinePass) / n * 100).toFixed(1);
  lines.push(`  Pass Rate                    ${bPassRate.padStart(6)}%    ${dPassRate.padStart(6)}%    ${passLift.startsWith('+') ? passLift : '+' + passLift}%`);

  const bAvgScore = (baselineScore / n).toFixed(2);
  const dAvgScore = (dynamindScore / n).toFixed(2);
  const scoreLift = ((dynamindScore - baselineScore) / n).toFixed(2);
  lines.push(`  Avg Task Success             ${bAvgScore.padStart(6)}      ${dAvgScore.padStart(6)}      +${scoreLift}`);

  lines.push(`  Hard Fails                   ${String(baselineHardFails).padStart(6)}      ${String(dynamindHardFails).padStart(6)}      ${dynamindHardFails <= baselineHardFails ? '-' : '+'}${Math.abs(dynamindHardFails - baselineHardFails)}`);

  const bAvgTokens = (baselineTokens / n).toFixed(0);
  const dAvgTokens = (dynamindTokens / n).toFixed(0);
  lines.push(`  Avg Tokens/task              ${bAvgTokens.padStart(6)}      ${dAvgTokens.padStart(6)}      ${Number(dAvgTokens) > Number(bAvgTokens) ? '+' : ''}${Number(dAvgTokens) - Number(bAvgTokens)}`);

  const bAvgLatency = (baselineLatency / n).toFixed(0);
  const dAvgLatency = (dynamindLatency / n).toFixed(0);
  lines.push(`  Avg Latency/task             ${bAvgLatency.padStart(6)}ms   ${dAvgLatency.padStart(6)}ms   ${Number(dAvgLatency) > Number(bAvgLatency) ? '+' : ''}${Number(dAvgLatency) - Number(bAvgLatency)}ms`);

  lines.push('');
  lines.push('HARNESS LIFT');
  lines.push('-'.repeat(70));

  const harnessLift = (dynamindScore - baselineScore) / n;
  const harnessLiftPct = ((dynamindScore - baselineScore) / (baselineScore || 1) * 100).toFixed(1);
  lines.push(`  Absolute lift:    +${harnessLift.toFixed(2)} points`);
  lines.push(`  Relative lift:    +${harnessLiftPct}%`);

  lines.push('');
  lines.push('SCENARIO BREAKDOWN');
  lines.push('-'.repeat(70));
  lines.push(`  Improved:   ${improved.length} scenarios (${improved.slice(0, 5).join(', ')}${improved.length > 5 ? '...' : ''})`);
  lines.push(`  Regressed:  ${regressed.length} scenarios (${regressed.slice(0, 5).join(', ')}${regressed.length > 5 ? '...' : ''})`);
  lines.push(`  Unchanged:  ${unchanged.length} scenarios`);
  lines.push('');

  // Per-scenario comparison
  lines.push('PER-SCENARIO DETAIL');
  lines.push('-'.repeat(70));
  lines.push('  Task ID                        Base    Dyna    Delta   Tokens(B/D)');
  lines.push('  ' + '-'.repeat(66));

  for (const id of [...allIds].sort()) {
    const b = baselineMap.get(id);
    const d = dynamindMap.get(id);
    if (!b && !d) continue;

    const bScore = b?.scores.task_success ?? -1;
    const dScore = d?.scores.task_success ?? -1;
    const delta = dScore >= 0 && bScore >= 0 ? dScore - bScore : 0;
    const deltaStr = delta >= 0 ? `+${delta.toFixed(2)}` : delta.toFixed(2);
    const bTokens = b ? b.tokens_in + b.tokens_out : 0;
    const dTokens = d ? d.tokens_in + d.tokens_out : 0;

    const bStr = bScore >= 0 ? bScore.toFixed(2) : 'N/A';
    const dStr = dScore >= 0 ? dScore.toFixed(2) : 'N/A';

    lines.push(`  ${id.padEnd(30)} ${bStr.padStart(5)}   ${dStr.padStart(5)}   ${deltaStr.padStart(6)}   ${String(bTokens).padStart(5)}/${String(dTokens).padStart(5)}`);
  }

  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Parse arguments
// ---------------------------------------------------------------------------

function parseArgs(args: string[]) {
  const result: {
    mode: 'baseline' | 'dynamind';
    family: string | null;
    families: string[];
    exclude: string[];
    suite: string | null;
    id: string | null;
    concurrency: number;
    list: boolean;
    compare: [string, string] | null;
    output: string;
    model: string | null;
  } = {
    mode: 'baseline',
    family: null,
    families: [],
    exclude: [],
    suite: null,
    id: null,
    concurrency: 2,
    list: false,
    compare: null,
    output: 'evals/output',
    model: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--list') result.list = true;
    else if (arg === '--mode' && args[i + 1]) result.mode = args[++i] as 'baseline' | 'dynamind';
    else if (arg === '--family' && args[i + 1]) result.family = args[++i];
    else if (arg === '--families' && args[i + 1]) result.families = args[++i].split(',').map(s => s.trim());
    else if (arg === '--exclude' && args[i + 1]) result.exclude = args[++i].split(',').map(s => s.trim());
    else if (arg === '--suite' && args[i + 1]) result.suite = args[++i];
    else if (arg === '--id' && args[i + 1]) result.id = args[++i];
    else if (arg === '--concurrency' && args[i + 1]) result.concurrency = parseInt(args[++i]) || 2;
    else if (arg === '--output' && args[i + 1]) result.output = args[++i];
    else if (arg === '--model' && args[i + 1]) result.model = args[++i];
    else if (arg === '--compare' && args[i + 1] && args[i + 2]) {
      result.compare = [args[++i], args[++i]];
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const opts = parseArgs(args);

  // --compare: compare two eval runs
  if (opts.compare) {
    const [baselinePath, dynamindPath] = opts.compare;
    const comparison = compareRuns(baselinePath, dynamindPath);
    console.log(comparison);
    return;
  }

  // --list: list all scenarios
  if (opts.list) {
    console.log('\nDynaMind Eval Scenarios\n');
    for (const [family, scenarios] of Object.entries(ALL_SCENARIOS)) {
      console.log(`  ${family} (${scenarios.length} scenarios)`);
      for (const s of scenarios) {
        console.log(`    - ${s.id}: ${s.name}`);
      }
    }
    console.log(`\n  Total: ${ALL_SCENARIOS_FLAT.length} scenarios\n`);
    return;
  }

  // Resolve model
  const model = opts.model ?? await resolveModel();
  console.log(`\n  Model: ${model}`);
  console.log(`  Mode: ${opts.mode}`);
  console.log(`  LM Studio: ${LM_STUDIO_URL}\n`);

  // Select scenarios
  let scenarios: EvalScenario[] = [];

  if (opts.family) {
    scenarios = getScenariosByFamily(opts.family as EvalFamily);
    console.log(`  Running family: ${opts.family} (${scenarios.length} scenarios)`);
  } else if (opts.families.length > 0) {
    const validFamilies = opts.families.filter(f => Object.keys(ALL_SCENARIOS).includes(f));
    if (validFamilies.length === 0) {
      console.error(`  No valid families found. Available: ${Object.keys(ALL_SCENARIOS).join(', ')}`);
      process.exit(1);
    }
    for (const f of validFamilies) {
      scenarios.push(...getScenariosByFamily(f as EvalFamily));
    }
    console.log(`  Running families: ${validFamilies.join(', ')} (${scenarios.length} scenarios)`);
  } else if (opts.suite) {
    scenarios = ALL_SCENARIOS_FLAT;
    console.log(`  Running full suite (${scenarios.length} scenarios)`);
  } else if (opts.id) {
    const scenario = getScenarioById(opts.id);
    if (!scenario) {
      console.error(`  Scenario not found: ${opts.id}`);
      process.exit(1);
    }
    scenarios = [scenario];
    console.log(`  Running single scenario: ${opts.id}`);
  } else {
    scenarios = ALL_SCENARIOS_FLAT;
    console.log(`  Running all scenarios (${scenarios.length} total)`);
  }

  // Apply --exclude filter
  if (opts.exclude.length > 0) {
    const before = scenarios.length;
    scenarios = scenarios.filter(s => !opts.exclude.includes(s.family));
    const removed = before - scenarios.length;
    if (removed > 0) {
      console.log(`  Excluded families: ${opts.exclude.join(', ')} (${removed} scenarios removed)`);
    }
  }

  if (scenarios.length === 0) {
    console.error('  No scenarios to run.');
    process.exit(1);
  }

  // Create runner
  const runner = new EvalRunner({
    concurrency: opts.concurrency,
    agent_name: opts.mode === 'dynamind' ? 'dynamind-full' : 'dynamind-baseline',
  });

  // Select agent runner based on mode
  let agentRunner: AgentRunner;
  if (opts.mode === 'dynamind') {
    console.log('  Bootstrapping full DynaMind agent runtime...\n');
    agentRunner = createDynaMindRunner({
      model,
      baseUrl: LM_STUDIO_URL,
      workspacePath: process.cwd(),
    });
  } else {
    agentRunner = createBaselineRunner(model);
  }

  // Progress tracking
  const onProgress = (done: number, total: number, trace: EvalTrace) => {
    const status = trace.passed ? 'PASS' : 'FAIL';
    const hardFails = trace.hard_failures.length > 0 ? ` [HARD: ${trace.hard_failures.join(',')}]` : '';
    const modeTag = opts.mode === 'dynamind' ? '[AGENT]' : '[BASE]';
    process.stdout.write(`\r  ${modeTag} [${done}/${total}] ${trace.task_id}: ${status} (${trace.latency_ms.toFixed(0)}ms)${hardFails}  `);
  };

  console.log('  Running...\n');

  // Run
  const traces = await runner.runSuite(scenarios, agentRunner, onProgress);

  // Generate report
  const suiteName = opts.suite ?? `trading-v1-${opts.mode}`;
  const report = generateReport(traces, suiteName);

  // Output
  console.log('\n');
  console.log(formatReport(report));

  // Save JSON trace
  const fs = await import('fs');
  const path = await import('path');
  const outDir = opts.output;
  const outPath = path.join(outDir, `${suiteName}-${Date.now()}.json`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, exportReportJson(report));
  console.log(`  Trace saved to: ${outPath}\n`);

  // If baseline mode, remind about comparison
  if (opts.mode === 'baseline') {
    console.log('  Tip: Run with --mode dynamind to compare harness lift.');
    console.log(`  Then: bun run evals/cli.ts --compare ${outPath} <dynamind-output.json>\n`);
  }
}

main().catch((err) => {
  console.error('Eval failed:', err);
  process.exit(1);
});
