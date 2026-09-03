/**
 * Generic LRU (Least Recently Used) Cache implementation.
 *
 * Uses a Map-based approach where promotion to MRU (Most Recently Used)
 * position is achieved by delete + re-set on access. This leverages the
 * fact that Map iteration order follows insertion order.
 *
 * @example
 * ```ts
 * const cache = new LRUCache<string, number>({ maxSize: 100 });
 * cache.set('key', 42);
 * const value = cache.get('key'); // 42, promotes to MRU
 * ```
 */
export class LRUCache<K, V> {
  private store: Map<K, V>;
  readonly maxSize: number;

  constructor(options?: { maxSize?: number }) {
    this.maxSize = options?.maxSize ?? 500;
    this.store = new Map();
  }

  /**
   * Get a value from the cache.
   * Returns undefined if the key is not present.
   * Promotes the key to MRU position on hit.
   */
  get(key: K): V | undefined {
    if (!this.store.has(key)) {
      return undefined;
    }
    const value = this.store.get(key)!;
    // Promote to MRU: delete and re-insert
    this.store.delete(key);
    this.store.set(key, value);
    return value;
  }

  /**
   * Set a value in the cache.
   * If the cache is full, evicts the LRU entry before inserting.
   * If the key already exists, updates the value and promotes to MRU.
   */
  set(key: K, value: V): void {
    if (this.store.has(key)) {
      // Update existing: delete and re-insert to promote to MRU
      this.store.delete(key);
    } else if (this.store.size >= this.maxSize) {
      // Evict LRU entry (first entry in Map iteration order)
      const lruKey = this.store.keys().next().value;
      if (lruKey !== undefined) {
        this.store.delete(lruKey);
      }
    }
    this.store.set(key, value);
  }

  /**
   * Check if a key exists in the cache.
   * Note: does NOT promote to MRU (use get() for that).
   */
  has(key: K): boolean {
    return this.store.has(key);
  }

  /**
   * Delete a key from the cache.
   * Returns true if the key was present, false otherwise.
   */
  delete(key: K): boolean {
    return this.store.delete(key);
  }

  /**
   * Clear all entries from the cache.
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Get the current number of entries in the cache.
   */
  get size(): number {
    return this.store.size;
  }
}
