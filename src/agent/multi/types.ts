/**
 * Core types for the multiagent package.
 * Adapted for DynaTrader.
 */

// =============================================================================
// Survival Policy Types
// =============================================================================

/** Survival decision result from pipeline evaluation */
export interface SurvivalDecision {
  passed: boolean;
  score: number;
  confidence: number;
  riskAdjustedPnl: number;
  maxDrawdownPct: number;
  runwayDays: number;
  slippageBps: number;
  liquidityImpactPct: number;
  verdict: "APPROVE" | "HOLD" | "REJECT";
  reasoning: string;
}

/** Survival policy configuration */
export interface SurvivalPolicyConfig {
  minScore: number;
  minConfidence: number;
  maxDrawdownPct: number;
  minRunwayDays: number;
  maxSlippageBps: number;
  maxLiquidityImpactPct: number;
  minRiskAdjustedPnl: number;
  minAgentUptimePct: number;
  maxFailureRatePct: number;
  weights: {
    agentScore: number;
    pnl: number;
    drawdown: number;
    runway: number;
    confidence: number;
    execution: number;
    reliability: number;
  };
}

// =============================================================================
// Pipeline Types
// =============================================================================

/** Configuration for a pipeline stage */
export type PipelineStage = {
  agentId: string;
  label?: string;
  timeout?: number;
  promptPrefix?: string;
};

/** Configuration for a pipeline definition */
export type PipelineDefinition = {
  id: string;
  name?: string;
  chain: string[];
  timeout?: number;
  failureMode?: "graceful" | "fail_fast";
};

/** Result from a single pipeline stage execution */
export type PipelineStageResult = {
  stageIndex: number;
  agentId: string;
  label?: string;
  status: "success" | "timeout" | "error";
  response?: string;
  error?: string;
  durationMs: number;
  sessionKey?: string;
};

/** Complete pipeline execution result */
export type PipelineResult = {
  pipelineId: string;
  status: "completed" | "partial" | "failed" | "timeout";
  stages: PipelineStageResult[];
  finalOutput?: string;
  survivalDecision?: SurvivalDecision;
  totalDurationMs: number;
  allStagesSuccessful: boolean;
};

// =============================================================================
// Configuration Types
// =============================================================================

/** Plugin configuration schema */
export type MultiAgentConfig = {
  pipelines?: Record<string, PipelineDefinition>;
  survivalPolicy?: Partial<SurvivalPolicyConfig>;
  enableLogging?: boolean;
};

/** Resolved configuration with all defaults applied */
export type ResolvedMultiAgentConfig = {
  pipelines: Record<string, PipelineDefinition>;
  survivalPolicy: SurvivalPolicyConfig;
  enableLogging: boolean;
};

// =============================================================================
// Session Communication Types
// =============================================================================

/** Context for session-based communication */
export type SessionContext = {
  requesterSessionKey?: string;
  channel?: string;
  accountId?: string;
  sandboxed?: boolean;
};

/** Result from spawning/communicating with an agent */
export type AgentCommunicationResult = {
  success: boolean;
  sessionKey?: string;
  response?: string;
  error?: string;
  durationMs: number;
};

// =============================================================================
// Tool Parameter Types
// =============================================================================

/** Parameters for the multiagent-pipeline tool */
export type PipelineToolParams = {
  pipelineId: string;
  task: string;
  chain?: string[];
  timeoutSeconds?: number;
};
