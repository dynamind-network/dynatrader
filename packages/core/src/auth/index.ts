/**
 * Auth Profiles — Multi-Key API Rotation for DynaTrader
 *
 * Provides API key rotation across multiple profiles per provider,
 * with cooldown tracking, round-robin distribution, and fallback
 * to environment variables.
 *
 * Workspace format (auth-profiles.json):
 * {
 *   "profiles": {
 *     "openai-1": { "type": "api_key", "provider": "openai", "key": "sk-..." },
 *     "openai-2": { "type": "api_key", "provider": "openai", "key": "sk-..." }
 *   },
 *   "order": { "openai": ["openai-1", "openai-2"] }
 * }
 */

export type {
  ApiKeyProfile,
  AuthProfileCredential,
  AuthProfileConfig,
  AuthConfig,
  AuthProfileFailureReason,
  AuthProfileStore,
  ProfileUsageStats,
  ResolvedProviderAuth,
  TokenProfile,
} from './types.js';

export {
  isProfileInCooldown,
  getSoonestCooldownExpiry,
  clearExpiredCooldowns,
  markAuthProfileUsed,
  markAuthProfileFailure,
  markAuthProfileCooldown,
  clearAuthProfileCooldown,
  calculateAuthProfileCooldownMs,
} from './usage.js';

export {
  loadAuthProfileStore,
  saveAuthProfileStore,
  resolveAuthStorePath,
  createEmptyStore,
  listProfilesForProvider,
  dedupeProfileIds,
  getCredentialKey,
  isCredentialValid,
} from './store.js';

export { resolveAuthProfileOrder } from './order.js';

import type { AuthProfileStore, ResolvedProviderAuth } from './types.js';
import { loadAuthProfileStore, saveAuthProfileStore, getCredentialKey, isCredentialValid } from './store.js';
import { resolveAuthProfileOrder } from './order.js';
import { markAuthProfileUsed, markAuthProfileFailure, isProfileInCooldown } from './usage.js';

/**
 * Auth Profile Manager
 *
 * High-level interface for managing API key rotation.
 * Integrates with ModelRouter to provide per-provider key rotation.
 */
export class AuthProfileManager {
  private store: AuthProfileStore;
  private workspacePath: string;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.store = loadAuthProfileStore(workspacePath);
  }

  /**
   * Reload the store from disk (e.g., after external edits).
   */
  reload(): void {
    this.store = loadAuthProfileStore(this.workspacePath);
  }

  /**
   * Get the current store state.
   */
  getStore(): AuthProfileStore {
    return this.store;
  }

  /**
   * Resolve the next API key for a provider, using rotation order.
   * Falls back to envVar if no profiles are available.
   */
  resolveApiKey(provider: string, envVar?: string): ResolvedProviderAuth | null {
    const order = resolveAuthProfileOrder({
      store: this.store,
      provider,
    });

    // Try profiles first
    for (const profileId of order) {
      const cred = this.store.profiles[profileId];
      if (!cred) continue;
      if (isProfileInCooldown(this.store, profileId)) continue;

      const key = getCredentialKey(cred);
      if (!key) continue;

      return {
        apiKey: key,
        profileId,
        source: 'profile',
        mode: cred.type === 'token' ? 'token' : 'api_key',
      };
    }

    // Fall back to environment variable
    if (envVar) {
      const envKey = process.env[envVar];
      if (envKey?.trim()) {
        return {
          apiKey: envKey.trim(),
          profileId: `env:${envVar}`,
          source: 'env',
          mode: 'api_key',
        };
      }
    }

    return null;
  }

  /**
   * Get all ordered profile IDs for a provider.
   */
  getProfileOrder(provider: string): string[] {
    return resolveAuthProfileOrder({
      store: this.store,
      provider,
    });
  }

  /**
   * Check if any profiles are available for a provider (not all in cooldown).
   */
  hasAvailableProfiles(provider: string): boolean {
    const order = this.getProfileOrder(provider);
    return order.some((id) => !isProfileInCooldown(this.store, id));
  }

  /**
   * Mark a profile as successfully used.
   */
  markUsed(profileId: string): void {
    markAuthProfileUsed(this.store, profileId);
    saveAuthProfileStore(this.store, this.workspacePath);
  }

  /**
   * Mark a profile as failed (applies cooldown).
   */
  markFailed(profileId: string, reason: 'auth' | 'rate_limit' | 'billing' | 'timeout' | 'unknown' = 'unknown'): void {
    markAuthProfileFailure(this.store, profileId, reason);
    saveAuthProfileStore(this.store, this.workspacePath);
  }

  /**
   * Manually clear cooldown for a profile.
   */
  clearCooldown(profileId: string): void {
    const stats = this.store.usageStats?.[profileId];
    if (!stats) return;
    stats.errorCount = 0;
    stats.cooldownUntil = undefined;
    stats.disabledUntil = undefined;
    stats.disabledReason = undefined;
    stats.failureCounts = undefined;
    saveAuthProfileStore(this.store, this.workspacePath);
  }
}
