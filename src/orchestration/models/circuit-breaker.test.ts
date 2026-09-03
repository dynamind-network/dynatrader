import { describe, it, expect, beforeEach } from 'vitest';
import { CircuitBreaker, CircuitState } from './circuit-breaker';

describe('CircuitBreaker', () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker('test-provider');
  });

  describe('initial state', () => {
    it('should start in CLOSED state', () => {
      expect(cb.getState()).toBe(CircuitState.CLOSED);
    });

    it('should allow requests in CLOSED state', () => {
      expect(cb.allowRequest()).toBe(true);
    });

    it('getStateInfo() should return correct shape', () => {
      const info = cb.getStateInfo();
      expect(info).toHaveProperty('providerId', 'test-provider');
      expect(info).toHaveProperty('state', CircuitState.CLOSED);
      expect(info).toHaveProperty('failureCount', 0);
      expect(info).toHaveProperty('openedAt', null);
      expect(info).toHaveProperty('lastFailureReason', null);
    });
  });

  describe('opening circuit', () => {
    it('should open after threshold errors (default 5)', () => {
      for (let i = 0; i < 5; i++) {
        cb.recordFailure();
      }
      expect(cb.getState()).toBe(CircuitState.OPEN);
    });

    it('should not open below threshold', () => {
      for (let i = 0; i < 4; i++) {
        cb.recordFailure();
      }
      expect(cb.getState()).toBe(CircuitState.CLOSED);
    });

    it('should reject requests when open and reset timeout has not elapsed', () => {
      for (let i = 0; i < 5; i++) {
        cb.recordFailure();
      }
      expect(cb.allowRequest()).toBe(false);
    });
  });

  describe('success resets failure count', () => {
    it('should reset failure count on success', () => {
      cb.recordFailure();
      cb.recordFailure();
      cb.recordSuccess();
      expect(cb.getStateInfo().failureCount).toBe(0);
      expect(cb.getState()).toBe(CircuitState.CLOSED);
    });

    it('should not open after accumulating errors below threshold when interspersed with successes', () => {
      cb.recordFailure();
      cb.recordSuccess();
      cb.recordFailure();
      cb.recordFailure();
      cb.recordSuccess();
      cb.recordFailure();
      cb.recordFailure();
      // failure count should be 2, not 4
      expect(cb.getStateInfo().failureCount).toBe(2);
      expect(cb.getState()).toBe(CircuitState.CLOSED);
    });
  });

  describe('half-open state', () => {
    it('should transition to half-open after reset timeout elapses', async () => {
      const fastCb = new CircuitBreaker('fast', { resetTimeoutMs: 10, errorThreshold: 3 });
      for (let i = 0; i < 3; i++) {
        fastCb.recordFailure();
      }
      expect(fastCb.getState()).toBe(CircuitState.OPEN);

      await new Promise((resolve) => setTimeout(resolve, 20));

      // getState should auto-transition to HALF_OPEN
      expect(fastCb.getState()).toBe(CircuitState.HALF_OPEN);
    });

    it('should allow limited requests in half-open state', async () => {
      const fastCb = new CircuitBreaker('fast', { resetTimeoutMs: 10, errorThreshold: 3, halfOpenMaxRequests: 2 });
      for (let i = 0; i < 3; i++) {
        fastCb.recordFailure();
      }
      expect(fastCb.getState()).toBe(CircuitState.OPEN);

      await new Promise((resolve) => setTimeout(resolve, 20));

      // First request in half-open should be allowed
      expect(fastCb.allowRequest()).toBe(true);
      // Second should also be allowed
      expect(fastCb.allowRequest()).toBe(true);
      // Third should be denied (limit is 2)
      expect(fastCb.allowRequest()).toBe(false);
    });

    it('should close on success in half-open', async () => {
      const fastCb = new CircuitBreaker('fast', { resetTimeoutMs: 10, errorThreshold: 3 });
      for (let i = 0; i < 3; i++) {
        fastCb.recordFailure();
      }

      await new Promise((resolve) => setTimeout(resolve, 20));

      // Transition to half-open via allowRequest
      fastCb.allowRequest();
      expect(fastCb.getState()).toBe(CircuitState.HALF_OPEN);

      // Success in half-open should close circuit
      fastCb.recordSuccess();
      expect(fastCb.getState()).toBe(CircuitState.CLOSED);
      expect(fastCb.getStateInfo().failureCount).toBe(0);
    });

    it('should open again on failure in half-open', async () => {
      const fastCb = new CircuitBreaker('fast', { resetTimeoutMs: 10, errorThreshold: 3 });
      for (let i = 0; i < 3; i++) {
        fastCb.recordFailure();
      }

      await new Promise((resolve) => setTimeout(resolve, 20));

      // Transition to half-open
      fastCb.allowRequest();
      expect(fastCb.getState()).toBe(CircuitState.HALF_OPEN);

      // Failure in half-open should re-open circuit
      fastCb.recordFailure();
      expect(fastCb.getState()).toBe(CircuitState.OPEN);
    });

    it('should update openedAt when transitioning back to OPEN from HALF_OPEN', async () => {
      const fastCb = new CircuitBreaker('fast', { resetTimeoutMs: 10, errorThreshold: 3 });
      for (let i = 0; i < 3; i++) {
        fastCb.recordFailure();
      }

      await new Promise((resolve) => setTimeout(resolve, 20));

      // Half-open
      fastCb.allowRequest();

      // Get the openedAt before re-opening
      const beforeOpenInfo = fastCb.getStateInfo();
      const openedAtBeforeFail = beforeOpenInfo.openedAt;

      // Failure in half-open
      fastCb.recordFailure();

      const afterInfo = fastCb.getStateInfo();
      expect(afterInfo.state).toBe(CircuitState.OPEN);
      // openedAt should be updated
      expect(afterInfo.openedAt).toBeGreaterThanOrEqual(openedAtBeforeFail ?? 0);
    });
  });

  describe('auth and fatal errors', () => {
    it('should not count auth errors toward circuit breaker', () => {
      for (let i = 0; i < 10; i++) {
        cb.recordFailure('auth');
      }
      expect(cb.getState()).toBe(CircuitState.CLOSED);
      expect(cb.getStateInfo().failureCount).toBe(0);
    });

    it('should not count fatal errors toward circuit breaker', () => {
      for (let i = 0; i < 10; i++) {
        cb.recordFailure('fatal');
      }
      expect(cb.getState()).toBe(CircuitState.CLOSED);
      expect(cb.getStateInfo().failureCount).toBe(0);
    });

    it('should count other error categories toward circuit breaker', () => {
      for (let i = 0; i < 3; i++) {
        cb.recordFailure('rate_limit');
      }
      expect(cb.getStateInfo().failureCount).toBe(3);
    });

    it('should count errors without a category toward circuit breaker', () => {
      for (let i = 0; i < 5; i++) {
        cb.recordFailure();
      }
      expect(cb.getState()).toBe(CircuitState.OPEN);
    });

    it('should track last failure reason for countable errors', () => {
      cb.recordFailure('rate_limit');
      expect(cb.getStateInfo().lastFailureReason).toBe('rate_limit');

      cb.recordFailure('timeout');
      expect(cb.getStateInfo().lastFailureReason).toBe('timeout');
    });

    it('should not update last failure reason for auth/fatal errors', () => {
      cb.recordFailure('timeout');
      cb.recordFailure('auth');
      // lastFailureReason should still be 'timeout', not 'auth'
      expect(cb.getStateInfo().lastFailureReason).toBe('timeout');
    });
  });

  describe('reset', () => {
    it('should reset to CLOSED and clear all state', () => {
      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.getState()).toBe(CircuitState.OPEN);

      cb.reset();

      const info = cb.getStateInfo();
      expect(info.state).toBe(CircuitState.CLOSED);
      expect(info.failureCount).toBe(0);
      expect(info.openedAt).toBe(null);
      expect(info.lastFailureReason).toBe(null);
    });
  });

  describe('custom config', () => {
    it('should use custom error threshold', () => {
      const customCb = new CircuitBreaker('custom', { errorThreshold: 2 });
      expect(customCb.allowRequest()).toBe(true);

      customCb.recordFailure();
      expect(customCb.getState()).toBe(CircuitState.CLOSED);

      customCb.recordFailure();
      expect(customCb.getState()).toBe(CircuitState.OPEN);
    });

    it('should use custom halfOpenMaxRequests', async () => {
      const customCb = new CircuitBreaker('custom', {
        errorThreshold: 2,
        resetTimeoutMs: 10,
        halfOpenMaxRequests: 1,
      });

      for (let i = 0; i < 2; i++) {
        customCb.recordFailure();
      }

      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(customCb.allowRequest()).toBe(true);
      expect(customCb.allowRequest()).toBe(false);
    });
  });
});
