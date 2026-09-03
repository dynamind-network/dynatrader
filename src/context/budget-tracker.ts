export type BudgetTier = "stable" | "context" | "volatile";

export interface BudgetSnapshot {
  totalTokens: number;
  stableTokens: number;
  contextTokens: number;
  volatileTokens: number;
  warn: boolean;
  compact: boolean;
}

export interface BudgetTrackerConfig {
  contextWindowTokens: number;
  warnAtRatio?: number;
  compactAtRatio?: number;
}

export class BudgetTracker {
  private readonly config: Required<BudgetTrackerConfig>;
  private tokens: Record<BudgetTier, number> = {
    stable: 0,
    context: 0,
    volatile: 0,
  };

  constructor(config: BudgetTrackerConfig) {
    this.config = {
      warnAtRatio: config.warnAtRatio ?? 0.8,
      compactAtRatio: config.compactAtRatio ?? 0.9,
      contextWindowTokens: config.contextWindowTokens,
    };
  }

  update(tier: BudgetTier, tokens: number): void {
    this.tokens[tier] = Math.max(0, tokens);
  }

  getSnapshot(): BudgetSnapshot {
    const totalTokens = this.tokens.stable + this.tokens.context + this.tokens.volatile;
    const warnThreshold = this.config.contextWindowTokens * this.config.warnAtRatio;
    const compactThreshold = this.config.contextWindowTokens * this.config.compactAtRatio;

    return {
      totalTokens,
      stableTokens: this.tokens.stable,
      contextTokens: this.tokens.context,
      volatileTokens: this.tokens.volatile,
      warn: totalTokens >= warnThreshold,
      compact: totalTokens >= compactThreshold,
    };
  }

  shouldWarn(): boolean {
    return this.getSnapshot().warn;
  }

  shouldCompact(): boolean {
    return this.getSnapshot().compact;
  }

  updateContextWindowTokens(contextWindowTokens: number): void {
    if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) {
      return;
    }
    this.config.contextWindowTokens = Math.floor(contextWindowTokens);
  }

  getContextWindowTokens(): number {
    return this.config.contextWindowTokens;
  }
}
