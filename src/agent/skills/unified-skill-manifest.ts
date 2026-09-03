/**
 * Unified Skill Manifest
 *
 * Single source of truth for skill metadata used by both the agent-level
 * skill system (loading, gating, injection) and runtime-level skill system
 * (execution, sandboxing, auditing).
 *
 * Merges:
 * - Agent skill types (skill-types.ts)
 * - Runtime skill schema (skill-runtime.ts)
 * - Trigger/risk/permission metadata (Hermes patterns)
 * - Hermes patterns (platform matching, environment conditions)
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema (Zod for runtime validation)
// ---------------------------------------------------------------------------

export const UnifiedSkillManifestSchema = z.object({
  // Identity
  name: z.string().min(1),
  version: z.string().default('1.0.0'),
  description: z.string(),

  // Categorization
  type: z.enum(['strategy', 'analysis', 'research', 'risk', 'utility']),
  tags: z.array(z.string()).default([]),

  // Trigger matching (Hermes pattern)
  triggers: z.object({
    /** Keywords that activate this skill (matched against user messages). */
    keywords: z.array(z.string()).default([]),
    /** Regex patterns to match against context. */
    patterns: z.array(z.string()).default([]),
    /** Market conditions that activate this skill (e.g., "volatility>0.3"). */
    marketConditions: z.array(z.string()).default([]),
    /** Minimum confidence score to trigger (0-1). */
    minConfidence: z.number().min(0).max(1).default(0.3),
  }).default({}),

  // Platform/Environment matching (Hermes pattern)
  platform: z.object({
    /** OS filter (empty = all platforms). */
    os: z.array(z.enum(['win32', 'darwin', 'linux'])).default([]),
    /** Required binaries on PATH. */
    requiresBins: z.array(z.string()).default([]),
    /** Required environment variables. */
    requiresEnv: z.array(z.string()).default([]),
    /** Required config keys. */
    requiresConfig: z.array(z.string()).default([]),
    /** Environment conditions (e.g., ["docker", "kanban"]). */
    environments: z.array(z.string()).default([]),
  }).default({}),

  // Versioning (2.4)
  versioning: z.object({
    /** Version history for A/B comparison. */
    history: z.array(z.object({
      version: z.string(),
      timestamp: z.string(),
      changes: z.string(),
      performance: z.number().optional(),
    })).default([]),
    /** Rollback target version. */
    rollbackTarget: z.string().optional(),
    /** Deprecation notice. */
    deprecatedAt: z.string().optional(),
    /** Replacement skill name if deprecated. */
    replacementSkill: z.string().optional(),
  }).default({}),

  // Execution (Runtime)
  execution: z.object({
    /** Allowed runtime modes. */
    allowedModes: z.array(z.enum([
      'research', 'backtest', 'paper', 'shadow', 'micro_live', 'live',
    ])).default(['research']),
    /** Required tools for this skill. */
    requiredTools: z.array(z.string()).default([]),
    /** Timeout for skill execution in milliseconds. */
    timeoutMs: z.number().positive().default(60_000),
    /** Maximum retries on failure. */
    maxRetries: z.number().min(0).default(2),
  }).default({}),

  // Gating (injection control)
  gating: z.object({
    /** Confidence threshold for inclusion in prompts (0-1). */
    confidenceThreshold: z.number().min(0).max(1).default(0.5),
    /** Always include this skill regardless of score. */
    alwaysInclude: z.boolean().default(false),
  }).default({}),

  // Feedback (runtime-populated)
  feedback: z.object({
    /** Total executions of this skill. */
    executionCount: z.number().min(0).default(0),
    /** Successful executions. */
    successCount: z.number().min(0).default(0),
    /** Last N outcomes ('success' | 'failure'). */
    recentOutcomes: z.array(z.enum(['success', 'failure'])).default([]),
    /** Exponential moving average of performance scores (0-1). */
    avgPerformance: z.number().min(0).max(1).default(0.5),
    /** ISO timestamp of last execution. */
    lastExecutedAt: z.string().optional(),
  }).default({}),
});

export type UnifiedSkillManifest = z.infer<typeof UnifiedSkillManifestSchema>;

// ---------------------------------------------------------------------------
// Platform gates
// ---------------------------------------------------------------------------

export interface PlatformGateContext {
  os?: NodeJS.Platform | string;
  availableBins?: string[];
  envVars?: Record<string, string | undefined>;
  configKeys?: string[];
  activeEnvironments?: string[];
}

export interface PlatformGateResult {
  passed: boolean;
  reason?: string;
}

/**
 * Check whether a skill passes its platform/environment gates.
 */
export function passesPlatformGates(
  manifest: UnifiedSkillManifest,
  context: PlatformGateContext,
): PlatformGateResult {
  const platform = manifest.platform ?? {};

  if (platform.os.length > 0 && context.os && !platform.os.includes(context.os as 'win32' | 'darwin' | 'linux')) {
    return { passed: false, reason: `os_mismatch:${context.os}` };
  }

  if (platform.requiresBins.length > 0) {
    const available = new Set(context.availableBins ?? []);
    const missing = platform.requiresBins.filter((bin) => !available.has(bin));
    if (missing.length > 0) {
      return { passed: false, reason: `missing_bins:${missing.join(',')}` };
    }
  }

  if (platform.requiresEnv.length > 0 && context.envVars) {
    const missing = platform.requiresEnv.filter(
      (key) => context.envVars?.[key] === undefined || context.envVars?.[key] === '',
    );
    if (missing.length > 0) {
      return { passed: false, reason: `missing_env:${missing.join(',')}` };
    }
  }

  if (platform.requiresConfig.length > 0) {
    const available = new Set(context.configKeys ?? []);
    const missing = platform.requiresConfig.filter((key) => !available.has(key));
    if (missing.length > 0) {
      return { passed: false, reason: `missing_config:${missing.join(',')}` };
    }
  }

  if (platform.environments.length > 0) {
    const active = new Set(context.activeEnvironments ?? []);
    const satisfied = platform.environments.some((env) => active.has(env));
    if (!satisfied) {
      return { passed: false, reason: `environment_not_active:${platform.environments.join(',')}` };
    }
  }

  return { passed: true };
}

// ---------------------------------------------------------------------------
// Trigger scoring
// ---------------------------------------------------------------------------

export interface TriggerScoreContext {
  userMessage?: string;
  marketData?: Record<string, unknown>;
}

/**
 * Score how strongly a skill is triggered by the given context (0-1).
 *
 * Combines keyword matches, regex pattern matches, and market condition
 * matches into a single normalized score.
 */
export function calculateTriggerScore(
  manifest: UnifiedSkillManifest,
  context: TriggerScoreContext,
): number {
  const triggers = manifest.triggers ?? {};
  let score = 0;
  let signals = 0;

  if (context.userMessage) {
    const messageLower = context.userMessage.toLowerCase();

    if (triggers.keywords.length > 0) {
      signals++;
      const matches = triggers.keywords.filter((kw) =>
        messageLower.includes(kw.toLowerCase()),
      ).length;
      score += Math.min(1, matches / Math.max(1, triggers.keywords.length)) * (matches > 0 ? 1 : 0);
    }

    if (triggers.patterns.length > 0) {
      signals++;
      try {
        const matches = triggers.patterns.filter((pattern) => {
          try {
            return new RegExp(pattern, 'i').test(context.userMessage ?? '');
          } catch {
            return messageLower.includes(pattern.toLowerCase());
          }
        }).length;
        score += matches > 0 ? 1 : 0;
      } catch {
        // Invalid patterns — skip this signal
      }
    }
  }

  if (triggers.marketConditions.length > 0 && context.marketData) {
    signals++;
    const conditionsMet = triggers.marketConditions.some((condition) =>
      evaluateMarketCondition(condition, context.marketData ?? {}),
    );
    score += conditionsMet ? 1 : 0;
  }

  if (signals === 0) {
    return 0;
  }

  return Math.min(1, score / signals);
}

/**
 * Evaluate a simple market condition string like "volatility>0.3"
 * against a market data record.
 */
function evaluateMarketCondition(condition: string, data: Record<string, unknown>): boolean {
  const match = condition.match(/^([\w.]+)\s*(>=|<=|>|<|==)\s*(.+)$/);
  if (!match) return false;

  const [, key, op, rawValue] = match;
  const value = Number(rawValue);
  const actual = Number(data[key]);

  if (Number.isNaN(actual) || Number.isNaN(value)) return false;

  switch (op) {
    case '>': return actual > value;
    case '<': return actual < value;
    case '>=': return actual >= value;
    case '<=': return actual <= value;
    case '==': return actual === value;
    default: return false;
  }
}
