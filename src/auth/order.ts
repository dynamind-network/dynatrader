/**
 * Auth Profile Order Resolution
 *
 * Determines the order in which to try API key profiles for a provider.
 * Supports explicit order, round-robin by lastUsed, and cooldown-aware sorting.
 */

import type { AuthProfileStore } from './types.js';
import {
  clearExpiredCooldowns,
  isProfileInCooldown,
} from './usage.js';
import { dedupeProfileIds, isCredentialValid, listProfilesForProvider } from './store.js';

/**
 * Resolve the ordered list of profile IDs for a provider.
 *
 * Priority:
 * 1. Explicit order from store.order or config
 * 2. Round-robin by lastUsed (oldest first)
 * 3. Cooldown-aware: available profiles first, then cooldown-sorted
 */
export function resolveAuthProfileOrder(params: {
  store: AuthProfileStore;
  provider: string;
  preferredProfile?: string;
  explicitOrder?: string[];
}): string[] {
  const { store, provider, preferredProfile, explicitOrder } = params;
  const now = Date.now();

  // Clear expired cooldowns first
  clearExpiredCooldowns(store, now);

  // Get base order from explicit config or all profiles for provider
  const baseOrder = explicitOrder ?? listProfilesForProvider(store, provider);
  if (baseOrder.length === 0) return [];

  // Filter to valid profiles
  const isValidProfile = (profileId: string): boolean => {
    const cred = store.profiles[profileId];
    if (!cred) return false;
    if (cred.provider !== provider) return false;
    return isCredentialValid(cred);
  };

  const filtered = dedupeProfileIds(baseOrder.filter(isValidProfile));
  if (filtered.length === 0) return [];

  // If explicit order, respect it but apply cooldown sorting
  if (explicitOrder && explicitOrder.length > 0) {
    const available: string[] = [];
    const inCooldown: Array<{ profileId: string; cooldownUntil: number }> = [];

    for (const profileId of filtered) {
      if (isProfileInCooldown(store, profileId)) {
        const stats = store.usageStats?.[profileId];
        const cooldownUntil = stats?.cooldownUntil ?? now;
        inCooldown.push({ profileId, cooldownUntil });
      } else {
        available.push(profileId);
      }
    }

    const cooldownSorted = inCooldown
      .sort((a, b) => a.cooldownUntil - b.cooldownUntil)
      .map((e) => e.profileId);

    const ordered = [...available, ...cooldownSorted];

    if (preferredProfile && ordered.includes(preferredProfile)) {
      return [preferredProfile, ...ordered.filter((e) => e !== preferredProfile)];
    }
    return ordered;
  }

  // Round-robin: sort by lastUsed (oldest first)
  const scored = filtered.map((profileId) => {
    const lastUsed = store.usageStats?.[profileId]?.lastUsed ?? 0;
    return { profileId, lastUsed };
  });

  const available: string[] = [];
  const inCooldown: string[] = [];

  for (const { profileId } of scored) {
    if (isProfileInCooldown(store, profileId)) {
      inCooldown.push(profileId);
    } else {
      available.push(profileId);
    }
  }

  // Sort available by lastUsed (oldest first for round-robin)
  const availableSorted = scored
    .filter((s) => available.includes(s.profileId))
    .sort((a, b) => a.lastUsed - b.lastUsed)
    .map((s) => s.profileId);

  // Sort cooldown profiles by expiry (soonest first)
  const cooldownSorted = inCooldown
    .map((profileId) => ({
      profileId,
      cooldownUntil: store.usageStats?.[profileId]?.cooldownUntil ?? now,
    }))
    .sort((a, b) => a.cooldownUntil - b.cooldownUntil)
    .map((e) => e.profileId);

  const sorted = [...availableSorted, ...cooldownSorted];

  if (preferredProfile && sorted.includes(preferredProfile)) {
    return [preferredProfile, ...sorted.filter((e) => e !== preferredProfile)];
  }

  return sorted;
}
