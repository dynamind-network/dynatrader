/**
 * A2A & Subagent Spawning Benchmark
 *
 * Measures:
 *   1. Raw LM Studio latency (baseline)
 *   2. Subagent spawning (in-process executeAgent)
 *   3. A2A sendAndReceive (request/response)
 *   4. A2A pingPong (multi-turn)
 *   5. Concurrent subagent spawning (parallel)
 *
 * Usage: bun run workspace/benchmarks/a2a-subagent-bench.ts
 */

import { LMStudioProvider } from '../../src/orchestration/models/providers/lmstudio';
import { A2ARuntime } from '../../src/orchestration/a2a/a2a-runtime';
import { SubagentGatewayClient } from '../../src/runtime/subagents/subagent-gateway-client';
import type { ModelRequest } from '../../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface BenchResult {
  name: string;
  iterations: number;
  totalMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  tokensPerSec?: number;
  errors: number;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function formatResult(r: BenchResult): string {
  const lines = [
    `\n  ${r.name}`,
    `  ${'─'.repeat(r.name.length)}`,
    `  Iterations:  ${r.iterations}`,
    `  Total:       ${r.totalMs.toFixed(0)}ms`,
    `  Avg:         ${r.avgMs.toFixed(1)}ms`,
    `  Min:         ${r.minMs.toFixed(1)}ms`,
    `  Max:         ${r.maxMs.toFixed(1)}ms`,
    `  P50:         ${r.p50Ms.toFixed(1)}ms`,
    `  P95:         ${r.p95Ms.toFixed(1)}ms`,
    `  P99:         ${r.p99Ms.toFixed(1)}ms`,
    `  Errors:      ${r.errors}`,
  ];
  if (r.tokensPerSec) {
    lines.push(`  Tokens/sec:  ${r.tokensPerSec.toFixed(1)}`);
  }
  return lines.join('\n');
}

function benchResult(name: string, timings: number[], errors: number, totalTokens?: number): BenchResult {
  const sorted = [...timings].sort((a, b) => a - b);
  const totalMs = sorted.reduce((s, v) => s + v, 0);
  const tokensPerSec = totalTokens && totalMs > 0
    ? (totalTokens / (totalMs / 1000))
    : undefined;
  return {
    name,
    iterations: sorted.length,
    totalMs,
    avgMs: totalMs / sorted.length,
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    tokensPerSec,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Bench 1: Raw LM Studio latency
// ---------------------------------------------------------------------------

async function benchRawLatency(provider: LMStudioProvider, iterations: number): Promise<BenchResult> {
  const timings: number[] = [];
  let errors = 0;
  let totalTokens = 0;

  for (let i = 0; i < iterations; i++) {
    const request: ModelRequest = {
      messages: [
        { role: 'system', content: 'You are a concise assistant. Reply in one sentence.' },
        { role: 'user', content: `What is ${(i + 1)} * ${(i + 1)}?` },
      ],
      maxTokens: 64,
      temperature: 0.0,
    };

    try {
      const start = performance.now();
      const response = await provider.call(request);
      const elapsed = performance.now() - start;
      timings.push(elapsed);
      totalTokens += response.usage.completionTokens;
    } catch {
      errors++;
    }
  }

  return benchResult('1. Raw LM Studio Latency', timings, errors, totalTokens);
}

// ---------------------------------------------------------------------------
// Bench 2: Subagent Spawning (in-process)
// ---------------------------------------------------------------------------

async function benchSubagentSpawn(
  subagentRuntime: {
    executeAgent(name: string, mode: string, input: unknown): Promise<{
      agentName: string;
      mode: string;
      depth: number;
      maxDepth: number;
      permissions: { allowedTools: string[]; allowedSkills: string[]; memoryAccess: { read: string[]; write: string[] } };
    }>;
  },
  iterations: number,
): Promise<BenchResult> {
  const timings: number[] = [];
  let errors = 0;

  for (let i = 0; i < iterations; i++) {
    try {
      const start = performance.now();
      await subagentRuntime.executeAgent('explore', 'paper', {
        goal: `Test task ${i}: list files in the workspace`,
        context: 'Benchmark run',
      });
      const elapsed = performance.now() - start;
      timings.push(elapsed);
    } catch {
      errors++;
    }
  }

  return benchResult('2. Subagent Spawn (in-process)', timings, errors);
}

// ---------------------------------------------------------------------------
// Bench 3: A2A sendAndReceive
// ---------------------------------------------------------------------------

async function benchA2ASendAndReceive(
  a2aRuntime: A2ARuntime,
  iterations: number,
): Promise<BenchResult> {
  const timings: number[] = [];
  let errors = 0;

  for (let i = 0; i < iterations; i++) {
    try {
      const start = performance.now();
      await a2aRuntime.sendAndReceive({
        targetAgentId: 'explore',
        message: `Benchmark A2A task ${i}: what is the current time?`,
      });
      const elapsed = performance.now() - start;
      timings.push(elapsed);
    } catch {
      errors++;
    }
  }

  return benchResult('3. A2A sendAndReceive', timings, errors);
}

// ---------------------------------------------------------------------------
// Bench 4: A2A pingPong (multi-turn)
// ---------------------------------------------------------------------------

async function benchA2APingPong(
  a2aRuntime: A2ARuntime,
  turns: number,
): Promise<BenchResult> {
  const timings: number[] = [];
  let errors = 0;

  try {
    const start = performance.now();
    await a2aRuntime.pingPong({
      targetAgentId: 'explore',
      initialMessage: 'Start a multi-turn conversation. Say "turn 1" and ask me to continue.',
      maxTurns: turns,
    });
    const elapsed = performance.now() - start;
    timings.push(elapsed);
  } catch {
    errors++;
  }

  return benchResult(`4. A2A pingPong (${turns} turns)`, timings, errors);
}

// ---------------------------------------------------------------------------
// Bench 5: Concurrent subagent spawning
// ---------------------------------------------------------------------------

async function benchConcurrentSpawns(
  subagentRuntime: {
    executeAgent(name: string, mode: string, input: unknown): Promise<{
      agentName: string;
      mode: string;
      depth: number;
      maxDepth: number;
      permissions: { allowedTools: string[]; allowedSkills: string[]; memoryAccess: { read: string[]; write: string[] } };
    }>;
  },
  concurrency: number,
  totalTasks: number,
): Promise<BenchResult> {
  const timings: number[] = [];
  let errors = 0;

  const start = performance.now();

  // Process in batches of `concurrency`
  for (let batch = 0; batch < totalTasks; batch += concurrency) {
    const batchSize = Math.min(concurrency, totalTasks - batch);
    const promises = Array.from({ length: batchSize }, (_, i) => {
      const taskIdx = batch + i;
      const taskStart = performance.now();
      return subagentRuntime
        .executeAgent('explore', 'paper', {
          goal: `Concurrent task ${taskIdx}`,
          context: 'Benchmark',
        })
        .then(() => {
          timings.push(performance.now() - taskStart);
        })
        .catch(() => {
          errors++;
          timings.push(performance.now() - taskStart);
        });
    });

    await Promise.all(promises);
  }

  const totalMs = performance.now() - start;

  const sorted = [...timings].sort((a, b) => a - b);
  return {
    name: `5. Concurrent Subagent Spawns (${concurrency} parallel, ${totalTasks} total)`,
    iterations: timings.length,
    totalMs,
    avgMs: timings.reduce((s, v) => s + v, 0) / timings.length,
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    errors,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  A2A & Subagent Spawning Benchmark                 ║');
  console.log('║  LM Studio Backend                                 ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  // Check LM Studio is reachable
  const baseUrl = process.env['LM_STUDIO_BASE_URL'] ?? 'http://localhost:1234';
  console.log(`\n  LM Studio: ${baseUrl}`);

  try {
    const healthRes = await fetch(`${baseUrl}/v1/models`);
    if (!healthRes.ok) throw new Error(`HTTP ${healthRes.status}`);
    const data = await healthRes.json() as { data?: Array<{ id?: string }> };
    const models = data?.data ?? [];
    const modelId = models[0]?.id ?? 'unknown';
    console.log(`  Model:     ${modelId}`);
    console.log(`  Status:    Connected`);
  } catch {
    console.error('\n  ERROR: Cannot reach LM Studio. Is it running?');
    console.error(`  Tried: ${baseUrl}/v1/models`);
    process.exit(1);
  }

  const provider = new LMStudioProvider({ baseUrl, maxTokens: 128, temperature: 0.0 });

  const results: BenchResult[] = [];

  // --- 1. Raw LM Studio Latency ---
  console.log('\n  Running: Raw LM Studio Latency (10 iterations)...');
  results.push(await benchRawLatency(provider, 10));

  // --- Setup SubagentRuntime & A2ARuntime ---
  // We use a minimal mock that wraps the actual SubagentRuntime for benchmarks
  // without needing full workspace init (which would load agents/policies).
  const mockSubagentRuntime = {
    async executeAgent(_name: string, _mode: string, _input: unknown) {
      // Simulate a subagent execution with a real LM Studio call
      const request: ModelRequest = {
        messages: [
          { role: 'system', content: 'You are a helpful agent. Reply briefly.' },
          { role: 'user', content: typeof _input === 'object' && _input !== null ? String((_input as Record<string, unknown>).goal ?? 'hello') : 'hello' },
        ],
        maxTokens: 64,
        temperature: 0.0,
      };
      await provider.call(request);
      return {
        agentName: _name,
        mode: _mode,
        depth: 1,
        maxDepth: 2,
        permissions: { allowedTools: [], allowedSkills: [], memoryAccess: { read: [], write: [] } },
      };
    },
    getLastOutput() {
      return null;
    },
  };

  // --- 2. Subagent Spawning ---
  console.log('  Running: Subagent Spawn (5 iterations)...');
  results.push(await benchSubagentSpawn(mockSubagentRuntime, 5));

  // --- 3. A2A sendAndReceive ---
  const gatewayClient = new SubagentGatewayClient(mockSubagentRuntime as never);
  const a2aRuntime = new A2ARuntime({
    policy: { enabled: false, allow: ['*'], maxPingPongTurns: 5, visibility: 'public' },
    gateway: gatewayClient,
    agentId: 'bench-main',
  });

  console.log('  Running: A2A sendAndReceive (5 iterations)...');
  results.push(await benchA2ASendAndReceive(a2aRuntime, 5));

  // --- 4. A2A pingPong ---
  console.log('  Running: A2A pingPong (3 turns)...');
  results.push(await benchA2APingPong(a2aRuntime, 3));

  // --- 5. Concurrent subagent spawning ---
  console.log('  Running: Concurrent spawns (3 parallel, 9 total)...');
  results.push(await benchConcurrentSpawns(mockSubagentRuntime, 3, 9));

  // --- Report ---
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  RESULTS                                            ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  for (const r of results) {
    console.log(formatResult(r));
  }

  console.log('\n  Done.\n');
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
