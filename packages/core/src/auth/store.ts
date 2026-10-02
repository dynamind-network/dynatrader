/**
 * Auth Profile Store
 *
 * File-based persistence for auth profiles (auth-profiles.json).
 * Handles loading, saving, and merging of profile stores.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { AuthProfileCredential, AuthProfileStore, ProfileUsageStats } from './types.js';

const AUTH_STORE_VERSION = 1;

/**
 * Resolve the auth-profiles.json path for a workspace.
 */
export function resolveAuthStorePath(workspacePath: string): string {
  return path.join(workspacePath, 'auth-profiles.json');
}

/**
 * Create an empty auth profile store.
 */
export function createEmptyStore(): AuthProfileStore {
  return {
    version: AUTH_STORE_VERSION,
    profiles: {},
    order: {},
    lastGood: {},
    usageStats: {},
  };
}

/**
 * Load the auth profile store from disk.
 * Returns an empty store if the file doesn't exist.
 */
export function loadAuthProfileStore(workspacePath: string): AuthProfileStore {
  const storePath = resolveAuthStorePath(workspacePath);
  try {
    if (!fs.existsSync(storePath)) {
      return createEmptyStore();
    }
    const raw = fs.readFileSync(storePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AuthProfileStore>;
    return {
      version: parsed.version ?? AUTH_STORE_VERSION,
      profiles: parsed.profiles ?? {},
      order: parsed.order ?? {},
      lastGood: parsed.lastGood ?? {},
      usageStats: parsed.usageStats ?? {},
    };
  } catch {
    return createEmptyStore();
  }
}

/**
 * Save the auth profile store to disk.
 */
export function saveAuthProfileStore(store: AuthProfileStore, workspacePath: string): void {
  const storePath = resolveAuthStorePath(workspacePath);
  const dir = path.dirname(storePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

/**
 * List all profile IDs for a given provider.
 */
export function listProfilesForProvider(store: AuthProfileStore, provider: string): string[] {
  return Object.entries(store.profiles)
    .filter(([, cred]) => cred.provider === provider)
    .map(([id]) => id);
}

/**
 * Deduplicate profile IDs while preserving order.
 */
export function dedupeProfileIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Get the API key from a credential.
 */
export function getCredentialKey(cred: AuthProfileCredential): string | null {
  if (cred.type === 'api_key') {
    return cred.key?.trim() || null;
  }
  if (cred.type === 'token') {
    return cred.token?.trim() || null;
  }
  return null;
}

/**
 * Check if a credential is valid and not expired.
 */
export function isCredentialValid(cred: AuthProfileCredential): boolean {
  if (cred.type === 'api_key') {
    return Boolean(cred.key?.trim());
  }
  if (cred.type === 'token') {
    if (!cred.token?.trim()) return false;
    if (typeof cred.expires === 'number' && cred.expires > 0 && Date.now() >= cred.expires) {
      return false;
    }
    return true;
  }
  return false;
}
