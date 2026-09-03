import { useCallback, useRef, useState } from 'react';
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
  refreshApiKeys: () => Promise<Record<string, string>>;
} {
  const [resolvedApiKeys, setResolvedApiKeys] = useState(initialApiKeys);
  const isInitializedRef = useRef(false);

  const refreshApiKeys = useCallback(async () => {
    try {
      const settings = await loadSettings();
      const keys = await getApiKeys(settings);
      setResolvedApiKeys(keys);
      return keys;
    } catch {
      return initialApiKeys;
    }
  }, [initialApiKeys]);

  // Only refresh once on mount (not on every render)
  if (!isInitializedRef.current) {
    isInitializedRef.current = true;
    void refreshApiKeys();
  }

  return { resolvedApiKeys, refreshApiKeys };
}
