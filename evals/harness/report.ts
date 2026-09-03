/**
 * DynaMind Eval Suite — Report Generator
 *
 * Aggregates EvalTraces into a structured EvalReport.
 */

import type {
  EvalTrace,
  EvalReport,
  EvalFamily,
} from './types';

// ---------------------------------------------------------------------------
// Report Generation
// ---------------------------------------------------------------------------

const ALL_FAMILIES: EvalFamily[] = [
  'market_understanding',
  'tool_selection',
  'trading_decision',
  'multi_agent',
  'memory',
];

export function generateReport(
  traces: EvalTrace[],
  suiteName: string,
): EvalReport {
  const timestamp = new Date().toISOString();
  const model = traces[0]?.model ?? 'unknown';
  const agent = traces[0]?.agent ?? 'unknown';

  // Summary
  const total = traces.length;
  const passed = traces.filter(t => t.passed).length;
  const failed = total - passed;
  const hardFailures = traces.filter(t => t.hard_failures.length > 0).length;
  const passRate = total > 0 ? passed / total : 0;

  // Family scores
  const familyScores = computeFamilyScores(traces);

  // Cross-cutting
  const crossCutting = computeCrossCutting(traces);

  // Overall score (weighted average across families)
  const overallScore = computeOverallScore(familyScores);

  return {
    suite_name: suiteName,
    timestamp,
    model,
    agent,
    traces,
    summary: {
      total,
      passed,
      failed,
      hard_failures: hardFailures,
      pass_rate: passRate,
    },
    family_scores: familyScores,
    cross_cutting: crossCutting,
    overall_score: overallScore,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatReport(report: EvalReport): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('╔══════════════════════════════════════════════════════════════╗');
  lines.push('║              DYNAMIND AGENT EVALUATION                      ║');
  lines.push('╚══════════════════════════════════════════════════════════════╝');
  lines.push('');
  lines.push(`  Suite:       ${report.suite_name}`);
  lines.push(`  Agent:       ${report.agent}`);
  lines.push(`  Model:       ${report.model}`);
  lines.push(`  Timestamp:   ${report.timestamp}`);
  lines.push('');
  lines.push('  ── Summary ─────────────────────────────────────────────');
  lines.push(`  Total:       ${report.summary.total}`);
  lines.push(`  Passed:      ${report.summary.passed}`);
  lines.push(`  Failed:      ${report.summary.failed}`);
  lines.push(`  Hard Fails:  ${report.summary.hard_failures}`);
  lines.push(`  Pass Rate:   ${(report.summary.pass_rate * 100).toFixed(1)}%`);
  lines.push('');

  // Family scores
  lines.push('  ── Family Scores ───────────────────────────────────────');
  for (const [family, scores] of Object.entries(report.family_scores)) {
    if (scores.count === 0) continue;
    const bar = progressBar(scores.avg_task_success);
    lines.push(`  ${family.padEnd(24)} ${bar} ${(scores.avg_task_success * 100).toFixed(1)}%`);
  }
  lines.push('');

  // Cross-cutting
  lines.push('  ── Performance ─────────────────────────────────────────');
  lines.push(`  Avg Cost:        $${report.cross_cutting.avg_cost_usd.toFixed(4)}`);
  lines.push(`  Avg Latency:     ${report.cross_cutting.avg_latency_ms.toFixed(0)}ms`);
  lines.push(`  Avg Tokens:      ${report.cross_cutting.avg_tokens.toFixed(0)}`);
  lines.push(`  Avg Tool Calls:  ${report.cross_cutting.avg_tool_calls.toFixed(1)}`);
  lines.push(`  Total Cost:      $${report.cross_cutting.total_cost_usd.toFixed(4)}`);
  lines.push(`  Total Latency:   ${(report.cross_cutting.total_latency_ms / 1000).toFixed(1)}s`);
  lines.push('');

  // Overall
  lines.push('  ── Overall ────────────────────────────────────────────');
  const overallBar = progressBar(report.overall_score);
  lines.push(`  Score:  ${overallBar} ${(report.overall_score * 100).toFixed(1)}%`);
  lines.push('');

  // Hard failures detail
  const hardFails = report.traces.filter(t => t.hard_failures.length > 0);
  if (hardFails.length > 0) {
    lines.push('  ── Hard Failures ──────────────────────────────────────');
    for (const t of hardFails) {
      lines.push(`  ${t.task_id}: ${t.hard_failures.join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// JSON Export
// ---------------------------------------------------------------------------

export function exportReportJson(report: EvalReport): string {
  return JSON.stringify(report, null, 2);
}

// ---------------------------------------------------------------------------
// Private
// ---------------------------------------------------------------------------

function computeFamilyScores(traces: EvalTrace[]): EvalReport['family_scores'] {
  const result = {} as EvalReport['family_scores'];

  for (const family of ALL_FAMILIES) {
    const familyTraces = traces.filter(t => t.family === family);
    if (familyTraces.length === 0) {
      result[family] = {
        count: 0,
        avg_task_success: 0,
        avg_family_specific: {},
      };
      continue;
    }

    const avg = (fn: (t: EvalTrace) => number) =>
      familyTraces.reduce((s, t) => s + fn(t), 0) / familyTraces.length;

    // Aggregate family-specific scores
    const allFamilyKeys = new Set<string>();
    for (const t of familyTraces) {
      for (const key of Object.keys(t.scores.family_specific)) {
        allFamilyKeys.add(key);
      }
    }
    const avgFamilySpecific: Record<string, number> = {};
    for (const key of allFamilyKeys) {
      avgFamilySpecific[key] = avg(t => t.scores.family_specific[key] ?? 0);
    }

    result[family] = {
      count: familyTraces.length,
      avg_task_success: avg(t => t.scores.task_success),
      avg_family_specific: avgFamilySpecific,
    };
  }

  return result;
}

function computeCrossCutting(traces: EvalTrace[]): EvalReport['cross_cutting'] {
  if (traces.length === 0) {
    return {
      avg_cost_usd: 0,
      avg_latency_ms: 0,
      avg_tokens: 0,
      avg_tool_calls: 0,
      total_cost_usd: 0,
      total_latency_ms: 0,
    };
  }

  const totalCost = traces.reduce((s, t) => s + t.cost_usd, 0);
  const totalLatency = traces.reduce((s, t) => s + t.latency_ms, 0);
  const totalTokens = traces.reduce((s, t) => s + t.tokens_in + t.tokens_out, 0);
  const totalToolCalls = traces.reduce((s, t) => s + t.tool_calls, 0);

  return {
    avg_cost_usd: totalCost / traces.length,
    avg_latency_ms: totalLatency / traces.length,
    avg_tokens: totalTokens / traces.length,
    avg_tool_calls: totalToolCalls / traces.length,
    total_cost_usd: totalCost,
    total_latency_ms: totalLatency,
  };
}

function computeOverallScore(
  familyScores: EvalReport['family_scores'],
): number {
  const weights: Partial<Record<EvalFamily, number>> = {
    market_understanding: 0.12,
    tool_selection: 0.12,
    trading_decision: 0.15,
    multi_agent: 0.08,
    memory: 0.05,
  };

  let weightedSum = 0;
  let totalWeight = 0;

  for (const [family, weight] of Object.entries(weights)) {
    const scores = familyScores[family as EvalFamily];
    if (scores && scores.count > 0) {
      weightedSum += scores.avg_task_success * weight;
      totalWeight += weight;
    }
  }

  const base = totalWeight > 0 ? weightedSum / totalWeight : 0;
  return Math.max(0, Math.min(1, base));
}

function progressBar(score: number, width: number = 20): string {
  const filled = Math.round(score * width);
  const empty = width - filled;
  return `[${'#'.repeat(filled)}${'-'.repeat(empty)}]`;
}
