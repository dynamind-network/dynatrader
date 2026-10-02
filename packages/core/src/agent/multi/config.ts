/**
 * Configuration management for the multiagent package.
 * Handles parsing, validation, and merging of plugin config.
 *
 * Adapted for DynaTrader.
 */

import type {
  PipelineDefinition,
  SurvivalPolicyConfig,
  ResolvedMultiAgentConfig,
} from "./types";

// =============================================================================
// Default Configurations
// =============================================================================

/** Default trading pipeline for DynaTrader */
export const DEFAULT_TRADING_PIPELINE: PipelineDefinition = {
  id: "trading",
  name: "Trading Decision Pipeline",
  chain: [],
  timeout: 600000,
  failureMode: "graceful",
};

/** Default survival policy configuration */
export const DEFAULT_SURVIVAL_POLICY: SurvivalPolicyConfig = {
  minScore: 70,
  minConfidence: 0.5,
  maxDrawdownPct: 0.12,
  minRunwayDays: 14,
  maxSlippageBps: 150,
  maxLiquidityImpactPct: 0.02,
  minRiskAdjustedPnl: 0,
  minAgentUptimePct: 0.8,
  maxFailureRatePct: 0.25,
  weights: {
    agentScore: 0.15,
    pnl: 0.25,
    drawdown: 0.2,
    runway: 0.15,
    confidence: 0.15,
    execution: 0.07,
    reliability: 0.03,
  },
};

/** Default resolved configuration */
export const DEFAULT_MULTIAGENT_CONFIG: ResolvedMultiAgentConfig = {
  pipelines: {},
  survivalPolicy: DEFAULT_SURVIVAL_POLICY,
  enableLogging: false,
};

// =============================================================================
// Configuration Parsing
// =============================================================================

/**
 * Parse and validate multi-agent configuration from a raw config object.
 */
export function parseMultiAgentConfig(
  pluginConfig: unknown,
): ResolvedMultiAgentConfig {
  const cfg = pluginConfig as Record<string, unknown> | undefined;

  const pipelines = parsePipelines(cfg?.pipelines);
  const survivalPolicy = parseSurvivalPolicyConfig(cfg?.survivalPolicy);

  const enableLogging =
    typeof cfg?.enableLogging === "boolean"
      ? cfg.enableLogging
      : DEFAULT_MULTIAGENT_CONFIG.enableLogging;

  return {
    pipelines,
    survivalPolicy,
    enableLogging,
  };
}

/**
 * Parse pipeline definitions.
 */
function parsePipelines(value: unknown): Record<string, PipelineDefinition> {
  if (typeof value !== "object" || value === null) {
    return {};
  }

  const pipelines: Record<string, PipelineDefinition> = {};

  const raw = value as Record<string, unknown>;
  for (const [id, pipelineValue] of Object.entries(raw)) {
    if (typeof pipelineValue !== "object" || pipelineValue === null) {
      continue;
    }

    const p = pipelineValue as Record<string, unknown>;

    if (!Array.isArray(p.chain)) {
      continue;
    }

    const chain = p.chain.filter(
      (agent): agent is string => typeof agent === "string" && agent.trim().length > 0,
    );

    if (chain.length === 0) {
      continue;
    }

    pipelines[id] = {
      id,
      name: typeof p.name === "string" ? p.name : id,
      chain,
      timeout:
        typeof p.timeout === "number" && p.timeout > 0
          ? p.timeout
          : DEFAULT_TRADING_PIPELINE.timeout,
      failureMode:
        p.failureMode === "graceful" || p.failureMode === "fail_fast"
          ? p.failureMode
          : DEFAULT_TRADING_PIPELINE.failureMode,
    };
  }

  return pipelines;
}

/**
 * Parse survival policy configuration.
 */
function parseSurvivalPolicyConfig(value: unknown): SurvivalPolicyConfig {
  if (typeof value !== "object" || value === null) {
    return DEFAULT_MULTIAGENT_CONFIG.survivalPolicy;
  }

  const raw = value as Record<string, unknown>;
  const weights =
    typeof raw.weights === "object" && raw.weights !== null
      ? parseSurvivalWeights(raw.weights)
      : DEFAULT_MULTIAGENT_CONFIG.survivalPolicy.weights;

  return {
    minScore:
      typeof raw.minScore === "number" && raw.minScore >= 0 && raw.minScore <= 100
        ? raw.minScore
        : DEFAULT_MULTIAGENT_CONFIG.survivalPolicy.minScore,
    minConfidence:
      typeof raw.minConfidence === "number" && raw.minConfidence >= 0 && raw.minConfidence <= 1
        ? raw.minConfidence
        : DEFAULT_MULTIAGENT_CONFIG.survivalPolicy.minConfidence,
    maxDrawdownPct:
      typeof raw.maxDrawdownPct === "number" && raw.maxDrawdownPct >= 0 && raw.maxDrawdownPct <= 1
        ? raw.maxDrawdownPct
        : DEFAULT_MULTIAGENT_CONFIG.survivalPolicy.maxDrawdownPct,
    minRunwayDays:
      typeof raw.minRunwayDays === "number" && raw.minRunwayDays >= 0
        ? raw.minRunwayDays
        : DEFAULT_MULTIAGENT_CONFIG.survivalPolicy.minRunwayDays,
    maxSlippageBps:
      typeof raw.maxSlippageBps === "number" && raw.maxSlippageBps >= 0
        ? raw.maxSlippageBps
        : DEFAULT_MULTIAGENT_CONFIG.survivalPolicy.maxSlippageBps,
    maxLiquidityImpactPct:
      typeof raw.maxLiquidityImpactPct === "number" &&
      raw.maxLiquidityImpactPct >= 0 &&
      raw.maxLiquidityImpactPct <= 1
        ? raw.maxLiquidityImpactPct
        : DEFAULT_MULTIAGENT_CONFIG.survivalPolicy.maxLiquidityImpactPct,
    minRiskAdjustedPnl:
      typeof raw.minRiskAdjustedPnl === "number" && Number.isFinite(raw.minRiskAdjustedPnl)
        ? raw.minRiskAdjustedPnl
        : DEFAULT_MULTIAGENT_CONFIG.survivalPolicy.minRiskAdjustedPnl,
    minAgentUptimePct:
      typeof raw.minAgentUptimePct === "number" &&
      raw.minAgentUptimePct >= 0 &&
      raw.minAgentUptimePct <= 1
        ? raw.minAgentUptimePct
        : DEFAULT_MULTIAGENT_CONFIG.survivalPolicy.minAgentUptimePct,
    maxFailureRatePct:
      typeof raw.maxFailureRatePct === "number" && raw.maxFailureRatePct >= 0 && raw.maxFailureRatePct <= 1
        ? raw.maxFailureRatePct
        : DEFAULT_MULTIAGENT_CONFIG.survivalPolicy.maxFailureRatePct,
    weights,
  };
}

function parseSurvivalWeights(value: unknown): SurvivalPolicyConfig["weights"] {
  if (typeof value !== "object" || value === null) {
    return DEFAULT_MULTIAGENT_CONFIG.survivalPolicy.weights;
  }

  const raw = value as Record<string, unknown>;

  return {
    agentScore:
      typeof raw.agentScore === "number" && raw.agentScore >= 0
        ? raw.agentScore
        : DEFAULT_MULTIAGENT_CONFIG.survivalPolicy.weights.agentScore,
    pnl:
      typeof raw.pnl === "number" && raw.pnl >= 0
        ? raw.pnl
        : DEFAULT_MULTIAGENT_CONFIG.survivalPolicy.weights.pnl,
    drawdown:
      typeof raw.drawdown === "number" && raw.drawdown >= 0
        ? raw.drawdown
        : DEFAULT_MULTIAGENT_CONFIG.survivalPolicy.weights.drawdown,
    runway:
      typeof raw.runway === "number" && raw.runway >= 0
        ? raw.runway
        : DEFAULT_MULTIAGENT_CONFIG.survivalPolicy.weights.runway,
    confidence:
      typeof raw.confidence === "number" && raw.confidence >= 0
        ? raw.confidence
        : DEFAULT_MULTIAGENT_CONFIG.survivalPolicy.weights.confidence,
    execution:
      typeof raw.execution === "number" && raw.execution >= 0
        ? raw.execution
        : DEFAULT_MULTIAGENT_CONFIG.survivalPolicy.weights.execution,
    reliability:
      typeof raw.reliability === "number" && raw.reliability >= 0
        ? raw.reliability
        : DEFAULT_MULTIAGENT_CONFIG.survivalPolicy.weights.reliability,
  };
}

function parseAgentWeights(value: unknown): Record<string, number> | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const weights: Record<string, number> = {};
  const raw = value as Record<string, unknown>;

  for (const [agentId, weight] of Object.entries(raw)) {
    if (typeof weight === "number" && weight > 0 && Number.isFinite(weight)) {
      weights[agentId] = weight;
    }
  }

  return Object.keys(weights).length > 0 ? weights : undefined;
}

// =============================================================================
// Configuration Validation
// =============================================================================

/**
 * Validate multi-agent configuration.
 */
export function validateConfig(config: ResolvedMultiAgentConfig): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  for (const [id, pipeline] of Object.entries(config.pipelines)) {
    if (!pipeline.chain || pipeline.chain.length === 0) {
      errors.push(`Pipeline "${id}" must have at least one agent in chain`);
    }
    if (pipeline.timeout && pipeline.timeout < 10000) {
      errors.push(`Pipeline "${id}" timeout should be at least 10 seconds`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// =============================================================================
// Configuration Helpers
// =============================================================================

/**
 * Get a pipeline definition by ID.
 */
export function getPipeline(
  config: ResolvedMultiAgentConfig,
  pipelineId: string,
): PipelineDefinition | undefined {
  return config.pipelines[pipelineId];
}

/**
 * Check if an agent ID is valid.
 */
export function isValidAgentId(agentId: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(agentId.trim());
}

/**
 * Validate agents in a chain are all valid.
 */
export function validateAgentChain(chain: string[]): {
  valid: boolean;
  invalidAgents: string[];
} {
  const invalidAgents = chain.filter((agentId) => !isValidAgentId(agentId));
  return {
    valid: invalidAgents.length === 0,
    invalidAgents,
  };
}