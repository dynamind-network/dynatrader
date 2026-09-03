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
// Collaboration Modes
// =============================================================================

/** Available multi-agent collaboration modes */
export type CollaborationMode = "pipeline" | "debate" | "consensus";

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
// Debate Types
// =============================================================================

/** Participant in a debate */
export type DebateParticipant = {
  agentId: string;
  role?: string;
  position?: "pro" | "con" | "neutral";
};

/** Configuration for debate mode */
export type DebateConfig = {
  maxRounds: number;
  timeout: number;
  consensusThreshold: number;
  moderatorId?: string;
};

/** A single argument in the debate */
export type DebateArgument = {
  round: number;
  agentId: string;
  argument: string;
  position?: "pro" | "con" | "neutral";
};

/** Vote cast by an agent */
export type DebateVote = {
  agentId: string;
  supportsAgentId: string;
  confidence: number;
  reasoning?: string;
};

/** Result of consensus detection */
export type ConsensusDetection = {
  reached: boolean;
  agreementLevel: number;
  agreeingAgents: string[];
  disagreeingAgents: string[];
};

/** Complete debate result */
export type MultiAgentDebateResult = {
  topic: string;
  status: "consensus" | "max_rounds" | "timeout" | "error";
  roundsCompleted: number;
  arguments: DebateArgument[];
  votes: DebateVote[];
  consensus: ConsensusDetection;
  conclusion?: string;
  totalDurationMs: number;
};

// =============================================================================
// Consensus Types
// =============================================================================

/** A proposal submitted by an agent */
export type ConsensusProposal = {
  id: string;
  agentId: string;
  content: string;
  score?: number;
};

/** Vote on a proposal */
export type ConsensusProposalVote = {
  agentId: string;
  proposalId: string;
  vote: number | boolean;
  reasoning?: string;
};

/** Configuration for consensus mode */
export type ConsensusConfig = {
  proposalTimeout?: number;
  votingTimeout?: number;
  minProposals?: number;
  weightedVoting?: boolean;
  agentWeights?: Record<string, number>;
};

/** Result of consensus mode */
export type ConsensusResult = {
  task: string;
  status: "agreement" | "no_agreement" | "timeout" | "error";
  proposals: ConsensusProposal[];
  votes: ConsensusProposalVote[];
  winningProposal?: ConsensusProposal;
  synthesizedAnswer?: string;
  agreementLevel: number;
  survivalDecision?: SurvivalDecision;
  totalDurationMs: number;
};

// =============================================================================
// Configuration Types
// =============================================================================

/** Plugin configuration schema */
export type MultiAgentConfig = {
  pipelines?: Record<string, PipelineDefinition>;
  debate?: Partial<DebateConfig>;
  consensus?: Partial<ConsensusConfig>;
  survivalPolicy?: Partial<SurvivalPolicyConfig>;
  enableLogging?: boolean;
};

/** Resolved configuration with all defaults applied */
export type ResolvedMultiAgentConfig = {
  pipelines: Record<string, PipelineDefinition>;
  debate: DebateConfig;
  consensus: ConsensusConfig;
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

/** Parameters for the multiagent-debate tool */
export type DebateToolParams = {
  topic: string;
  agents: string[];
  maxRounds?: number;
  moderatorId?: string;
  timeoutSeconds?: number;
};

/** Parameters for the multiagent-consensus tool */
export type ConsensusToolParams = {
  task: string;
  agents: string[];
  timeoutSeconds?: number;
  weightedVoting?: boolean;
};
