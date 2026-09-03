/**
 * Intent Router - Classifies user messages into intent categories
 * and adjusts budgets/guidance accordingly.
 *
 * Uses keyword-based classification (fast, no LLM call needed).
 */

export interface IntentRoute {
  intent: 'trading' | 'coding' | 'market_data' | 'portfolio' | 'general';
  useTools: boolean;
  shouldPlan: boolean;
  rationale: string;
  preferredTools: string[];
}

export interface TurnBudget {
  maxToolCallsPerTurn: number;
  maxTurns: number;
}

const INTENT_PATTERNS: Record<IntentRoute['intent'], { keywords: string[]; tools: string[]; budget: TurnBudget }> = {
  trading: {
    keywords: ['trade', 'trading', 'buy', 'sell', 'order', 'position', 'strategy', 'backtest', 'signal', 'entry', 'exit', 'stop loss', 'take profit', 'pnl', 'profit', 'loss'],
    tools: ['compile_strategy', 'evaluate_risk', 'generate_order', 'backtest', 'market_data'],
    budget: { maxToolCallsPerTurn: 10, maxTurns: 30 },
  },
  market_data: {
    keywords: ['price', 'chart', 'candle', 'ohlc', 'volume', 'indicator', 'rsi', 'macd', 'ema', 'sma', 'bollinger', 'market', 'ticker', 'quote'],
    tools: ['market_data', 'indicators', 'backtest'],
    budget: { maxToolCallsPerTurn: 8, maxTurns: 15 },
  },
  portfolio: {
    keywords: ['portfolio', 'balance', 'equity', 'allocation', 'diversif', 'risk', 'exposure', 'drawdown', 'sharpe', 'sortino'],
    tools: ['market_data', 'portfolio_analysis', 'risk_assessment'],
    budget: { maxToolCallsPerTurn: 8, maxTurns: 20 },
  },
  coding: {
    keywords: ['code', 'function', 'class', 'implement', 'debug', 'refactor', 'typescript', 'python', 'script', 'file', 'read', 'write', 'create'],
    tools: ['read', 'write', 'edit', 'glob', 'grep', 'exec'],
    budget: { maxToolCallsPerTurn: 15, maxTurns: 50 },
  },
  general: {
    keywords: [],
    tools: [],
    budget: { maxToolCallsPerTurn: 8, maxTurns: 30 },
  },
};

export class IntentRouter {
  private lastRoute: IntentRoute | null = null;

  /**
   * Classify user intent from message text.
   * Uses keyword matching (fast, no LLM call needed).
   */
  classify(userMessage: string): IntentRoute {
    const lower = userMessage.toLowerCase();
    const scores: Record<string, number> = {};

    for (const [intent, config] of Object.entries(INTENT_PATTERNS)) {
      if (intent === 'general') continue;
      let score = 0;
      for (const keyword of config.keywords) {
        if (lower.includes(keyword)) score++;
      }
      if (score > 0) scores[intent] = score;
    }

    // Pick highest scoring intent, default to general
    let bestIntent: IntentRoute['intent'] = 'general';
    let bestScore = 0;
    for (const [intent, score] of Object.entries(scores)) {
      if (score > bestScore) {
        bestScore = score;
        bestIntent = intent as IntentRoute['intent'];
      }
    }

    const config = INTENT_PATTERNS[bestIntent];
    const route: IntentRoute = {
      intent: bestIntent,
      useTools: config.tools.length > 0,
      shouldPlan: bestIntent === 'trading' || bestIntent === 'coding',
      rationale: bestScore > 0
        ? `Matched ${bestScore} keyword(s) for "${bestIntent}" intent`
        : 'No specific intent detected, using general mode',
      preferredTools: config.tools,
    };

    this.lastRoute = route;
    return route;
  }

  /** Get budget for a given intent */
  getBudget(intent: IntentRoute['intent']): TurnBudget {
    return INTENT_PATTERNS[intent]?.budget ?? INTENT_PATTERNS.general.budget;
  }

  /** Get route guidance text to inject into system prompt */
  getRouteGuidance(route: IntentRoute): string {
    if (route.intent === 'general') {
      return 'Respond to the user\'s question directly. Use tools if they would help.';
    }
    const toolList = route.preferredTools.length > 0
      ? `Preferred tools: ${route.preferredTools.join(', ')}`
      : '';
    return `Intent: ${route.intent}. ${toolList} ${route.rationale}. Adjust your approach accordingly.`;
  }

  /** Get the last classified route */
  getLastRoute(): IntentRoute | null { return this.lastRoute; }
}
