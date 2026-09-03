/**
 * Base class for tools that interact with external APIs
 */

import { BaseTool } from './base-tool.js';
import type { ToolResult } from '../core/types.js';

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  statusCode?: number;
}

/**
 * Abstract base class for API client tools
 */
export abstract class ApiClientTool extends BaseTool {
  protected readonly requestTimeout = 30000; // 30 seconds
  protected readonly maxRetries = 3;
  protected readonly retryDelay = 1000; // 1 second

  /**
   * Fetch JSON from URL with error handling
   */
  protected async fetchJson<T>(
    url: string,
    options?: RequestInit
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`API request failed: ${response.status} ${response.statusText}`);
      }

      return response.json() as Promise<T>;
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Fetch with automatic retry on failure
   */
  protected async fetchWithRetry<T>(
    url: string,
    options?: RequestInit,
    retries = this.maxRetries
  ): Promise<T> {
    try {
      return await this.fetchJson<T>(url, options);
    } catch (err) {
      if (retries <= 0) {
        throw err;
      }

      await new Promise(resolve => setTimeout(resolve, this.retryDelay));
      return this.fetchWithRetry<T>(url, options, retries - 1);
    }
  }

  /**
   * Fetch with fallback value on error
   */
  protected async fetchWithFallback<T>(
    url: string,
    fallback: T,
    options?: RequestInit
  ): Promise<T> {
    try {
      return await this.fetchJson<T>(url, options);
    } catch (err) {
      console.warn(`Fetch failed for ${url}, using fallback:`, err);
      return fallback;
    }
  }

  /**
   * Format API error into standardized ToolResult
   */
  protected formatApiError(endpoint: string, error: Error): ToolResult {
    return this.error(`API Error [${endpoint}]: ${error.message}`);
  }

  /**
   * Parse price from string or number
   */
  protected parsePrice(value: string | number, defaultValue = 0): number {
    if (typeof value === 'number') return value;
    const parsed = parseFloat(value);
    return isNaN(parsed) ? defaultValue : parsed;
  }

  /**
   * Extract pagination parameters
   */
  protected getPaginationParams(
    page?: number,
    limit?: number
  ): { skip: number; limit: number } {
    const pageNum = Math.max(1, page || 1);
    const limitNum = Math.min(1000, Math.max(1, limit || 50));
    return {
      skip: (pageNum - 1) * limitNum,
      limit: limitNum,
    };
  }

  /**
   * Build URL with query parameters
   */
  protected buildUrl(base: string, params: Record<string, unknown>): string {
    const url = new URL(base);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== null && value !== undefined) {
        url.searchParams.append(key, String(value));
      }
    });
    return url.toString();
  }

  /**
   * Check if response indicates an error
   */
  protected isErrorResponse(response: unknown): boolean {
    if (!response || typeof response !== 'object') return false;

    const obj = response as Record<string, unknown>;
    return (
      obj.error !== undefined ||
      obj.code === 'ERROR' ||
      obj.status === 'error' ||
      (typeof obj.success === 'boolean' && !obj.success)
    );
  }

  /**
   * Extract error message from various response formats
   */
  protected extractErrorMessage(response: unknown): string {
    if (!response || typeof response !== 'object') {
      return 'Unknown error';
    }

    const obj = response as Record<string, unknown>;
    return (
      String(obj.error) ||
      String(obj.message) ||
      String(obj.msg) ||
      'Unknown error'
    );
  }

  /**
   * Rate limit handler - delay between requests
   */
  protected async rateLimit(delayMs = 100): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, delayMs));
  }

  /**
   * Get API rate limit headers from response
   */
  protected parseRateLimit(response: Response): {
    remaining: number;
    resetAt: number;
  } {
    const remaining = parseInt(response.headers.get('x-ratelimit-remaining') || '-1');
    const resetAt = parseInt(response.headers.get('x-ratelimit-reset') || '0');

    return {
      remaining: remaining >= 0 ? remaining : -1,
      resetAt: resetAt > 0 ? resetAt * 1000 : 0,
    };
  }
}
