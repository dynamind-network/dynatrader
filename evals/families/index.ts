/**
 * DynaMind Eval Suite — Family Barrel Exports
 */

export { marketUnderstandingScenarios } from './1-market-understanding';
export { toolSelectionScenarios } from './2-tool-selection';
export { tradingDecisionScenarios } from './4-trading-decision';
export { multiAgentScenarios } from './7-multi-agent';
export { memoryScenarios } from './8-memory';

import { marketUnderstandingScenarios } from './1-market-understanding';
import { toolSelectionScenarios } from './2-tool-selection';
import { tradingDecisionScenarios } from './4-trading-decision';
import { multiAgentScenarios } from './7-multi-agent';
import { memoryScenarios } from './8-memory';

import type { EvalScenario } from '../harness/types';

/**
 * All scenarios grouped by family.
 */
export const ALL_SCENARIOS: Record<string, EvalScenario[]> = {
  market_understanding: marketUnderstandingScenarios,
  tool_selection: toolSelectionScenarios,
  trading_decision: tradingDecisionScenarios,
  multi_agent: multiAgentScenarios,
  memory: memoryScenarios,
};

/**
 * All scenarios as a flat list.
 */
export const ALL_SCENARIOS_FLAT: EvalScenario[] = [
  ...marketUnderstandingScenarios,
  ...toolSelectionScenarios,
  ...tradingDecisionScenarios,
  ...multiAgentScenarios,
  ...memoryScenarios,
];

/**
 * Get scenarios by family.
 */
export function getScenariosByFamily(family: string): EvalScenario[] {
  return ALL_SCENARIOS[family] ?? [];
}

/**
 * Get scenario by ID.
 */
export function getScenarioById(id: string): EvalScenario | undefined {
  return ALL_SCENARIOS_FLAT.find(s => s.id === id);
}

/**
 * Get all scenario IDs.
 */
export function getAllScenarioIds(): string[] {
  return ALL_SCENARIOS_FLAT.map(s => s.id);
}
