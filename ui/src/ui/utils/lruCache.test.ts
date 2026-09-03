import { describe, it, expect } from 'vitest';
import { LRUCache } from './lruCache';

/**
 * Tests for the generic LRUCache utility.
 *
 * The LRUCache uses a Map-based implementation where promotion to MRU
 * position is achieved by delete + re-set on access.
 */

describe('LRUCache', () => {
  describe('constructor', () => {
    it('creates cache with default max size of 500', () => {
      const cache = new LRUCache<string, number>();
      expect(cache.maxSize).toBe(500);
      expect(cache.size).toBe(0);
    });

    it('creates cache with custom max size', () => {
      const cache = new LRUCache<string, number>({ maxSize: 10 });
      expect(cache.maxSize).toBe(10);
      expect(cache.size).toBe(0);
    });

    it('creates cache with maxSize of 1', () => {
      const cache = new LRUCache<string, number>({ maxSize: 1 });
      expect(cache.maxSize).toBe(1);
    });
  });

  describe('set and get', () => {
    it('stores and retrieves a value', () => {
      const cache = new LRUCache<string, number>();
      cache.set('key1', 42);
      expect(cache.get('key1')).toBe(42);
    });

    it('returns undefined for missing keys', () => {
      const cache = new LRUCache<string, number>();
      expect(cache.get('nonexistent')).toBe(undefined);
    });

    it('overwrites existing keys', () => {
      const cache = new LRUCache<string, number>();
      cache.set('key', 1);
      cache.set('key', 2);
      expect(cache.get('key')).toBe(2);
      expect(cache.size).toBe(1);
    });

    it('stores different types of values', () => {
      const cache = new LRUCache<string, unknown>();
      cache.set('str', 'hello');
      cache.set('num', 123);
      cache.set('obj', { a: 1 });
      cache.set('arr', [1, 2, 3]);
      cache.set('bool', true);
      cache.set('null', null);

      expect(cache.get('str')).toBe('hello');
      expect(cache.get('num')).toBe(123);
      expect(cache.get('obj')).toEqual({ a: 1 });
      expect(cache.get('arr')).toEqual([1, 2, 3]);
      expect(cache.get('bool')).toBe(true);
      expect(cache.get('null')).toBe(null);
    });

    it('works with non-string keys', () => {
      const cache = new LRUCache<number, string>();
      cache.set(1, 'one');
      cache.set(2, 'two');
      expect(cache.get(1)).toBe('one');
      expect(cache.get(2)).toBe('two');
    });
  });

  describe('has', () => {
    it('returns true for existing keys', () => {
      const cache = new LRUCache<string, number>();
      cache.set('key', 1);
      expect(cache.has('key')).toBe(true);
    });

    it('returns false for missing keys', () => {
      const cache = new LRUCache<string, number>();
      expect(cache.has('key')).toBe(false);
    });

    it('returns false after deletion', () => {
      const cache = new LRUCache<string, number>();
      cache.set('key', 1);
      cache.delete('key');
      expect(cache.has('key')).toBe(false);
    });
  });

  describe('delete', () => {
    it('removes a key from the cache', () => {
      const cache = new LRUCache<string, number>();
      cache.set('key', 1);
      const result = cache.delete('key');
      expect(result).toBe(true);
      expect(cache.has('key')).toBe(false);
      expect(cache.get('key')).toBe(undefined);
    });

    it('returns false when deleting non-existent key', () => {
      const cache = new LRUCache<string, number>();
      const result = cache.delete('nonexistent');
      expect(result).toBe(false);
    });

    it('reduces cache size', () => {
      const cache = new LRUCache<string, number>();
      cache.set('a', 1);
      cache.set('b', 2);
      expect(cache.size).toBe(2);
      cache.delete('a');
      expect(cache.size).toBe(1);
    });
  });

  describe('clear', () => {
    it('removes all entries', () => {
      const cache = new LRUCache<string, number>();
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.has('a')).toBe(false);
      expect(cache.has('b')).toBe(false);
      expect(cache.has('c')).toBe(false);
    });

    it('allows reuse after clearing', () => {
      const cache = new LRUCache<string, number>();
      cache.set('a', 1);
      cache.clear();
      cache.set('b', 2);
      expect(cache.size).toBe(1);
      expect(cache.get('b')).toBe(2);
    });
  });

  describe('size', () => {
    it('tracks number of entries', () => {
      const cache = new LRUCache<string, number>();
      expect(cache.size).toBe(0);
      cache.set('a', 1);
      expect(cache.size).toBe(1);
      cache.set('b', 2);
      expect(cache.size).toBe(2);
    });

    it('does not exceed maxSize', () => {
      const cache = new LRUCache<string, number>({ maxSize: 3 });
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.set('d', 4);
      expect(cache.size).toBe(3);
    });
  });

  describe('eviction', () => {
    it('evicts the least recently used entry when full', () => {
      const cache = new LRUCache<string, number>({ maxSize: 3 });
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      // Cache is full: [a, b, c] (a is LRU)
      cache.set('d', 4);
      // Should evict 'a' (LRU)
      expect(cache.get('a')).toBe(undefined);
      expect(cache.get('b')).toBe(2);
      expect(cache.get('c')).toBe(3);
      expect(cache.get('d')).toBe(4);
    });

    it('evicts only one entry when adding to full cache', () => {
      const cache = new LRUCache<string, number>({ maxSize: 2 });
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      expect(cache.size).toBe(2);
      expect(cache.get('a')).toBe(undefined);
      expect(cache.get('b')).toBe(2);
      expect(cache.get('c')).toBe(3);
    });

    it('evicts correct entry after access pattern changes LRU order', () => {
      const cache = new LRUCache<string, number>({ maxSize: 3 });
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      // Access 'a' to promote it to MRU: order becomes [b, c, a]
      cache.get('a');
      // Now 'b' is LRU
      cache.set('d', 4);
      expect(cache.get('b')).toBe(undefined);
      expect(cache.get('a')).toBe(1);
      expect(cache.get('c')).toBe(3);
      expect(cache.get('d')).toBe(4);
    });
  });

  describe('MRU promotion', () => {
    it('promotes entry to MRU position on get', () => {
      const cache = new LRUCache<string, number>({ maxSize: 3 });
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      // Order: [a, b, c] - 'a' is LRU
      // Access 'a' to promote: order becomes [b, c, a]
      cache.get('a');
      // Add new entry - should evict 'b' (now LRU), not 'a'
      cache.set('d', 4);
      expect(cache.get('a')).toBe(1); // 'a' survived
      expect(cache.get('b')).toBe(undefined); // 'b' was evicted
    });

    it('promotes entry to MRU position on set (update)', () => {
      const cache = new LRUCache<string, number>({ maxSize: 3 });
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      // Order: [a, b, c] - 'a' is LRU
      // Update 'a' to promote: order becomes [b, c, a]
      cache.set('a', 10);
      // Add new entry - should evict 'b' (now LRU)
      cache.set('d', 4);
      expect(cache.get('a')).toBe(10); // 'a' survived with new value
      expect(cache.get('b')).toBe(undefined); // 'b' was evicted
    });

    it('maintains correct eviction order after multiple promotions', () => {
      const cache = new LRUCache<string, number>({ maxSize: 4 });
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.set('d', 4);
      // Order: [a, b, c, d]

      // Access 'a' and 'b' to promote them
      cache.get('a'); // Order: [b, c, d, a]
      cache.get('b'); // Order: [c, d, a, b]

      // Add two new entries - should evict 'c' then 'd'
      cache.set('e', 5); // Evicts 'c', Order: [d, a, b, e]
      expect(cache.get('c')).toBe(undefined);

      cache.set('f', 6); // Evicts 'd', Order: [a, b, e, f]
      expect(cache.get('d')).toBe(undefined);

      // 'a' and 'b' should still be present
      expect(cache.get('a')).toBe(1);
      expect(cache.get('b')).toBe(2);
      expect(cache.get('e')).toBe(5);
      expect(cache.get('f')).toBe(6);
    });
  });

  describe('edge cases', () => {
    it('handles maxSize of 1 correctly', () => {
      const cache = new LRUCache<string, number>({ maxSize: 1 });
      cache.set('a', 1);
      expect(cache.get('a')).toBe(1);
      cache.set('b', 2);
      expect(cache.get('a')).toBe(undefined);
      expect(cache.get('b')).toBe(2);
    });

    it('handles empty cache operations gracefully', () => {
      const cache = new LRUCache<string, number>();
      expect(cache.get('x')).toBe(undefined);
      expect(cache.has('x')).toBe(false);
      expect(cache.delete('x')).toBe(false);
      expect(cache.size).toBe(0);
    });

    it('handles undefined as a valid value', () => {
      const cache = new LRUCache<string, number | undefined>();
      cache.set('key', undefined);
      expect(cache.has('key')).toBe(true);
      expect(cache.get('key')).toBe(undefined);
    });

    it('handles falsy values correctly', () => {
      const cache = new LRUCache<string, unknown>();
      cache.set('zero', 0);
      cache.set('empty', '');
      cache.set('false', false);

      expect(cache.get('zero')).toBe(0);
      expect(cache.get('empty')).toBe('');
      expect(cache.get('false')).toBe(false);
    });

    it('handles large number of entries', () => {
      const cache = new LRUCache<number, number>({ maxSize: 1000 });
      for (let i = 0; i < 1000; i++) {
        cache.set(i, i * 10);
      }
      expect(cache.size).toBe(1000);
      // Access key 0 to promote it to MRU
      expect(cache.get(0)).toBe(0);
      expect(cache.get(999)).toBe(9990);

      // Adding one more should evict key 1 (now LRU since key 0 was promoted)
      cache.set(1000, 10000);
      expect(cache.size).toBe(1000);
      expect(cache.get(1)).toBe(undefined);
      expect(cache.get(0)).toBe(0); // key 0 survived (was promoted)
      expect(cache.get(1000)).toBe(10000);
    });
  });
});
