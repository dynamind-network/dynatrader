/**
 * DynaMind Eval Suite — LLM Judge
 *
 * Used ONLY for qualitative assessments that deterministic evaluators cannot handle.
 * Wraps the project's ModelRouterImpl.
 */

import type { EvalScenario, TrajectoryStep } from './types';

// ---------------------------------------------------------------------------
// Judge Interface
// ---------------------------------------------------------------------------

export interface LLMJudgeConfig {
  baseUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface JudgeResult {
  score: number;       // 0-1
  reasoning: string;
  confidence: number;  // 0-1
}

// ---------------------------------------------------------------------------
// LLMJudge
// ---------------------------------------------------------------------------

export class LLMJudge {
  private baseUrl: string;
  private model: string;
  private temperature: number;
  private maxTokens: number;

  constructor(config?: LLMJudgeConfig) {
    this.baseUrl = config?.baseUrl ?? process.env['LM_STUDIO_BASE_URL'] ?? 'http://localhost:1234';
    this.model = config?.model ?? '';
    this.temperature = config?.temperature ?? 0.1;
    this.maxTokens = config?.maxTokens ?? 512;
  }

  /**
   * Judge whether the agent's reasoning is coherent and well-grounded.
   */
  async judgeReasoning(
    trajectory: TrajectoryStep[],
    scenario: EvalScenario,
  ): Promise<JudgeResult> {
    const reasoning = trajectory
      .filter(s => s.action === 'reasoning')
      .map(s => String(s.output ?? ''))
      .join('\n');

    if (!reasoning.trim()) {
      return { score: 0.3, reasoning: 'No reasoning found in trajectory', confidence: 0.8 };
    }

    const prompt = `You are evaluating a financial agent's reasoning quality.

TASK: ${scenario.task}

AGENT'S REASONING:
${reasoning}

SNAPSHOT CONTEXT:
${scenario.snapshot ? `Symbol: ${scenario.snapshot.symbol}, Price: $${scenario.snapshot.price}` : 'N/A'}

Score the reasoning on these dimensions (0-1 each):
1. logical_coherence: Does the reasoning flow logically?
2. evidence_usage: Does it cite actual data points?
3. uncertainty_expression: Does it express appropriate uncertainty?
4. bias_avoidance: Does it avoid anchoring or confirmation bias?

Respond in JSON: {"logical_coherence": 0.0, "evidence_usage": 0.0, "uncertainty_expression": 0.0, "bias_avoidance": 0.0, "reasoning": "your explanation"}`;

    return this.callJudge(prompt);
  }

  /**
   * Judge the quality of a trading thesis.
   */
  async judgeTradingThesis(
    decision: string,
    trajectory: TrajectoryStep[],
    scenario: EvalScenario,
  ): Promise<JudgeResult> {
    const reasoning = trajectory
      .filter(s => s.action === 'reasoning')
      .map(s => String(s.output ?? ''))
      .join('\n');

    const prompt = `You are evaluating a financial agent's trading thesis.

TASK: ${scenario.task}

AGENT'S DECISION: ${decision}

AGENT'S REASONING:
${reasoning}

MARKET CONTEXT:
${scenario.snapshot ? `Symbol: ${scenario.snapshot.symbol}, Price: $${scenario.snapshot.price}, Funding: ${scenario.snapshot.funding_rate}` : 'N/A'}

${scenario.portfolio ? `Portfolio: $${scenario.portfolio.equity}, Daily PnL: $${scenario.portfolio.daily_pnl}` : ''}

Score the trading thesis (0-1 each):
1. thesis_quality: Is the thesis well-reasoned and actionable?
2. risk_awareness: Does it consider risks appropriately?
3. market_context: Does it use relevant market data?
4. conviction_calibrated: Is conviction level appropriate given evidence?

Respond in JSON: {"thesis_quality": 0.0, "risk_awareness": 0.0, "market_context": 0.0, "conviction_calibrated": 0.0, "reasoning": "your explanation"}`;

    return this.callJudge(prompt);
  }

  /**
   * Judge multi-agent consensus quality.
   */
  async judgeConsensusQuality(
    agentReports: Array<{ agent: string; position: string; confidence: number }>,
    finalDecision: string,
  ): Promise<JudgeResult> {
    const reportsStr = agentReports
      .map(r => `  ${r.agent}: ${r.position} (confidence: ${r.confidence})`)
      .join('\n');

    const prompt = `You are evaluating how well a multi-agent system resolved a disagreement.

AGENT REPORTS:
${reportsStr}

FINAL DECISION: ${finalDecision}

Score the consensus resolution (0-1 each):
1. disagreement_handled: Did it properly acknowledge the disagreement?
2. authority_respected: Did it respect the risk agent's veto if present?
3. reasoning_quality: Is the resolution reasoning sound?
4. outcome_appropriateness: Is the final decision appropriate given the inputs?

Respond in JSON: {"disagreement_handled": 0.0, "authority_respected": 0.0, "reasoning_quality": 0.0, "outcome_appropriateness": 0.0, "reasoning": "your explanation"}`;

    return this.callJudge(prompt);
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async callJudge(prompt: string): Promise<JudgeResult> {
    try {
      const model = await this.resolveModel();
      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: 'You are a precise financial evaluation judge. Always respond in valid JSON.' },
            { role: 'user', content: prompt },
          ],
          max_tokens: this.maxTokens,
          temperature: this.temperature,
        }),
      });

      if (!response.ok) {
        return { score: 0.5, reasoning: `LLM judge HTTP ${response.status}`, confidence: 0.2 };
      }

      const data = await response.json() as {
        choices: Array<{ message: { content: string } }>;
      };

      const content = data.choices?.[0]?.message?.content ?? '';
      const parsed = this.parseJsonResponse(content);

      if (!parsed) {
        return { score: 0.5, reasoning: `Failed to parse LLM response: ${content.slice(0, 200)}`, confidence: 0.2 };
      }

      const scores = Object.entries(parsed)
        .filter(([k]) => k !== 'reasoning')
        .map(([, v]) => (typeof v === 'number' ? v : 0));

      const avgScore = scores.length > 0 ? scores.reduce((s, v) => s + v, 0) / scores.length : 0.5;

      return {
        score: Math.max(0, Math.min(1, avgScore)),
        reasoning: parsed.reasoning ?? 'No reasoning provided',
        confidence: 0.7,
      };
    } catch {
      return { score: 0.5, reasoning: 'LLM judge call failed', confidence: 0.1 };
    }
  }

  private parseJsonResponse(content: string): Record<string, unknown> | null {
    // Try direct parse
    try {
      return JSON.parse(content);
    } catch {
      // Try extracting JSON from markdown code block
      const match = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
      if (match) {
        try {
          return JSON.parse(match[1]);
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  private async resolveModel(): Promise<string> {
    if (this.model) return this.model;

    try {
      const res = await fetch(`${this.baseUrl}/v1/models`);
      if (!res.ok) return 'local-model';
      const data = await res.json() as { data?: Array<{ id?: string }> };
      return data?.data?.[0]?.id ?? 'local-model';
    } catch {
      return 'local-model';
    }
  }
}
