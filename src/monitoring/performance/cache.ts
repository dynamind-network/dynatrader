/**
 * Advanced Caching System
 *
 * Multi-layer caching with LRU eviction, TTL support, and cache warming
 */

import Emittery from 'emittery';
import { MemoryStoreImpl } from '@dyna/memory-core';

export interface CacheConfig {
  // Cache configuration
  maxSize: number;
  defaultTTL: number;
  cleanupInterval: number;
  compressionEnabled: boolean;
  compressionThreshold: number;

  // Layer configuration
  layers: {
    memory: {
      enabled: boolean;
      maxSize: number;
      maxSizeBytes?: number;
    };
    redis: {
      enabled: boolean;
      url?: string;
      maxRetries?: number;
    };
    local: {
      enabled: boolean;
      maxSizeBytes?: number;
    };
  };

  // Cache warming
  warming: {
    enabled: boolean;
    prefetchCount: number;
    prefetchDelay: number;
  };
}

export interface CacheItem<T = any> {
  key: string;
  value: T;
  ttl: number;
  createdAt: number;
  accessedAt: number;
  hitCount: number;
  size?: number;
  compressed?: boolean;
}

export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
  sizeBytes: number;
  compressionSavings: number;
  hitRate: number;
  activeKeys: number;
}

export class CacheService extends Emittery<Record<string, unknown>> {
  private config: CacheConfig;
  private memory: MemoryStoreImpl;
  private localCache = new Map<string, CacheItem>();
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    size: 0,
    sizeBytes: 0,
    compressionSavings: 0,
    hitRate: 0,
    activeKeys: 0,
  };

  constructor(config: CacheConfig, memory: MemoryStoreImpl) {
    super();
    this.config = config;
    this.memory = memory;

    // Start cleanup interval
    if (config.cleanupInterval > 0) {
      setInterval(() => this.cleanup(), config.cleanupInterval);
    }
  }

  /**
   * Get value from cache
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      // Check local cache first (fastest)
      const localItem = this.localCache.get(key);
      if (localItem && this.isValid(localItem)) {
        localItem.accessedAt = Date.now();
        localItem.hitCount++;
        this.stats.hits++;
        this.updateHitRate();
        return localItem.value;
      }

      // Check memory store
      const memoryItem = await this.memory.getCacheItem(key) as CacheItem<unknown> | null;
      if (memoryItem && this.isValid(memoryItem)) {
        // Copy to local cache
        this.addToLocalCache(memoryItem);
        this.stats.hits++;
        this.updateHitRate();
        return memoryItem.value as T;
      }

      this.stats.misses++;
      this.updateHitRate();
      return null;
    } catch (error) {
      this.emit('error', { operation: 'get', key, error });
      return null;
    }
  }

  /**
   * Set value in cache
   */
  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    try {
      const item: CacheItem<T> = {
        key,
        value,
        ttl: ttl || this.config.defaultTTL,
        createdAt: Date.now(),
        accessedAt: Date.now(),
        hitCount: 0,
        size: this.calculateSize(value),
      };

      // Compress if enabled and above threshold
      if (this.config.compressionEnabled && item.size! > this.config.compressionThreshold) {
        item.value = await this.compress(value);
        item.compressed = true;
        item.size = this.calculateSize(item.value);
      }

      // Store in local cache
      this.addToLocalCache(item);

      // Store in memory
      await this.memory.setCacheItem(key, item);

      this.emit('set', { key, size: item.size, ttl: item.ttl });
    } catch (error) {
      this.emit('error', { operation: 'set', key, error });
    }
  }

  /**
   * Delete key from cache
   */
  async delete(key: string): Promise<boolean> {
    try {
      const deleted = this.localCache.delete(key);
      await this.memory.deleteCacheItem(key);

      if (deleted) {
        this.stats.evictions++;
      }

      return true;
    } catch (error) {
      this.emit('error', { operation: 'delete', key, error });
      return false;
    }
  }

  /**
   * Check if key exists
   */
  async has(key: string): Promise<boolean> {
    const exists = this.localCache.has(key) || await this.memory.hasCacheItem(key);
    return exists && this.isValid(this.localCache.get(key) || await this.memory.getCacheItem(key) as CacheItem<unknown>);
  }

  /**
   * Clear all cache
   */
  async clear(): Promise<void> {
    this.localCache.clear();
    await this.memory.clearCache();
    this.stats.evictions += this.stats.activeKeys;
    this.stats.activeKeys = 0;
    this.stats.size = 0;
    this.stats.sizeBytes = 0;
  }

  /**
   * Get multiple values
   */
  async mget<T>(keys: string[]): Promise<(T | null)[]> {
    const results = [];
    for (const key of keys) {
      results.push(await this.get<T>(key));
    }
    return results;
  }

  /**
   * Set multiple values
   */
  async mset<T>(items: { key: string; value: T; ttl?: number }[]): Promise<void> {
    await Promise.all(items.map(item => this.set(item.key, item.value, item.ttl)));
  }

  /**
   * Increment value
   */
  async increment(key: string, amount = 1): Promise<number | null> {
    try {
      const currentValue = await this.get<number>(key) || 0;
      const newValue = currentValue + amount;
      await this.set(key, newValue);
      return newValue;
    } catch (error) {
      this.emit('error', { operation: 'increment', key, error });
      return null;
    }
  }

  /**
   * Decrement value
   */
  async decrement(key: string, amount = 1): Promise<number | null> {
    return this.increment(key, -amount);
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    const totalRequests = this.stats.hits + this.stats.misses;
    this.stats.hitRate = totalRequests > 0 ? (this.stats.hits / totalRequests) * 100 : 0;
    return { ...this.stats };
  }

  /**
   * Warm up cache
   */
  async warmCache(keys: string[]): Promise<void> {
    if (!this.config.warming.enabled) return;

    const batchSize = this.config.warming.prefetchCount;
    const delay = this.config.warming.prefetchDelay;

    for (let i = 0; i < keys.length; i += batchSize) {
      const batch = keys.slice(i, i + batchSize);
      await Promise.all(batch.map(key => this.preload(key)));
      if (i + batchSize < keys.length) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * Get cache size
   */
  size(): number {
    return this.localCache.size;
  }

  /**
   * Get cache keys
   */
  keys(): string[] {
    return Array.from(this.localCache.keys());
  }

  /**
   * Get cache values
   */
  values<T = any>(): CacheItem<T>[] {
    return Array.from(this.localCache.values());
  }

  /**
   * Cleanup expired items
   */
  private async cleanup(): Promise<void> {
    const now = Date.now();
    const expiredKeys: string[] = [];

    // Check local cache
    for (const [key, item] of this.localCache) {
      if (!this.isValid(item)) {
        expiredKeys.push(key);
      }
    }

    // Remove expired items
    for (const key of expiredKeys) {
      this.localCache.delete(key);
      await this.memory.deleteCacheItem(key);
      this.stats.evictions++;
    }

    // Compact local cache if needed
    if (this.localCache.size > this.config.layers.memory.maxSize) {
      this.compact();
    }

    this.emit('cleanup', { expired: expiredKeys.length, remaining: this.localCache.size });
  }

  /**
   * Check if item is valid
   */
  private isValid<T>(item: CacheItem<T> | undefined): boolean {
    if (!item) return false;
    return Date.now() - item.createdAt < item.ttl;
  }

  /**
   * Add item to local cache with size limits
   */
  private addToLocalCache<T>(item: CacheItem<T>): void {
    // Check size limit
    if (this.localCache.size >= this.config.layers.memory.maxSize) {
      this.evictLRU();
    }

    this.localCache.set(item.key, item);

    // Update stats
    this.stats.size++;
    this.stats.activeKeys++;
    if (item.size) {
      this.stats.sizeBytes += item.size;
    }
  }

  /**
   * Evict least recently used item
   */
  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Date.now();

    for (const [key, item] of this.localCache) {
      if (item.accessedAt < oldestTime) {
        oldestTime = item.accessedAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const item = this.localCache.get(oldestKey);
      this.localCache.delete(oldestKey);
      this.stats.evictions++;
      this.stats.activeKeys--;
      if (item?.size) {
        this.stats.sizeBytes -= item.size;
      }
    }
  }

  /**
   * Compact cache
   */
  private compact(): void {
    const items = Array.from(this.localCache.entries());
    items.sort((a, b) => a[1].accessedAt - b[1].accessedAt);
    const keepCount = Math.floor(this.config.layers.memory.maxSize * 0.8);

    for (let i = keepCount; i < items.length; i++) {
      const entry = items[i];
      if (!entry) continue;
      const [key, item] = entry;
      this.localCache.delete(key);
      this.stats.evictions++;
      this.stats.activeKeys--;
      if (item.size) {
        this.stats.sizeBytes -= item.size;
      }
    }
  }

  /**
   * Update hit rate
   */
  private updateHitRate(): void {
    const total = this.stats.hits + this.stats.misses;
    if (total > 0) {
      this.stats.hitRate = (this.stats.hits / total) * 100;
    }
  }

  /**
   * Calculate size of value
   */
  private calculateSize(value: any): number {
    return JSON.stringify(value).length * 2; // Rough estimate
  }

  /**
   * Compress value
   */
  private async compress(value: any): Promise<any> {
    // In a real implementation, use a compression library like pako
    // For now, just return the value
    return value;
  }

  /**
   * Preload cache value
   */
  private async preload<T>(key: string): Promise<void> {
    try {
      // In a real implementation, this would fetch from database or external service
      // For now, just check if it exists
      await this.get<T>(key);
    } catch (error) {
      this.emit('error', { operation: 'preload', key, error });
    }
  }
}