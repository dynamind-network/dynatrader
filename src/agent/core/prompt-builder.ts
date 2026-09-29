/**
 * Prompt Builder
 *
 * Constructs prompts for agent reasoning with context and constraints
 */

import type { StrategySource, AgentTurnContext } from "@dyna/contracts";
import type { ContextState } from "./context-engine";
import { IterationBudget } from "./iteration-budget";

export interface PromptTemplate {
  system: string;
  user: (context: PromptContext) => string;
  constraints?: string[];
}

export interface PromptContext {
  currentContext: AgentTurnContext;
  memoryContext: string;
  strategySource: StrategySource;
  budgetState: ReturnType<IterationBudget["getUsage"]>;
  iteration: number;
  maxIterations: number;
}

export class PromptBuilder {
  private templates: Map<string, PromptTemplate> = new Map();

  constructor() {
    this.registerDefaultTemplates();
  }

  /**
   * Get template by name
   */
  getTemplate(name: string): PromptTemplate | undefined {
    return this.templates.get(name);
  }

  /**
   * Return the registered template names in insertion order.
   */
  listTemplateNames(): string[] {
    return Array.from(this.templates.keys());
  }

  /**
   * Check whether a template exists.
   */
  hasTemplate(name: string): boolean {
    return this.templates.has(name);
  }

  /**
   * Register a template
   */
  registerTemplate(name: string, template: PromptTemplate): void {
    this.templates.set(name, template);
  }

  /**
   * Build user prompt
   */
  buildPrompt(
    templateName: string,
    context: AgentTurnContext,
    memoryContext: string,
    strategySource: StrategySource,
    budget: IterationBudget,
    iteration: number,
    maxIterations: number
  ): { system: string; user: string; constraints?: string[] } {
    const template = this.getTemplate(templateName);
    if (!template) {
      throw new Error(`Template not found: ${templateName}`);
    }

    const promptContext: PromptContext = {
      currentContext: context,
      memoryContext,
      strategySource,
      budgetState: budget.getUsage(),
      iteration,
      maxIterations,
    };

    return {
      system: template.system,
      user: template.user(promptContext),
      constraints: template.constraints,
    };
  }

  /**
   * Build context summary
   */
  buildContextSummary(context: ContextState): string {
    const { current, history, memoryChunks } = context;

    let summary = `=== CURRENT CONTEXT ===\n`;
    summary += `Mode: ${current.mode}\n`;
    summary += `Account: ${current.accountId}\n`;
    summary += `Portfolio: ${current.portfolioId}\n`;
    summary += `Correlation ID: ${current.correlationId}\n`;
    summary += `Time: ${current.now.toISOString()}\n\n`;

    if (history.length > 0) {
      summary += `=== RECENT HISTORY ===\n`;
      history.slice(-3).forEach((h, i) => {
        summary += `Action ${history.length - 2 + i}: ${JSON.stringify(h.actions).substring(0, 100)}...\n`;
      });
      summary += `\n`;
    }

    if (memoryChunks.length > 0) {
      summary += `=== MEMORY SNIPPETS ===\n`;
      const importantMemories = memoryChunks
        .filter(m => m.importance > 0.5)
        .slice(0, 5);

      importantMemories.forEach(m => {
        const content = typeof m.content === 'string'
          ? m.content.substring(0, 100)
          : JSON.stringify(m.content).substring(0, 100);
        summary += `[${m.type}] ${content}...\n`;
      });
      summary += `\n`;
    }

    summary += `=== STRATEGY SOURCE ===\n`;
    summary += `Type: ${context.current.mode === 'backtest' ? 'Historical' : context.current.mode === 'paper' ? 'Simulated' : 'Live'}\n`;
    summary += `Strategy: ${strategySourceSummary(context.current.mode)}\n`;

    return summary;
  }

  /**
   * Register default templates
   */
  private registerDefaultTemplates(): void {
    this.registerTemplate("dynatrader-conversation", {
      system: `You are a workspace-defined AI agent. Your identity, specialty, and operating rules come from the workspace files loaded into context. You learn from every interaction.

Core Identity:
- You are a conversational agent that can discuss any topic naturally
- You follow the workspace-authored instructions before any default behavior
- You treat SOUL.md, IDENTITY.md, USER.md, and MEMORY.md as the source of truth
- You can specialize in trading, market analysis, or other tasks if the workspace defines them
- You have access to tools for market data, research, memory, and execution
- You learn from every conversation and improve over time

Behavior:
- Respond naturally and conversationally to all messages
- Use your trading expertise when relevant, but don't force trading topics
- When asked about markets, use your tools to provide real data and analysis
- When asked about trading strategies, provide actionable insights
- Remember context from this conversation and past interactions
- If the current prompt is missing earlier context, use session_search before asking the user to repeat themselves
- Use sessions_history for exact transcript windows, memory_search for relevant stored context, and memory_write for durable decisions worth retaining
- Do not create or promote skills at startup; only write durable skills after loop/review evidence warrants it
- Be concise and direct unless the user wants detailed analysis

Domain Capabilities (use when relevant):
- Research, analysis, planning, and execution through configured tools
- Trading capabilities only when the workspace enables them
- Follow workspace policies for any domain-specific action

Memory and Learning:
- You have access to past trade outcomes and learnings
- You can search your memory for relevant context
- You improve your recommendations based on historical performance
- Detached cron sessions are separate from the main conversation but still report back through the configured gateway`,

      user: (ctx) => `
Conversation Context:
- Mode: ${ctx.currentContext.mode}
- Account: ${ctx.currentContext.accountId}
- Session: ${ctx.currentContext.sessionId ?? 'default'}
- Time: ${ctx.currentContext.now.toISOString()}

${ctx.memoryContext ? `Memory Context:\n${ctx.memoryContext}` : 'No relevant memories loaded.'}

User Message:
${ctx.strategySource.body}

${ctx.strategySource.params ? `Parameters: ${JSON.stringify(ctx.strategySource.params, null, 2)}` : ''}

Respond naturally. Use tools when needed to provide accurate, helpful information.`,

      constraints: [
        "Respond in natural language, not JSON or structured formats",
        "Be helpful and conversational",
        "Use tools to fetch real data when the user asks about markets",
        "Keep responses focused and relevant to the user's question",
        "Remember this is a workspace-defined agent - follow workspace instructions before any defaults",
      ],
    });

    // Strategy Discovery Template (for trading pipeline)
    this.registerTemplate("strategy-discovery", {
      system: `You are a workspace-defined trading agent. Follow the workspace instructions exactly, then analyze trading strategies, evaluate risk, and generate executable trade plans.

Key Principles:
1. Follow the workspace-authored USER.md for operator preferences, risk posture, and execution style
2. Use session_search, sessions_history, and MEMORY.md before inventing missing context
3. Discover candidate venues, instruments, and horizons from live tools, connected MCP sources, and workspace policy
4. Do not invent strategy defaults or policy thresholds
5. If required policy context is unavailable, ask for configuration or stop safely

Output Format:
- Provide a brief analysis of the strategy
- Identify potential risks and mitigation measures
- Suggest specific entry/exit parameters
- Recommend position sizing based on risk tolerance`,

      user: (ctx) => `
I need you to analyze a trading strategy for ${ctx.currentContext.mode} trading.

Current Context:
- Mode: ${ctx.currentContext.mode}
- Account: ${ctx.currentContext.accountId}
- Portfolio: ${ctx.currentContext.portfolioId}
- Time: ${ctx.currentContext.now.toISOString()}

Memory Context:
${ctx.memoryContext || 'No relevant memories'}

Strategy Source:
- Type: ${ctx.strategySource.kind}
- Body: ${ctx.strategySource.body.substring(0, 200)}${ctx.strategySource.body.length > 200 ? '...' : ''}
- Parameters: ${JSON.stringify(ctx.strategySource.params, null, 2)}

Please analyze this strategy and provide your recommendations.`,

      constraints: [
        "Keep responses concise and focused",
        "Always include risk assessment",
        "Suggest specific, actionable parameters",
        "Consider the trading mode (backtest/paper/live)",
      ],
    });

    // Risk Evaluation Template
    this.registerTemplate("risk-evaluation", {
      system: `You are responsible for risk management for algorithmic trading. Your job is to evaluate trading strategies and orders against strict risk criteria.

Risk Guidelines:
1. Apply the workspace-authored USER.md for risk posture and execution style
2. Use session_search and sessions_history to recover prior decisions before assuming a missing limit
3. Use only explicit limits supplied by policy or the strategy source
4. Never invent position, loss, stop, or exposure thresholds
5. Consider correlation, slippage, liquidity, and market impact when configured

Evaluation Criteria:
- Capital preservation
- Risk-adjusted returns
- Drawdown control
- Position concentration
- Market timing risk`,

      user: (ctx) => `
Evaluate the risk profile of this trading strategy.

Strategy: ${JSON.stringify(ctx.strategySource)}

Current Portfolio:
- Mode: ${ctx.currentContext.mode}
- Account: ${ctx.currentContext.accountId}

Please provide a risk assessment using the configured policy schema. If policy
fields are missing, report the missing configuration instead of inventing values.`,

      constraints: [
        "Be conservative and risk-averse",
        "Always prioritize capital preservation",
        "Consider worst-case scenarios",
        "Provide clear justification for decisions",
      ],
    });

    // Order Generation Template
    this.registerTemplate("order-generation", {
      system: `You are responsible for order execution. Your job is to convert trading strategies into specific, executable orders.

Order Generation Rules:
1. Follow the workspace-authored USER.md for execution preferences and constraints
2. Use session_search and sessions_history to recover prior order context before inventing missing state
3. Require explicit order type, instrument, quantity, and venue
4. Apply only configured fee, slippage, liquidity, and approval rules
5. Never invent stop, target, sizing, or order-frequency thresholds

Order Types:
- Market: Immediate execution at best available price
- Limit: Execute only at specified price or better
- Stop-Trigger: Convert to market when price hit
- Stop-Limit: Convert to limit when price hit`,

      user: (ctx) => `
Generate specific trading orders based on this strategy.

Strategy Information:
- Type: ${ctx.strategySource.kind}
- Entry: ${ctx.strategySource.params?.entry || 'Default'}
- Exit: ${ctx.strategySource.params?.exit || 'Default'}

Market Context:
- Time: ${ctx.currentContext.now.toISOString()}
- Mode: ${ctx.currentContext.mode}
- Account: ${ctx.currentContext.accountId}

Memory Context:
${ctx.memoryContext.substring(0, 500)}...

Please generate:
1. Primary entry order(s)
2. Stop-loss order(s)
3. Take-profit order(s)
4. Position sizing recommendations
5. Order timing suggestions`,

      constraints: [
        "Orders must be specific and executable",
        "Include all required order parameters",
        "Consider market microstructure",
        "Avoid wash trading and self-dealing",
      ],
    });
  }
}

// Helper function for strategy source summary
function strategySourceSummary(mode: string): string {
  switch (mode) {
    case 'backtest':
      return 'Historical data simulation';
    case 'paper':
      return 'Paper trading simulation';
    case 'live':
      return 'Live trading with real capital';
    default:
      return 'Unknown trading mode';
  }
}

// Export singleton instance
export const promptBuilder = new PromptBuilder();
