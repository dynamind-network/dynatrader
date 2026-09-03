/**
 * CLI Command: pipeline
 */

import type { DynaTraderRuntime, PipelineResult } from '@dyna/orchestration/workspace';
import { bold, cyan, green, red, yellow, dim, formatCurrency, formatDuration, printSeparator } from './utils';

// ---------------------------------------------------------------------------
// Typed output shapes for each pipeline phase
// ---------------------------------------------------------------------------

interface ResearchHypothesis {
  type: string;
  direction: string;
  confidence: number;
}

interface ResearchOutput {
  confidence?: number;
  hypotheses?: ResearchHypothesis[];
}

interface AnalysisSignal {
  type: string;
  confidence: number;
}

interface AnalysisOutput {
  indicators?: Record<string, unknown>;
  signals?: AnalysisSignal[];
  sentiment?: string;
  fearGreedIndex?: number;
}

interface RiskOutput {
  riskScore?: number;
  riskLevel?: string;
  stopLoss?: number;
  takeProfit?: number;
  maxPositionSize?: number;
  recommendation?: string;
}

export async function cmdPipeline(
  runtime: DynaTraderRuntime,
  mode: 'research' | 'backtest' | 'paper' | 'live',
): Promise<void> {
  console.log();
  console.log(bold(cyan('Running multi-agent trading pipeline...')));
  console.log(dim(`Mode: ${mode}`));
  console.log();

  const pipeline = runtime.getPipeline();

  console.log(dim('Phase 1/4: Research'));
  console.log(dim('Phase 2/4: Analysis'));
  console.log(dim('Phase 3/4: Risk Evaluation'));
  console.log(dim('Phase 4/4: Decision Synthesis'));
  console.log();

  let result: PipelineResult;
  try {
    result = await pipeline.execute();
  } catch (err) {
    console.log(red(`Pipeline failed: ${(err as Error).message}`));
    console.log();
    return;
  }

  console.log(dim(`Selected market: ${result.symbol}`));
  console.log(dim(`Execution cadence: ${result.timeframe}`));
  console.log();

  // --- Research Phase ---
  console.log(bold(cyan('Research Phase')));
  printSeparator();
  console.log(`  Pattern:    ${result.research.pattern}`);
  console.log(`  Steps:      ${Object.keys(result.research.agentOutputs).length}`);
  console.log(`  Duration:   ${formatDuration(result.research.executionTimeMs)}`);
  const researchOut = result.research.finalOutput as ResearchOutput | undefined;
  if (researchOut) {
    if (researchOut.confidence != null) {
      console.log(`  Confidence: ${researchOut.confidence.toFixed(2)}`);
    }
    if (researchOut.hypotheses) {
      console.log('  Hypotheses:');
      for (const h of researchOut.hypotheses) {
        const dirColor = h.direction === 'bullish' ? green : h.direction === 'bearish' ? red : yellow;
        console.log(`    - ${h.type}: ${dirColor(h.direction)} (${h.confidence.toFixed(2)})`);
      }
    }
  }
  console.log();

  // --- Analysis Phase ---
  console.log(bold(cyan('Analysis Phase')));
  printSeparator();
  console.log(`  Pattern:    ${result.analysis.pattern}`);
  console.log(`  Steps:      ${Object.keys(result.analysis.agentOutputs).length}`);
  console.log(`  Duration:   ${formatDuration(result.analysis.executionTimeMs)}`);
  const analysisOut = result.analysis.finalOutput as AnalysisOutput | undefined;
  if (analysisOut) {
    if (analysisOut.indicators) {
      console.log('  Indicators:');
      for (const [key, val] of Object.entries(analysisOut.indicators)) {
        console.log(`    ${key}: ${val}`);
      }
    }
    if (analysisOut.signals) {
      console.log('  Signals:');
      for (const s of analysisOut.signals) {
        const sigColor = s.type === 'BUY' ? green : s.type === 'SELL' ? red : yellow;
        console.log(`    - ${sigColor(s.type)} (${s.confidence.toFixed(2)})`);
      }
    }
    if (analysisOut.sentiment) {
      console.log(`  Sentiment:  ${analysisOut.sentiment}`);
    }
    if (analysisOut.fearGreedIndex != null) {
      console.log(`  Fear/Greed: ${analysisOut.fearGreedIndex}`);
    }
  }
  console.log();

  // --- Risk Phase ---
  console.log(bold(cyan('Risk Evaluation')));
  printSeparator();
  console.log(`  Pattern:    ${result.risk.pattern}`);
  console.log(`  Steps:      ${Object.keys(result.risk.agentOutputs).length}`);
  console.log(`  Duration:   ${formatDuration(result.risk.executionTimeMs)}`);
  const riskOut = result.risk.finalOutput as RiskOutput | undefined;
  if (riskOut) {
    const recColor = riskOut.recommendation === 'APPROVED' ? green : red;
    console.log(`  Risk Score: ${riskOut.riskScore?.toFixed(2) ?? 'N/A'}`);
    console.log(`  Risk Level: ${riskOut.riskLevel ?? 'N/A'}`);
    console.log(`  Stop Loss:  ${riskOut.stopLoss != null ? formatCurrency(riskOut.stopLoss) : 'N/A'}`);
    console.log(`  Take Profit:${riskOut.takeProfit != null ? ' ' + formatCurrency(riskOut.takeProfit) : ' N/A'}`);
    console.log(`  Max Size:   ${riskOut.maxPositionSize != null ? (riskOut.maxPositionSize * 100).toFixed(1) + '%' : 'N/A'}`);
    console.log(`  Decision:   ${recColor(riskOut.recommendation ?? 'UNKNOWN')}`);
  }
  console.log();

  // --- Final Decision ---
  console.log(bold(cyan('Final Decision')));
  printSeparator();
  const decisionColor =
    result.decision.action === 'BUY'
      ? green
      : result.decision.action === 'SELL'
        ? red
        : yellow;
  console.log(`  Action:     ${bold(decisionColor(result.decision.action))}`);
  console.log(`  Confidence: ${result.decision.confidence.toFixed(2)}`);
  console.log(`  Reasoning:  ${dim(result.decision.reasoning)}`);
  console.log();

  // --- Summary ---
  console.log(dim(`Pipeline completed in ${formatDuration(result.totalExecutionTimeMs)}`));
  console.log(
    dim(
      `Total agents: ${Object.keys(result.research.agentOutputs).length + Object.keys(result.analysis.agentOutputs).length + Object.keys(result.risk.agentOutputs).length}`,
    ),
  );
  console.log();
}
