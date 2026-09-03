export interface IntentRoute {
  intent: 'coding' | 'market_data' | 'portfolio' | 'general';
  useTools: boolean;
  shouldPlan: boolean;
  rationale: string;
  preferredTools: string[];
}

/**
 * Normalize raw LLM intent routing output into a validated IntentRoute.
 * Returns null if the intent value is invalid.
 */
export function normalizeIntentRoute(input: Record<string, unknown>): IntentRoute | null {
  const intentValue = input.intent;
  const intent =
    intentValue === 'coding' ||
    intentValue === 'market_data' ||
    intentValue === 'portfolio' ||
    intentValue === 'general'
      ? intentValue
      : null;

  if (!intent) {
    return null;
  }

  const useTools = typeof input.useTools === 'boolean' ? input.useTools : intent !== 'general';
  const shouldPlan = typeof input.shouldPlan === 'boolean' ? input.shouldPlan : false;
  const rationale =
    typeof input.rationale === 'string' && input.rationale.trim()
      ? input.rationale.trim()
      : 'Route selected by the model.';
  const preferredTools = Array.isArray(input.preferredTools)
    ? input.preferredTools.filter(
        (tool): tool is string => typeof tool === 'string' && tool.trim().length > 0
      )
    : [];

  return {
    intent,
    useTools,
    shouldPlan,
    rationale,
    preferredTools,
  };
}
