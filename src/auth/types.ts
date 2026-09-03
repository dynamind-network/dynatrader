/**
 * Auth Profile Types
 *
 * Defines the data structures for API key rotation with multiple profiles
 * per provider, cooldown tracking, and round-robin distribution.
 */

/** A single API key credential for a provider */
export interface ApiKeyProfile {
  type: 'api_key';
  provider: string;
  key: string;
  email?: string;
  metadata?: Record<string, string>;
}

/** A bearer/PAT token credential */
export interface TokenProfile {
  type: 'token';
  provider: string;
  token: string;
  expires?: number;
  email?: string;
}

/** Union of all profile credential types */
export type AuthProfileCredential = ApiKeyProfile | TokenProfile;

/** Failure reasons for cooldown categorization */
export type AuthProfileFailureReason =
  | 'auth'
  | 'auth_permanent'
  | 'rate_limit'
  | 'billing'
  | 'timeout'
  | 'model_not_found'
  | 'unknown';

/** Per-profile usage statistics for round-robin and cooldown tracking */
export interface ProfileUsageStats {
  lastUsed?: number;
  cooldownUntil?: number;
  disabledUntil?: number;
  disabledReason?: AuthProfileFailureReason;
  errorCount?: number;
  failureCounts?: Partial<Record<AuthProfileFailureReason, number>>;
  lastFailureAt?: number;
}

/** The auth profile store — persisted as auth-profiles.json */
export interface AuthProfileStore {
  version: number;
  profiles: Record<string, AuthProfileCredential>;
  /** Per-provider ordered profile IDs for rotation */
  order?: Record<string, string[]>;
  /** Last known good profile per provider */
  lastGood?: Record<string, string>;
  /** Usage statistics per profile */
  usageStats?: Record<string, ProfileUsageStats>;
}

/** Resolved provider auth for model router consumption */
export interface ResolvedProviderAuth {
  apiKey: string;
  profileId: string;
  source: 'profile' | 'env' | 'config';
  mode: 'api_key' | 'token';
}

/** Auth profile configuration from workspace config */
export interface AuthProfileConfig {
  provider: string;
  mode: 'api_key' | 'oauth' | 'token';
  email?: string;
}

/** Top-level auth config */
export interface AuthConfig {
  profiles?: Record<string, AuthProfileConfig>;
  order?: Record<string, string[]>;
  cooldowns?: {
    billingBackoffHours?: number;
    billingMaxHours?: number;
    failureWindowHours?: number;
  };
}
