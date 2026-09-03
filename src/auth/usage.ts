/**
 * Auth Profile Usage Tracking
 *
 * Handles cooldown calculation, failure tracking, and usage stats updates
 * for API key rotation with exponential backoff.
 */

import type {
  AuthProfileFailureReason,
  AuthProfileStore,
  ProfileUsageStats,
} from './types.js';

const FAILURE_REASON_PRIORITY: AuthProfileFailureReason[] = [
  'auth_permanent',
  'auth',
  'billing',
  'rate_limit',
  'timeout',
  'model_not_found',
  'unknown',
];

/**
 * Check if a profile is currently in cooldown.
 */
export function isProfileInCooldown(store: AuthProfileStore, profileId: string): boolean {
  const stats = store.usageStats?.[profileId];
  if (!stats) return false;
  const unusableUntil = resolveProfileUnusableUntil(stats);
  return unusableUntil !== null ? Date.now() < unusableUntil : false;
}

/**
 * Get the soonest unusable timestamp across multiple profiles.
 */
export function getSoonestCooldownExpiry(
  store: AuthProfileStore,
  profileIds: string[],
): number | null {
  let soonest: number | null = null;
  for (const id of profileIds) {
    const stats = store.usageStats?.[id];
    if (!stats) continue;
    const until = resolveProfileUnusableUntil(stats);
    if (until !== null && (soonest === null || until < soonest)) {
      soonest = until;
    }
  }
  return soonest;
}

/**
 * Clear expired cooldowns from all profiles.
 *
 * When cooldownUntil or disabledUntil has passed, the corresponding fields
 * are removed and error counters are reset so the profile gets a fresh start.
 */
export function clearExpiredCooldowns(store: AuthProfileStore, now?: number): boolean {
  const usageStats = store.usageStats;
  if (!usageStats) return false;

  const ts = now ?? Date.now();
  let mutated = false;

  for (const [profileId, stats] of Object.entries(usageStats)) {
    if (!stats) continue;

    let profileMutated = false;
    const cooldownExpired =
      typeof stats.cooldownUntil === 'number' && stats.cooldownUntil > 0 && ts >= stats.cooldownUntil;
    const disabledExpired =
      typeof stats.disabledUntil === 'number' && stats.disabledUntil > 0 && ts >= stats.disabledUntil;

    if (cooldownExpired) {
      stats.cooldownUntil = undefined;
      profileMutated = true;
    }
    if (disabledExpired) {
      stats.disabledUntil = undefined;
      stats.disabledReason = undefined;
      profileMutated = true;
    }

    // Reset error counters when ALL cooldowns have expired
    if (profileMutated && !resolveProfileUnusableUntil(stats)) {
      stats.errorCount = 0;
      stats.failureCounts = undefined;
    }

    if (profileMutated) {
      usageStats[profileId] = stats;
      mutated = true;
    }
  }

  return mutated;
}

/**
 * Mark a profile as successfully used. Resets error count and updates lastUsed.
 */
export function markAuthProfileUsed(store: AuthProfileStore, profileId: string): void {
  if (!store.profiles[profileId]) return;

  store.usageStats = store.usageStats ?? {};
  store.usageStats[profileId] = {
    ...store.usageStats[profileId],
    lastUsed: Date.now(),
    errorCount: 0,
    cooldownUntil: undefined,
    disabledUntil: undefined,
    disabledReason: undefined,
    failureCounts: undefined,
  };
}

/**
 * Calculate cooldown duration in ms using exponential backoff.
 * Times: 1min, 5min, 25min, max 1 hour.
 */
export function calculateAuthProfileCooldownMs(errorCount: number): number {
  const normalized = Math.max(1, errorCount);
  return Math.min(
    60 * 60 * 1000, // 1 hour max
    60 * 1000 * 5 ** Math.min(normalized - 1, 3),
  );
}

/**
 * Mark a profile as failed for a specific reason.
 * Billing and permanent-auth failures get longer disable windows.
 */
export function markAuthProfileFailure(
  store: AuthProfileStore,
  profileId: string,
  reason: AuthProfileFailureReason,
): void {
  const profile = store.profiles[profileId];
  if (!profile) return;

  store.usageStats = store.usageStats ?? {};
  const existing = store.usageStats[profileId] ?? {};
  const now = Date.now();

  const windowMs = 24 * 60 * 60 * 1000; // 24h failure window
  const windowExpired =
    typeof existing.lastFailureAt === 'number' &&
    existing.lastFailureAt > 0 &&
    now - existing.lastFailureAt > windowMs;

  const baseErrorCount = windowExpired ? 0 : (existing.errorCount ?? 0);
  const nextErrorCount = baseErrorCount + 1;
  const failureCounts = windowExpired ? {} : { ...existing.failureCounts };
  failureCounts[reason] = (failureCounts[reason] ?? 0) + 1;

  const updatedStats: ProfileUsageStats = {
    ...existing,
    errorCount: nextErrorCount,
    failureCounts,
    lastFailureAt: now,
  };

  if (reason === 'billing' || reason === 'auth_permanent') {
    // Long disable window for billing/auth failures
    const billingCount = failureCounts[reason] ?? 1;
    const backoffMs = Math.min(
      24 * 60 * 60 * 1000, // 24h max
      Math.max(5 * 60 * 60 * 1000, 5 * 60 * 60 * 1000 * 2 ** Math.min(billingCount - 1, 3)),
    );
    updatedStats.disabledUntil = now + backoffMs;
    updatedStats.disabledReason = reason;
  } else {
    // Regular cooldown with exponential backoff
    const backoffMs = calculateAuthProfileCooldownMs(nextErrorCount);
    updatedStats.cooldownUntil = now + backoffMs;
  }

  store.usageStats[profileId] = updatedStats;
}

/**
 * Mark a profile as rate-limited (shorthand for markAuthProfileFailure with unknown reason).
 */
export function markAuthProfileCooldown(
  store: AuthProfileStore,
  profileId: string,
): void {
  markAuthProfileFailure(store, profileId, 'unknown');
}

/**
 * Clear cooldown for a profile (manual reset).
 */
export function clearAuthProfileCooldown(store: AuthProfileStore, profileId: string): void {
  if (!store.usageStats?.[profileId]) return;

  store.usageStats[profileId] = {
    ...store.usageStats[profileId],
    errorCount: 0,
    cooldownUntil: undefined,
    disabledUntil: undefined,
    disabledReason: undefined,
    failureCounts: undefined,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveProfileUnusableUntil(
  stats: Pick<ProfileUsageStats, 'cooldownUntil' | 'disabledUntil'>,
): number | null {
  const values = [stats.cooldownUntil, stats.disabledUntil]
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
  if (values.length === 0) return null;
  return Math.max(...values);
}
