/**
 * Dyna-Trader Performance Core Package
 *
 * Provides performance optimization features including caching, indexing, and connection pooling
 */

export * from './cache';
export * from './indexing';
export * from './pooling';
export * from './monitoring';
export * from './optimizations';

// Re-export key types
export type { CacheConfig, CacheItem } from './cache';
export type { IndexConfig, IndexStats } from './indexing';
export type { PoolConfig, PoolStats } from './pooling';
export type { Metrics } from './monitoring';
export type { OptimizationResult } from './optimizations';

// Export main classes
export { CacheService } from './cache';
export { IndexManager } from './indexing';
export { ConnectionPool } from './pooling';
export { PerformanceMonitor } from './monitoring';
export { PerformanceOptimizer } from './optimizations';