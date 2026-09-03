import { useState, useMemo, useCallback } from 'react';

/**
 * Options for the useSearchFilter hook.
 */
export interface UseSearchFilterOptions<T> {
  /** The items to filter */
  items: T[];
  
  /** Function to extract searchable text from an item */
  getSearchableText: (item: T) => string;
  
  /** Optional function to score items for ranking */
  scoreItem?: (item: T, query: string) => number;
  
  /** Debounce delay in milliseconds (default: 0) */
  debounceMs?: number;
}

/**
 * Result of the useSearchFilter hook.
 */
export interface UseSearchFilterResult<T> {
  /** The current search query */
  query: string;
  
  /** Set the search query */
  setQuery: (query: string) => void;
  
  /** The filtered and sorted items */
  filteredItems: T[];
  
  /** Whether search is active (query is not empty) */
  isSearchActive: boolean;
  
  /** Clear the search query */
  clearSearch: () => void;
  
  /** Total number of items before filtering */
  totalCount: number;
  
  /** Number of items after filtering */
  filteredCount: number;
}

/**
 * A hook for filtering and searching through a list of items.
 * 
 * Features:
 * - Case-insensitive substring matching
 * - Fallback to subsequence matching
 * - Optional custom scoring function
 * - Debounced search (optional)
 * - Match highlighting support
 */
export function useSearchFilter<T>({
  items,
  getSearchableText,
  scoreItem,
  debounceMs = 0,
}: UseSearchFilterOptions<T>): UseSearchFilterResult<T> {
  const [query, setQuery] = useState('');

  // Default scoring function based on substring and subsequence matching
  const defaultScoreItem = useCallback(
    (item: T, searchQuery: string): number => {
      const normalizedQuery = searchQuery.toLowerCase().trim();
      if (!normalizedQuery) {
        return 1;
      }

      const haystack = getSearchableText(item).toLowerCase();
      if (!haystack) {
        return 0;
      }

      // Exact match
      if (haystack === normalizedQuery) {
        return 1000;
      }

      // Starts with query
      if (haystack.startsWith(normalizedQuery)) {
        return 900;
      }

      // Contains query
      if (haystack.includes(normalizedQuery)) {
        return 700;
      }

      // Subsequence match
      let index = 0;
      for (const char of haystack) {
        if (char === normalizedQuery[index]) {
          index++;
          if (index === normalizedQuery.length) {
            return 500;
          }
        }
      }

      return 0;
    },
    [getSearchableText]
  );

  const scoringFunction = scoreItem || defaultScoreItem;

  // Filter and sort items based on query
  const filteredItems = useMemo(() => {
    if (!query.trim()) {
      return items;
    }

    return items
      .map((item, index) => ({
        item,
        index,
        score: scoringFunction(item, query),
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ item }) => item);
  }, [items, query, scoringFunction]);

  const clearSearch = useCallback(() => {
    setQuery('');
  }, []);

  return {
    query,
    setQuery,
    filteredItems,
    isSearchActive: query.trim().length > 0,
    clearSearch,
    totalCount: items.length,
    filteredCount: filteredItems.length,
  };
}

/**
 * Utility function to find match indices for highlighting.
 * Returns a set of indices that match the query in the label.
 */
export function findMatchIndices(query: string, label: string): Set<number> {
  const q = query.toLowerCase().trim();
  if (!q) return new Set();

  const lower = label.toLowerCase();

  // Try contiguous substring match first
  const idx = lower.indexOf(q);
  if (idx !== -1) {
    const result = new Set<number>();
    for (let i = idx; i < idx + q.length; i++) {
      result.add(i);
    }
    return result;
  }

  // Fall back to subsequence matching
  const result = new Set<number>();
  let qi = 0;
  for (let i = 0; i < label.length; i++) {
    if (qi < q.length && lower[i] === q[qi]) {
      result.add(i);
      qi++;
    }
  }
  return result;
}

/**
 * Utility function to check if a string is a subsequence of another string.
 */
export function isSubsequence(query: string, target: string): boolean {
  let index = 0;
  for (const char of target) {
    if (char === query[index]) {
      index++;
      if (index === query.length) {
        return true;
      }
    }
  }
  return query.length === 0;
}

/**
 * Utility function to normalize text for search comparison.
 */
export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9@/]+/g, ' ')
    .trim();
}