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
  DEFAULT_SURVIVAL_POLICY,
  DEFAULT_MULTIAGENT_CONFIG,
} from "./config";

export type {
  PipelineStage,
  PipelineDefinition,
  PipelineStageResult,
  PipelineResult,
  MultiAgentConfig,
  ResolvedMultiAgentConfig,
  SessionContext,
  AgentCommunicationResult,
  PipelineToolParams,
  SurvivalDecision,
  SurvivalPolicyConfig,
} from "./types";
