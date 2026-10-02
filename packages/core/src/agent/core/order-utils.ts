/**
 * Order generation and confidence calculation utilities.
 *
 * Extracted from AgentCore — pure functions that don't need class state.
 */

import type { SkillManifest, OrderIntent, RiskDecision, AgentTurnContext } from "@dyna/contracts";

/**
 * Generate order intents (entry, stop-loss, take-profit) from a strategy.
 */
export function generateOrderIntents(
  strategy: SkillManifest,
  context: AgentTurnContext,
): OrderIntent[] {
  const intents: OrderIntent[] = [];
  const size = calculateOrderSize(strategy);
  const exits = strategy.exits as Record<string, unknown> | undefined;

  // Entry intent
  intents.push({
    venue: strategy.venue,
    symbol: strategy.symbol,
    side: "buy",
    type: "market",
    quantity: size,
    strategyId: strategy.id,
    mode: context.mode,
  });

  // Stop loss only when the strategy explicitly defines one.
  if (typeof exits?.stopLoss === "number") {
    intents.push({
      venue: strategy.venue,
      symbol: strategy.symbol,
      side: "sell",
      type: "stop",
      quantity: size,
      price: exits.stopLoss,
      strategyId: strategy.id,
      mode: context.mode,
    });
  }

  // Take profit only when explicitly defined.
  if (typeof exits?.takeProfit === "number") {
    intents.push({
      venue: strategy.venue,
      symbol: strategy.symbol,
      side: "sell",
      type: "limit",
      quantity: size,
      price: exits.takeProfit,
      strategyId: strategy.id,
      mode: context.mode,
    });
  }

  return intents;
}

/**
 * Calculate order size from strategy sizing parameters.
 */
export function calculateOrderSize(strategy: SkillManifest): number {
  const sizing = strategy.sizing as { amount?: number; percentage?: number };
  if (typeof sizing.amount === "number" && sizing.amount > 0) return sizing.amount;
  if (typeof sizing.percentage === "number") {
    throw new Error("Percentage sizing must be resolved upstream into an explicit amount");
  }
  throw new Error("Strategy sizing must define an explicit amount");
}

/**
 * Calculate confidence score from validation and risk results.
 */
export function calculateConfidence(
  validation: Array<{ level: string; message: string }>,
  riskDecision: { decision: string; reasons: string[] },
  riskDecisions: RiskDecision[],
): number {
  let confidence = 0.5; // Base confidence

  // Boost for validation
  const errors = validation.filter(v => v.level === "error").length;
  confidence -= errors * 0.1;

  // Boost for approved strategies
  if (riskDecision.decision === "approved") confidence += 0.3;
  else if (riskDecision.decision === "manual-approval") confidence += 0.1;

  // Boost for approved orders
  const approvedOrders = riskDecisions.filter(d => d.decision === "approved").length;
  confidence += Math.min(approvedOrders * 0.1, 0.2);

  return Math.max(0, Math.min(1, confidence));
}

/**
 * Generate analysis text summarizing a strategy iteration.
 */
export function generateAnalysis(
  strategy: SkillManifest,
  riskDecision: { decision: string; reasons: string[] },
  orders: OrderIntent[],
  llmAnalysis?: string,
): string {
  let analysis = "";

  // Start with LLM analysis if available
  if (llmAnalysis) {
    analysis += `--- Market Analysis ---\n${llmAnalysis.substring(0, 500)}\n\n`;
  }

  analysis += `--- Strategy ---\nID: ${strategy.id}\n`;
  analysis += `Symbol: ${strategy.symbol} (${strategy.venue})\n`;
  analysis += `Risk Decision: ${riskDecision.decision}\n`;

  if (riskDecision.reasons.length > 0) {
    analysis += `Reasons: ${riskDecision.reasons.join(", ")}\n`;
  }

  analysis += `\nOrders generated: ${orders.length}\n`;

  if (orders.length > 0) {
    analysis += `Order types: ${orders.map(o => o.type).join(", ")}\n`;
    analysis += `Total position: ${orders.reduce((sum, o) => sum + o.quantity, 0)} ${strategy.symbol.split('/')[0]}\n`;
  }

  return analysis;
}

/**
 * Build context messages array for compaction check.
 */
export function buildContextMessages(
  context: AgentTurnContext,
  memoryContext: string,
): Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string }> {
  const messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string }> = [];

  // Add memory context as system message
  if (memoryContext) {
    messages.push({ role: 'system', content: memoryContext });
  }

  // Add turn context as user message
  messages.push({
    role: 'user',
    content: JSON.stringify({
      mode: context.mode,
      accountId: context.accountId,
      portfolioId: context.portfolioId,
    }),
  });

  return messages;
}
