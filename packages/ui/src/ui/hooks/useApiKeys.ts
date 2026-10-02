import { useCallback, useEffect, useRef, useState } from 'react';
import { loadSettings, getApiKeys } from '../../config/settings.js';

/**
 * Manages API key resolution from auth store, config, and settings.
 *
 * On mount, refreshes all provider API keys from multiple sources:
 * - Auth store (~/.dynamind/auth.json)
 * - Config (~/.dynamind/config.json, .dynamind/config.json)
 * - Settings (.dynamind/settings.json)
 * - Environment variables (process.env)
 */
export function useApiKeys(initialApiKeys: Record<string, string>): {
  resolvedApiKeys: Record<string, string>;
  isLoading: boolean;
  refreshApiKeys: () => Promise<Record<string, string>>;
} {
  const [resolvedApiKeys, setResolvedApiKeys] = useState(initialApiKeys);
  const [isLoading, setIsLoading] = useState(true);
  const isInitializedRef = useRef(false);

  const refreshApiKeys = useCallback(async () => {
    setIsLoading(true);
    try {
      const settings = await loadSettings();
      const keys = await getApiKeys(settings);
      setResolvedApiKeys(keys);
      return keys;
    } catch {
      return initialApiKeys;
    } finally {
      setIsLoading(false);
    }
  }, [initialApiKeys]);

  // Load credentials after commit so rendering stays pure. Never let a submit
  // race this first asynchronous lookup.
  useEffect(() => {
    if (isInitializedRef.current) return;
    isInitializedRef.current = true;
    void refreshApiKeys();
  }, [refreshApiKeys]);

  return { resolvedApiKeys, isLoading, refreshApiKeys };
}

