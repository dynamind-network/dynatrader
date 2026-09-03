/**
 * Pipeline orchestration for multi-agent collaboration.
 * Executes agents in sequence, passing output from one stage to the next.
 *
 * Gateway communication
 * is now delegated through a GatewayClient configured via configureGateway().
 */

import crypto from "node:crypto";
import type { A2ARuntime, GatewayClient } from "@dyna/a2a-runtime";
import type {
  AgentCommunicationResult,
  PipelineDefinition,
  PipelineResult,
  PipelineStageResult,
  ResolvedMultiAgentConfig,
  SessionContext,
  SurvivalDecision,
  SurvivalPolicyConfig,
} from "./types";
import { validateAgentChain } from "./config";

const SURVIVAL_OUTPUT_BLOCK = `SURVIVAL OUTPUT:
Return a machine-readable block with these fields:
SURVIVAL_SCORE: 0-100
CONFIDENCE: 0-1
RISK_ADJUSTED_PNL: numeric ratio or return
MAX_DRAWDOWN_PCT: decimal percentage
RUNWAY_DAYS: number of days
SLIPPAGE_BPS: basis points
LIQUIDITY_IMPACT_PCT: decimal percentage
VERDICT: APPROVE|HOLD|REJECT
REASONING: short explanation`;

// =============================================================================
// Gateway Client
// =============================================================================

/**
 * Create a GatewayClient from an A2ARuntime instance.
 * Delegates to the runtime's internal gateway for session/agent operations.
 */
export function createGatewayFromA2A(runtime: A2ARuntime): GatewayClient {
  return {
    async call<T>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T> {
      const gateway = (runtime as unknown as { gateway?: GatewayClient }).gateway;
      if (!gateway) throw new Error("No gateway configured in A2ARuntime");
      return gateway.call<T>(method, params, timeoutMs);
    },
    async callWait<T>(runId: string, timeoutMs: number): Promise<T> {
      const gateway = (runtime as unknown as { gateway?: GatewayClient }).gateway;
      if (!gateway) throw new Error("No gateway configured in A2ARuntime");
      return gateway.callWait<T>(runId, timeoutMs);
    },
    async history(sessionKey: string, limit?: number) {
      const gateway = (runtime as unknown as { gateway?: GatewayClient }).gateway;
      if (!gateway) throw new Error("No gateway configured in A2ARuntime");
      return gateway.history(sessionKey, limit);
    },
    async send(params) {
      const gateway = (runtime as unknown as { gateway?: GatewayClient }).gateway;
      if (!gateway) throw new Error("No gateway configured in A2ARuntime");
      return gateway.send(params);
    },
  };
}

// Default gateway client (null until configured)
let _gateway: GatewayClient | null = null;

/**
 * Configure the gateway client for multiagent communication.
 */
export function configureGateway(gateway: GatewayClient): void {
  _gateway = gateway;
}

/**
 * Get the current gateway client, or throw if not configured.
 */
function getGateway(): GatewayClient {
  if (!_gateway) {
    throw new Error("Gateway not configured. Call configureGateway() first.");
  }
  return _gateway;
}

// =============================================================================
// Pipeline Executor
// =============================================================================

/**
 * Create a pipeline executor instance.
 */
export function createPipelineExecutor(
  config: ResolvedMultiAgentConfig,
  _sessionContext: SessionContext,
) {
  return {
    /**
     * Execute a pipeline with the given task.
     */
    execute: async (
      pipeline: PipelineDefinition,
      task: string,
      overrideChain?: string[],
    ): Promise<PipelineResult> => {
      const startTime = Date.now();
      const stages: PipelineStageResult[] = [];

      // Use override chain if provided, otherwise use pipeline's chain
      const chain =
        overrideChain && overrideChain.length > 0 ? overrideChain : pipeline.chain;

      // Validate chain
      const validation = validateAgentChain(chain);
      if (!validation.valid) {
        return {
          pipelineId: pipeline.id,
          status: "failed",
          stages: [],
          totalDurationMs: Date.now() - startTime,
          allStagesSuccessful: false,
        };
      }

      if (chain.length === 0) {
        return {
          pipelineId: pipeline.id,
          status: "failed",
          stages: [],
          totalDurationMs: Date.now() - startTime,
          allStagesSuccessful: false,
        };
      }

      // Track current context (output from previous stage)
      let currentContext = task;

      // Get pipeline timeout with default
      const pipelineTimeout = pipeline.timeout ?? 600000;

      // Execute each stage in sequence
      for (let i = 0; i < chain.length; i++) {
        const agentId: string = chain[i]!;

        if (config.enableLogging) {
          console.log(`[multiagent-pipeline] Stage ${i + 1}/${chain.length}: ${agentId}`);
        }

        // Build prompt with context from previous stage
        const prompt =
          i === 0 ? task : buildContextualPrompt(currentContext, i, chain);

        // Execute the stage
        const result = await executeStage(agentId, prompt, pipelineTimeout);

        const stageResult: PipelineStageResult = {
          stageIndex: i,
          agentId,
          status: result.success
            ? "success"
            : result.error?.includes("timeout")
              ? "timeout"
              : "error",
          response: result.response,
          error: result.error,
          durationMs: result.durationMs,
          sessionKey: result.sessionKey,
        };

        stages.push(stageResult);

        if (!result.success) {
          if (pipeline.failureMode === "fail_fast") {
            break;
          }
          // For graceful mode, continue with last successful context
        } else {
          currentContext = result.response || currentContext;
        }

        // Check total timeout
        if (Date.now() - startTime > pipelineTimeout) {
          if (config.enableLogging) {
            console.log(`[multiagent-pipeline] Pipeline timeout exceeded`);
          }
          break;
        }
      }

      const totalDurationMs = Date.now() - startTime;
      const successCount = stages.filter((s) => s.status === "success").length;

      let status: PipelineResult["status"];
      if (successCount === chain.length) {
        status = "completed";
      } else if (successCount === 0) {
        status = "failed";
      } else if (totalDurationMs >= pipelineTimeout) {
        status = "timeout";
      } else {
        status = "partial";
      }

      // Find the last successful stage's response
      const lastSuccessful = stages.slice().reverse().find((s: PipelineStageResult) => s.status === "success");
      const survivalDecision = evaluatePipelineSurvivalDecision(stages, config);

      return {
        pipelineId: pipeline.id,
        status,
        stages,
        finalOutput: lastSuccessful?.response,
        survivalDecision,
        totalDurationMs,
        allStagesSuccessful: successCount === chain.length,
      };
    },
  };
}

// =============================================================================
// Stage Execution
// =============================================================================

/**
 * Execute a single pipeline stage.
 */
async function executeStage(
  agentId: string,
  prompt: string,
  pipelineTimeout: number,
): Promise<AgentCommunicationResult> {
  const startTime = Date.now();

  const stageTimeout = Math.min(300000, Math.max(30000, pipelineTimeout / 4));

  try {
    // Spawn the agent session via gateway
    const spawnResult = await getGateway().call<{
      runId?: string;
      sessionKey?: string;
      status?: string;
      error?: string;
    }>("spawn_subagent", {
      task: prompt,
      agentId,
      runTimeoutSeconds: Math.floor(stageTimeout / 1000),
      cleanup: "keep",
    }, stageTimeout + 5000);

    if (!spawnResult || spawnResult.status === "error") {
      return {
        success: false,
        error: spawnResult?.error ?? `Gateway not available for agent: ${agentId}`,
        durationMs: Date.now() - startTime,
      };
    }

    const sessionKey = spawnResult.sessionKey;
    const runId = spawnResult.runId;

    if (!runId) {
      return {
        success: false,
        error: "No run ID returned from spawn",
        durationMs: Date.now() - startTime,
      };
    }

    // Wait for the agent to complete
    const waitResult = await getGateway().callWait<{
      status?: string;
      error?: string;
    }>(runId, stageTimeout);

    if (waitResult?.status === "timeout") {
      return {
        success: false,
        sessionKey,
        error: "Agent execution timed out",
        durationMs: Date.now() - startTime,
      };
    }

    if (waitResult?.status === "error") {
      return {
        success: false,
        sessionKey,
        error: waitResult.error || "Agent execution failed",
        durationMs: Date.now() - startTime,
      };
    }

    if (!sessionKey) {
      return {
        success: false,
        error: "No session key returned from spawn",
        durationMs: Date.now() - startTime,
      };
    }

    // Fetch the agent's response from session history
    const history = await getGateway().history(sessionKey, 10);

    const messages = history?.messages || [];
    const assistantMessages = messages.filter((m) => m.role === "assistant");
    const lastMessage = assistantMessages[assistantMessages.length - 1];
    const response = lastMessage?.content || lastMessage?.text;

    return {
      success: true,
      sessionKey,
      response: response || "No response from agent",
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: errorMessage,
      durationMs: Date.now() - startTime,
    };
  }
}

// =============================================================================
// Prompt Building
// =============================================================================

/**
 * Build a prompt that includes context from previous stages.
 */
function buildContextualPrompt(
  previousOutput: string,
  currentStageIndex: number,
  chain: string[],
): string {
  const remainingStages = chain.length - currentStageIndex;
  const stageLabel =
    currentStageIndex === 1
      ? "second"
      : currentStageIndex === 2
        ? "third"
        : currentStageIndex === 3
          ? "fourth"
          : `${currentStageIndex + 1}th`;

  const base = `You are the ${stageLabel} stage in a multi-agent pipeline with ${remainingStages} stage(s) remaining after you.

CONTEXT FROM PREVIOUS STAGE:
${previousOutput}

YOUR TASK:
Process the above context and provide your analysis/recommendations. Your output will be passed to the next stage in the pipeline.

Be concise but comprehensive. Focus on actionable insights relevant to your expertise.`;

  return `${base}\n\n${SURVIVAL_OUTPUT_BLOCK}`;
}

// =============================================================================
// Pipeline Helpers
// =============================================================================

/**
 * Run the default trading pipeline.
 */
export async function runTradingPipeline(
  config: ResolvedMultiAgentConfig,
  task: string,
  sessionContext: SessionContext,
): Promise<PipelineResult> {
  const executor = createPipelineExecutor(config, sessionContext);
  const pipeline = config.pipelines.trading;

  if (!pipeline) {
    return {
      pipelineId: "trading",
      status: "failed",
      stages: [],
      totalDurationMs: 0,
      allStagesSuccessful: false,
    };
  }

  return executor.execute(pipeline, task);
}

/**
 * Evaluate the survival gate for a pipeline result.
 * Simplified evaluation based on stage responses.
 */
export function evaluatePipelineSurvivalDecision(
  stages: Array<Pick<PipelineStageResult, "response" | "status">>,
  config: ResolvedMultiAgentConfig,
): SurvivalDecision | undefined {
  const responses = stages
    .map((stage) => stage.response)
    .filter((response): response is string => Boolean(response));

  if (responses.length === 0) return undefined;

  return evalSurvivalFromBlocks(responses, config.survivalPolicy);
}

/**
 * Evaluate survival policy from text blocks produced by agents.
 * Parses structured SURVIVAL OUTPUT blocks from agent responses.
 */
export function evalSurvivalFromBlocks(
  textBlocks: string[],
  policy: SurvivalPolicyConfig,
): SurvivalDecision {
  let totalScore = 0;
  let scoreCount = 0;
  let confidence = 0;
  let riskAdjustedPnl = 0;
  let maxDrawdownPct = 0;
  let runwayDays = 0;
  let slippageBps = 0;
  let liquidityImpactPct = 0;
  let verdict: SurvivalDecision["verdict"] = "HOLD";
  const reasoningParts: string[] = [];

  for (const block of textBlocks) {
    const scoreMatch = block.match(/SURVIVAL_SCORE:\s*(\d+)/);
    if (scoreMatch) {
      totalScore += Number(scoreMatch[1]);
      scoreCount++;
    }

    const confMatch = block.match(/CONFIDENCE:\s*([\d.]+)/);
    if (confMatch) confidence = Math.max(confidence, Number(confMatch[1]));

    const pnlMatch = block.match(/RISK_ADJUSTED_PNL:\s*([-\d.]+)/);
    if (pnlMatch) riskAdjustedPnl = Number(pnlMatch[1]);

    const ddMatch = block.match(/MAX_DRAWDOWN_PCT:\s*([\d.]+)/);
    if (ddMatch) maxDrawdownPct = Math.max(maxDrawdownPct, Number(ddMatch[1]));

    const runMatch = block.match(/RUNWAY_DAYS:\s*(\d+)/);
    if (runMatch) runwayDays = Math.max(runwayDays, Number(runMatch[1]));

    const slipMatch = block.match(/SLIPPAGE_BPS:\s*(\d+)/);
    if (slipMatch) slippageBps = Math.max(slippageBps, Number(slipMatch[1]));

    const liqMatch = block.match(/LIQUIDITY_IMPACT_PCT:\s*([\d.]+)/);
    if (liqMatch) liquidityImpactPct = Math.max(liquidityImpactPct, Number(liqMatch[1]));

    const verdictMatch = block.match(/VERDICT:\s*(APPROVE|HOLD|REJECT)/);
    if (verdictMatch) verdict = verdictMatch[1] as SurvivalDecision["verdict"];

    const reasonMatch = block.match(/REASONING:\s*(.+)/);
    if (reasonMatch?.[1]) reasoningParts.push(reasonMatch[1].trim());
  }

  const avgScore = scoreCount > 0 ? totalScore / scoreCount : 0;

  // Apply weighted scoring
  const weights = policy.weights;
  const weightedScore =
    avgScore * weights.agentScore +
    riskAdjustedPnl * 100 * weights.pnl +
    (1 - maxDrawdownPct) * 100 * weights.drawdown +
    Math.min(runwayDays / 30, 1) * 100 * weights.runway +
    confidence * 100 * weights.confidence;

  // Determine pass/fail
  const passed =
    weightedScore >= policy.minScore &&
    confidence >= policy.minConfidence &&
    maxDrawdownPct <= policy.maxDrawdownPct &&
    runwayDays >= policy.minRunwayDays &&
    slippageBps <= policy.maxSlippageBps &&
    liquidityImpactPct <= policy.maxLiquidityImpactPct;

  return {
    passed,
    score: weightedScore,
    confidence,
    riskAdjustedPnl,
    maxDrawdownPct,
    runwayDays,
    slippageBps,
    liquidityImpactPct,
    verdict: passed ? verdict : "REJECT",
    reasoning: reasoningParts.join(" | ") || "No reasoning provided",
  };
}

/**
 * Format a survival decision for display.
 */
export function formatSurvivalDecision(decision: SurvivalDecision): string {
  const lines: string[] = [
    `Survival: ${decision.passed ? "PASS" : "BLOCK"}`,
    `Score: ${decision.score.toFixed(1)} | Confidence: ${(decision.confidence * 100).toFixed(0)}%`,
    `Verdict: ${decision.verdict}`,
    `Drawdown: ${(decision.maxDrawdownPct * 100).toFixed(1)}% | Runway: ${decision.runwayDays}d | Slippage: ${decision.slippageBps}bps`,
  ];
  if (decision.reasoning) {
    lines.push(`Reasoning: ${decision.reasoning}`);
  }
  return lines.join("\n");
}

/**
 * Create a custom pipeline from a chain of agent IDs.
 */
export function createCustomPipeline(
  chain: string[],
  timeout: number = 600000,
): PipelineDefinition {
  return {
    id: `custom-${crypto.randomUUID().slice(0, 8)}`,
    name: "Custom Pipeline",
    chain,
    timeout,
    failureMode: "graceful",
  };
}

/**
 * Summarize pipeline results for display.
 */
export function summarizePipelineResult(result: PipelineResult): string {
  const lines: string[] = [];

  lines.push(`Pipeline: ${result.pipelineId}`);
  lines.push(`Status: ${result.status}`);
  lines.push(
    `Stages: ${result.stages.length} (${result.stages.filter((s) => s.status === "success").length} successful)`,
  );
  lines.push(`Duration: ${(result.totalDurationMs / 1000).toFixed(1)}s`);
  if (result.survivalDecision) {
    lines.push(
      `Survival: ${result.survivalDecision.passed ? "PASS" : "BLOCK"} (${result.survivalDecision.score.toFixed(1)})`,
    );
  }
  lines.push("");

  for (const stage of result.stages) {
    const icon =
      stage.status === "success"
        ? "[OK]"
        : stage.status === "timeout"
          ? "[TIMEOUT]"
          : "[ERROR]";
    lines.push(
      `${icon} Stage ${stage.stageIndex + 1}: ${stage.agentId} (${(stage.durationMs / 1000).toFixed(1)}s)`,
    );

    if (stage.error) {
      lines.push(`   Error: ${stage.error}`);
    }
  }

  if (result.finalOutput) {
    lines.push("");
    lines.push("=== FINAL OUTPUT ===");
    lines.push(
      result.finalOutput.slice(0, 500) +
        (result.finalOutput.length > 500 ? "..." : ""),
    );
  }

  if (result.survivalDecision) {
    lines.push("");
    lines.push("=== SURVIVAL DECISION ===");
    lines.push(formatSurvivalDecision(result.survivalDecision));
  }

  return lines.join("\n");
}
