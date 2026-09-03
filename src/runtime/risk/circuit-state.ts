/**
 * Circuit Breaker State — latching daily-loss guard
 *
 * Tracks realized PnL against a daily loss limit. Unlike the legacy
 * src/risk/core breakers (never wired), this is fed by real execution
 * outcomes via the risk tools surface and LATCHES when tripped: a PnL
 * recovery does not un-trip it until autoResetMinutes elapses.
 */

export interface CircuitStateConfig {
  /** Daily loss as fraction of session-start equity that trips the breaker (0.05 = 5%). */
  dailyLossLimitPct: number;
  /** Minutes after trip before automatic reset. 0 = manual reset only. */
  autoResetMinutes: number;
}

export interface TripStatus {
  tripped: boolean;
  reason?: string;
  resetsAt?: number;
  dailyLossPct: number;
  limitPct: number;
}

const DEFAULT_CONFIG: CircuitStateConfig = {
  dailyLossLimitPct: 0.05,
  autoResetMinutes: 60,
};

export class CircuitState {
  private config: CircuitStateConfig;
  private startOfDayEquity: number;
  private currentEquity: number;
  private dayStartedAt: number;
  private trippedAt: number | null = null;
  private tripReason: string | null = null;

  constructor(config: Partial<CircuitStateConfig> = {}, startingEquity = 10_000) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    const now = Date.now();
    this.startOfDayEquity = startingEquity;
    this.currentEquity = startingEquity;
    this.dayStartedAt = now;
    void now;
  }

  /**
   * Record a realized outcome. Positive pnl increases equity; negative decreases.
   */
  recordOutcome(pnl: number, _equityHint?: number): void {
    this.rollDayIfNeeded();
    this.currentEquity += pnl;

    if (this.trippedAt !== null) return; // already latched

    const lossPct = (this.startOfDayEquity - this.currentEquity) / this.startOfDayEquity;
    if (lossPct >= this.config.dailyLossLimitPct) {
      this.trippedAt = Date.now();
      this.tripReason =
        `Daily loss ${(lossPct * 100).toFixed(2)}% hit limit ` +
        `${(this.config.dailyLossLimitPct * 100).toFixed(2)}%`;
    }
  }

  /**
   * Check breaker status. Latched state holds until autoResetMinutes elapse
   * (or manual reset()).
   */
  isTripped(): TripStatus {
    this.rollDayIfNeeded();
    const lossPct = Math.max(0, (this.startOfDayEquity - this.currentEquity) / this.startOfDayEquity);

    if (this.trippedAt === null) {
      return {
        tripped: false,
        dailyLossPct: lossPct,
        limitPct: this.config.dailyLossLimitPct,
      };
    }

    if (this.config.autoResetMinutes > 0) {
      const resetsAt = this.trippedAt + this.config.autoResetMinutes * 60_000;
      if (Date.now() >= resetsAt) {
        // Auto-reset: new baseline from current equity
        this.reset();
        return {
          tripped: false,
          dailyLossPct: lossPct,
          limitPct: this.config.dailyLossLimitPct,
        };
      }
      return {
        tripped: true,
        reason: this.tripReason ?? "daily loss limit",
        resetsAt,
        dailyLossPct: lossPct,
        limitPct: this.config.dailyLossLimitPct,
      };
    }

    return {
      tripped: true,
      reason: this.tripReason ?? "daily loss limit",
      dailyLossPct: lossPct,
      limitPct: this.config.dailyLossLimitPct,
    };
  }

  /** Manual reset — clears latch and re-baselines equity at current level. */
  reset(): void {
    this.trippedAt = null;
    this.tripReason = null;
    this.startOfDayEquity = this.currentEquity;
  }

  get equity(): number {
    return this.currentEquity;
  }

  private rollDayIfNeeded(): void {
    const DAY_MS = 24 * 60 * 60 * 1000;
    if (Date.now() - this.dayStartedAt >= DAY_MS) {
      this.dayStartedAt = Date.now();
      this.startOfDayEquity = this.currentEquity;
      this.trippedAt = null;
      this.tripReason = null;
    }
  }
}
