/**
 * Rate Limiting Module
 *
 * Provides rate limiting for API endpoints and WebSocket connections
 */

import { MemoryStoreImpl } from '@dyna/memory-core';

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  message?: string;
  statusCode?: number;
  keyPrefix?: string;
  keyGenerator?: (req: any) => string;
  skip?: (req: any) => boolean;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: number;
  totalRequests: number;
}

export interface RateLimitStore {
  increment(key: string, windowMs: number): Promise<{ totalHits: number; resetTime: number }>;
  decrement(key: string): Promise<void>;
  resetKey(key: string): Promise<void>;
  getRemaining(key: string, maxRequests: number): Promise<number>;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private memory: MemoryStoreImpl;

  constructor(memory: MemoryStoreImpl) {
    this.memory = memory;
  }

  private rateLimitKey(rawKey: string): string {
    return `ratelimit:${rawKey}`;
  }

  async increment(key: string, windowMs: number): Promise<{ totalHits: number; resetTime: number }> {
    const now = Date.now();
    const resetTime = Math.ceil(now / windowMs) * windowMs;

    const current = (await this.memory.getCacheItem(this.rateLimitKey(key))) as { count: number; resetTime: number } | null;
    if (!current || current.resetTime <= now) {
      await this.memory.setCacheItem(this.rateLimitKey(key), { count: 1, resetTime });
      return { totalHits: 1, resetTime };
    }

    const newCount = current.count + 1;
    await this.memory.setCacheItem(this.rateLimitKey(key), { count: newCount, resetTime: current.resetTime });
    return { totalHits: newCount, resetTime: current.resetTime };
  }

  async decrement(key: string): Promise<void> {
    const current = (await this.memory.getCacheItem(this.rateLimitKey(key))) as { count: number; resetTime: number } | null;
    if (current && current.count > 0) {
      await this.memory.setCacheItem(this.rateLimitKey(key), { count: current.count - 1, resetTime: current.resetTime });
    }
  }

  async resetKey(key: string): Promise<void> {
    await this.memory.deleteCacheItem(this.rateLimitKey(key));
  }

  async getRemaining(key: string, maxRequests: number): Promise<number> {
    const current = (await this.memory.getCacheItem(this.rateLimitKey(key))) as { count: number; resetTime: number } | null;
    if (!current) {
      return maxRequests;
    }
    return Math.max(0, maxRequests - current.count);
  }
}

export class RateLimiter {
  private store: RateLimitStore;
  private config: RateLimitConfig;

  constructor(store: RateLimitStore, config: RateLimitConfig) {
    this.store = store;
    this.config = {
      message: 'Too many requests, please try again later.',
      statusCode: 429,
      ...config,
    };
  }

  /**
   * Check if request is allowed
   */
  async check(key: string): Promise<RateLimitResult> {
    const { totalHits, resetTime } = await this.store.increment(key, this.config.windowMs);

    return {
      allowed: totalHits <= this.config.maxRequests,
      remaining: Math.max(0, this.config.maxRequests - totalHits),
      resetTime,
      totalRequests: totalHits,
    };
  }

  /**
   * Get rate limit headers
   */
  getHeaders(result: RateLimitResult): Record<string, string> {
    return {
      'X-RateLimit-Limit': String(this.config.maxRequests),
      'X-RateLimit-Remaining': String(result.remaining),
      'X-RateLimit-Reset': String(Math.ceil(result.resetTime / 1000)),
    };
  }

  /**
   * Create middleware for Express/Fastify
   */
  middleware() {
    return async (req: any, res: any, next: Function) => {
      if (this.config.skip && this.config.skip(req)) {
        return next();
      }

      const key = this.config.keyPrefix
        ? `${this.config.keyPrefix}:${req.ip}`
        : req.ip;

      const result = await this.check(key);

      // Set headers
      const headers = this.getHeaders(result);
      Object.entries(headers).forEach(([header, value]) => {
        res.setHeader(header, value);
      });

      if (!result.allowed) {
        return res.status(this.config.statusCode!).json({
          error: this.config.message,
          retryAfter: Math.ceil((result.resetTime - Date.now()) / 1000),
        });
      }

      next();
    };
  }

  /**
   * Reset rate limit for a key
   */
  async resetKey(key: string): Promise<void> {
    await this.store.resetKey(key);
  }

  /**
   * Get remaining requests for a key
   */
  async getRemaining(key: string): Promise<number> {
    return this.store.getRemaining(key, this.config.maxRequests);
  }
}

export class TokenBucketRateLimiter {
  private tokens: Map<string, { count: number; lastRefill: number }> = new Map();
  private maxTokens: number;
  private refillRate: number;
  private refillInterval: number;

  constructor(maxTokens: number, refillRate: number, refillInterval: number = 1000) {
    this.maxTokens = maxTokens;
    this.refillRate = refillRate;
    this.refillInterval = refillInterval;
  }

  /**
   * Try to consume a token
   */
  tryConsume(key: string, tokens: number = 1): boolean {
    const now = Date.now();
    let bucket = this.tokens.get(key);

    if (!bucket) {
      bucket = { count: this.maxTokens, lastRefill: now };
      this.tokens.set(key, bucket);
    }

    // Refill tokens
    const timePassed = now - bucket.lastRefill;
    const refillAmount = Math.floor(timePassed / this.refillInterval) * this.refillRate;
    bucket.count = Math.min(this.maxTokens, bucket.count + refillAmount);
    bucket.lastRefill = now;

    // Try to consume
    if (bucket.count >= tokens) {
      bucket.count -= tokens;
      return true;
    }

    return false;
  }

  /**
   * Get current token count
   */
  getTokens(key: string): number {
    const bucket = this.tokens.get(key);
    if (!bucket) {
      return this.maxTokens;
    }

    const timePassed = Date.now() - bucket.lastRefill;
    const refillAmount = Math.floor(timePassed / this.refillInterval) * this.refillRate;
    return Math.min(this.maxTokens, bucket.count + refillAmount);
  }

  /**
   * Reset rate limiter for a key
   */
  reset(key: string): void {
    this.tokens.delete(key);
  }
}

export class SlidingWindowRateLimiter {
  private requests: Map<string, number[]> = new Map();
  private windowMs: number;
  private maxRequests: number;

  constructor(windowMs: number, maxRequests: number) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
  }

  /**
   * Check if request is allowed
   */
  isAllowed(key: string): boolean {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    let timestamps = this.requests.get(key) || [];
    timestamps = timestamps.filter(t => t > windowStart);

    if (timestamps.length >= this.maxRequests) {
      this.requests.set(key, timestamps);
      return false;
    }

    timestamps.push(now);
    this.requests.set(key, timestamps);
    return true;
  }

  /**
   * Get remaining requests
   */
  getRemaining(key: string): number {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const timestamps = (this.requests.get(key) || []).filter(t => t > windowStart);
    return Math.max(0, this.maxRequests - timestamps.length);
  }

  /**
   * Reset rate limiter for a key
   */
  reset(key: string): void {
    this.requests.delete(key);
  }
}