export enum CircuitState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half_open',
}

export interface CircuitBreakerConfig {
  errorThreshold?: number;
  resetTimeoutMs?: number;
  halfOpenMaxRequests?: number;
}

export interface CircuitStateInfo {
  providerId: string;
  state: CircuitState;
  failureCount: number;
  openedAt: number | null;
  lastFailureReason: string | null;
}

const DEFAULT_CONFIG: Required<CircuitBreakerConfig> = {
  errorThreshold: 5,
  resetTimeoutMs: 30_000,
  halfOpenMaxRequests: 3,
};

const NON_CIRCUIT_CATEGORIES = new Set(['auth', 'fatal']);

export class CircuitBreaker {
  private providerId: string;
  private config: Required<CircuitBreakerConfig>;
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private openedAt: number | null = null;
  private lastFailureReason: string | null = null;
  private halfOpenRequestCount = 0;

  constructor(providerId: string, config?: Partial<CircuitBreakerConfig>) {
    this.providerId = providerId;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Returns true if a request should be allowed through.
   * - CLOSED: always allowed
   * - OPEN: only if reset timeout elapsed (auto-transitions to HALF_OPEN)
   * - HALF_OPEN: allowed up to halfOpenMaxRequests
   */
  allowRequest(): boolean {
    const currentState = this.getState();

    if (currentState === CircuitState.CLOSED) {
      return true;
    }

    if (currentState === CircuitState.HALF_OPEN) {
      if (this.halfOpenRequestCount < this.config.halfOpenMaxRequests) {
        this.halfOpenRequestCount++;
        return true;
      }
      return false;
    }

    // OPEN state - should not reach here since getState() auto-transitions
    return false;
  }

  /**
   * Record a successful call.
   * Resets failure count. If HALF_OPEN, transitions back to CLOSED.
   */
  recordSuccess(): void {
    this.failureCount = 0;
    this.halfOpenRequestCount = 0;

    if (this.state === CircuitState.HALF_OPEN) {
      this.state = CircuitState.CLOSED;
      this.openedAt = null;
    }
  }

  /**
   * Record a failed call.
   * Auth and fatal categories are not counted (they don't affect the circuit).
   * If threshold reached → OPEN. If HALF_OPEN → back to OPEN.
   */
  recordFailure(category?: string): void {
    // Auth and fatal errors are not circuit-relevant
    if (category && NON_CIRCUIT_CATEGORIES.has(category)) {
      return;
    }

    this.failureCount++;
    this.lastFailureReason = category ?? this.lastFailureReason ?? 'unknown';

    if (this.state === CircuitState.HALF_OPEN) {
      // Failure in half-open goes back to OPEN
      this.state = CircuitState.OPEN;
      this.openedAt = Date.now();
      this.halfOpenRequestCount = 0;
      return;
    }

    if (this.failureCount >= this.config.errorThreshold) {
      this.state = CircuitState.OPEN;
      this.openedAt = Date.now();
    }
  }

  /**
   * Get the current state, auto-transitioning from OPEN to HALF_OPEN
   * if the reset timeout has elapsed.
   */
  getState(): CircuitState {
    if (this.state === CircuitState.OPEN && this.openedAt !== null) {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed >= this.config.resetTimeoutMs) {
        this.state = CircuitState.HALF_OPEN;
        this.halfOpenRequestCount = 0;
      }
    }
    return this.state;
  }

  /**
   * Get full state information.
   */
  getStateInfo(): CircuitStateInfo {
    // Call getState() to trigger any auto-transition
    const currentState = this.getState();

    return {
      providerId: this.providerId,
      state: currentState,
      failureCount: this.failureCount,
      openedAt: this.openedAt,
      lastFailureReason: this.lastFailureReason,
    };
  }

  /**
   * Reset the circuit breaker back to CLOSED state.
   */
  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.openedAt = null;
    this.lastFailureReason = null;
    this.halfOpenRequestCount = 0;
  }
}
