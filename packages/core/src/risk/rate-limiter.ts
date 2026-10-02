// ---------------------------------------------------------------------------
// Rate Limiter (Nautilus pattern: token bucket for order submission)
// ---------------------------------------------------------------------------

export interface RateLimiterConfig {
  maxTokens: number;
  refillRate: number;
  refillIntervalMs: number;
}

export class RateLimiter {
  private _config: RateLimiterConfig;
  private _tokens: number;
  private _lastRefill: number;

  constructor(config: RateLimiterConfig) {
    this._config = config;
    this._tokens = config.maxTokens;
    this._lastRefill = Date.now();
  }

  tryAcquire(): boolean {
    this._refill();

    if (this._tokens >= 1) {
      this._tokens -= 1;
      return true;
    }

    return false;
  }

  waitAndAcquire(): Promise<boolean> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.tryAcquire()) {
          resolve(true);
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
  }

  reset(): void {
    this._tokens = this._config.maxTokens;
    this._lastRefill = Date.now();
  }

  get availableTokens(): number {
    this._refill();
    return this._tokens;
  }

  private _refill(): void {
    const now = Date.now();
    const elapsed = now - this._lastRefill;
    const tokensToAdd = Math.floor(elapsed / this._config.refillIntervalMs) * this._config.refillRate;

    if (tokensToAdd > 0) {
      this._tokens = Math.min(this._config.maxTokens, this._tokens + tokensToAdd);
      this._lastRefill = now;
    }
  }
}

// ---------------------------------------------------------------------------
// Default Configs
// ---------------------------------------------------------------------------

export const DEFAULT_ORDER_RATE_LIMITER: RateLimiterConfig = {
  maxTokens: 10,
  refillRate: 1,
  refillIntervalMs: 1000,
};

export const DEFAULT_MODIFY_RATE_LIMITER: RateLimiterConfig = {
  maxTokens: 20,
  refillRate: 2,
  refillIntervalMs: 1000,
};
