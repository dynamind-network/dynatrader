/**
 * Dyna-Trader Multi-Agent Pipeline Package
 *
 * Provides pipeline orchestration for multi-agent collaboration.
 * Adapted for DynaTrader.
 */

export {
  createPipelineExecutor,
  runTradingPipeline,
  createCustomPipeline,
  summarizePipelineResult,
  evaluatePipelineSurvivalDecision,
  evalSurvivalFromBlocks,
  formatSurvivalDecision,
  configureGateway,
  createGatewayFromA2A,
} from "./pipeline";

export {
  parseMultiAgentConfig,
  validateConfig,
  getPipeline,
  isValidAgentId,
  validateAgentChain,
  DEFAULT_TRADING_PIPELINE,
  DEFAULT_DEBATE_CONFIG,
  DEFAULT_CONSENSUS_CONFIG,
  DEFAULT_SURVIVAL_POLICY,
  DEFAULT_MULTIAGENT_CONFIG,
} from "./config";

export type {
  CollaborationMode,
  PipelineStage,
  PipelineDefinition,
  PipelineStageResult,
  PipelineResult,
  DebateParticipant,
  DebateConfig,
  DebateArgument,
  DebateVote,
  ConsensusDetection,
  MultiAgentDebateResult,
  ConsensusProposal,
  ConsensusProposalVote,
  ConsensusConfig,
  ConsensusResult,
  MultiAgentConfig,
  ResolvedMultiAgentConfig,
  SessionContext,
  AgentCommunicationResult,
  PipelineToolParams,
  DebateToolParams,
  ConsensusToolParams,
  SurvivalDecision,
  SurvivalPolicyConfig,
} from "./types";
