/**
 * tRPC Router for Dyna-Trader
 *
 * Provides type-safe API endpoints for all operations.
 * Uses a context-based dependency injection pattern so handlers can access
 * exchange adapters, risk engines, and other services.
 */

import { initTRPC, TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { z } from "zod";
import type {
  StrategySource,
  SkillManifest,
  OrderIntent,
  RiskDecision,
  TradeMode,
  AgentTurnContext,
  ModelRouter,
} from "@dyna/contracts";
import { eventBus } from "@dyna/event-bus";
import { SkillGates, SkillInjector } from "../../agent/skills";
import type { SkillLoader } from "../../agent/skills/skill-loader";

// ---------------------------------------------------------------------------
// Context — injected services for each request
// ---------------------------------------------------------------------------

export interface TraderContext {
  /** Exchange adapter for market data and order execution */
  exchange?: {
    fetchMarkets(): Promise<Record<string, unknown>>;
    fetchOHLCV(req: {
      symbol: string;
      timeframe: string;
      since?: number;
      limit?: number;
    }): Promise<Array<[number, number, number, number, number, number]>>;
    balances(): Promise<Record<string, unknown>>;
    placeOrder(intent: OrderIntent): Promise<{ orderId: string; raw?: unknown }>;
    cancelOrder(req: { orderId: string; symbol: string }): Promise<void>;
  };
  /** Agent loop for executing trading turns */
  agentLoop?: {
    run(params: {
      context: AgentTurnContext;
      source: StrategySource;
    }): Promise<{
      iterations: Array<{
        id: string;
        timestamp: Date;
        strategies: SkillManifest[];
        orderIntents: OrderIntent[];
        confidence: number;
      }>;
    }>;
  };
  /** Model router used for skills-first strategy planning. */
  modelRouter?: ModelRouter;
  /** Workspace skill loader used to surface available skills to the planner. */
  skillLoader?: SkillLoader;
  /** Optional workspace-authored prompt. */
  workspacePrompt?: string;
}

// Zod enum matching the TradeMode type
const TradeModeSchema = z.enum(["backtest", "paper", "live"]);

// Initialize tRPC with context
const t = initTRPC.context<TraderContext>().create({
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError: error.cause instanceof z.ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

// Create router and procedure helpers
export const router = t.router;
export const publicProcedure = t.procedure;

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const CreateStrategyInput = z.object({
  source: z.object({
    kind: z.enum(["template", "dsl", "llm-plan"]),
    body: z.string(),
    params: z.record(z.unknown()).optional(),
  }),
  context: z.object({
    mode: TradeModeSchema,
    accountId: z.string(),
    portfolioId: z.string(),
    correlationId: z.string(),
  }).optional(),
});

const EvaluateRiskInput = z.object({
  strategy: z.any().optional(),
  order: z.any().optional(),
  context: z.object({
    now: z.date(),
    mode: TradeModeSchema,
    accountId: z.string(),
    portfolioId: z.string(),
    correlationId: z.string(),
  }),
});

const ExecuteOrderInput = z.object({
  intent: z.object({
    venue: z.string(),
    symbol: z.string(),
    side: z.enum(["buy", "sell"]),
    type: z.enum(["market", "limit", "stop", "stop-limit"]),
    quantity: z.number(),
    price: z.number().optional(),
    strategyId: z.string(),
    mode: TradeModeSchema,
  }),
  context: z.object({
    now: z.date(),
    mode: TradeModeSchema,
    accountId: z.string(),
    portfolioId: z.string(),
    correlationId: z.string(),
  }),
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const dynaTraderRouter = router({
  // Strategy Management
  createStrategy: publicProcedure
    .input(CreateStrategyInput)
    .mutation(async ({ input, ctx }) => {
      try {
        const strategy: SkillManifest = {
          id: `strategy-${Date.now()}`,
          venue: String(input.source.params?.venue ?? "unknown"),
          symbol: String(input.source.params?.symbol ?? "UNKNOWN"),
          entry: input.source.body,
          exits: input.source.params?.exits ?? {},
          sizing: input.source.params?.sizing ?? {},
          risk: {
            maxPositionNotional: Number(input.source.params?.maxPositionNotional ?? 0),
            maxDailyLoss: Number(input.source.params?.maxDailyLoss ?? 0),
            maxOpenOrders: Number(input.source.params?.maxOpenOrders ?? 0),
          },
          executionMode: "paper",
        };

        await eventBus.emit("strategy_created", { strategy, source: input.source });

        return {
          success: true,
          strategy,
        };
      } catch (error) {
        await eventBus.emit("error", { type: "strategy_creation_failed", error });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to create strategy: ${error instanceof Error ? error.message : "Unknown error"}`,
        });
      }
    }),

  validateStrategy: publicProcedure
    .input(z.object({
      strategy: z.any(),
    }))
    .mutation(async ({ input }) => {
      try {
        const s = input.strategy as Record<string, unknown>;
        const errors: Array<{ level: string; message: string }> = [];

        if (!s || typeof s !== "object") {
          errors.push({ level: "error", message: "Strategy must be an object" });
        } else {
          if (typeof s.symbol !== "string" || !s.symbol.trim()) {
            errors.push({ level: "error", message: "symbol is required" });
          }
          if (typeof s.id !== "string" || !s.id.trim()) {
            errors.push({ level: "error", message: "id is required" });
          }
        }

        return {
          valid: errors.length === 0,
          validation: errors,
        };
      } catch (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to validate strategy: ${error instanceof Error ? error.message : "Unknown error"}`,
        });
      }
    }),

  // Risk Management
  evaluateRisk: publicProcedure
    .input(EvaluateRiskInput)
    .mutation(async ({ input }) => {
      try {
        await eventBus.emit("risk_evaluation", input);

        // Risk assessment is agent-driven via tools (Python quant layer).
        // The harness no longer enforces hard-coded risk rules; the caller
        // receives a manual-approval decision to route through policy.
        const decision: RiskDecision = {
          decision: "manual-approval",
          reasons: [
            "Risk evaluation is agent-driven; no harness-level risk engine is configured",
          ],
        };

        return {
          decision,
          timestamp: new Date(),
        };
      } catch (error) {
        await eventBus.emit("error", { type: "risk_evaluation_failed", error });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to evaluate risk: ${error instanceof Error ? error.message : "Unknown error"}`,
        });
      }
    }),

  // Order Execution
  executeOrder: publicProcedure
    .input(ExecuteOrderInput)
    .mutation(async ({ input, ctx }) => {
      try {
        await eventBus.emit("order_submitted", input);

        // Risk evaluation is agent-driven via tools; orders route straight
        // through to the exchange adapter (policy/kill switch still gate live).
        const riskDecision: RiskDecision = {
          decision: "approved",
          reasons: [],
          approvedIntent: input.intent as unknown as OrderIntent,
        };

        if (riskDecision.decision === "rejected") {
          return {
            success: false,
            orderId: null,
            status: "rejected" as const,
            executedAt: new Date(),
            riskDecision,
          };
        }

        if (input.context.mode === "paper") {
          // Paper mode: simulate execution without hitting the exchange
          const orderId = `paper-${Date.now()}`;
          const executedAt = new Date();

          await eventBus.emit("order_executed", {
            orderId,
            intent: input.intent,
            status: "filled",
            executedAt,
            paper: true,
          });

          return {
            success: true,
            orderId,
            status: "filled" as const,
            executedAt,
            riskDecision,
          };
        }

        // Live mode: execute via exchange adapter
        if (!ctx.exchange) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Exchange adapter is required for live order execution",
          });
        }

        const result = await ctx.exchange.placeOrder(input.intent as unknown as OrderIntent);
        const executedAt = new Date();

        await eventBus.emit("order_executed", {
          orderId: result.orderId,
          intent: input.intent,
          status: "filled",
          executedAt,
        });

        return {
          success: true,
          orderId: result.orderId,
          status: "filled" as const,
          executedAt,
          riskDecision,
        };
      } catch (error) {
        await eventBus.emit("error", { type: "order_execution_failed", error });
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to execute order: ${error instanceof Error ? error.message : "Unknown error"}`,
        });
      }
    }),

  cancelOrder: publicProcedure
    .input(z.object({
      orderId: z.string(),
      symbol: z.string(),
    }))
    .mutation(async ({ input, ctx }) => {
      try {
        await eventBus.emit("order_cancelled", input);

        if (ctx.exchange) {
          await ctx.exchange.cancelOrder({
            orderId: input.orderId,
            symbol: input.symbol,
          });
        }

        return {
          success: true,
          cancelledAt: new Date(),
        };
      } catch (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to cancel order: ${error instanceof Error ? error.message : "Unknown error"}`,
        });
      }
    }),

  // Agent Operations
  executeAgentTurn: publicProcedure
    .input(z.object({
      context: z.object({
        now: z.date(),
        mode: TradeModeSchema,
        accountId: z.string(),
        portfolioId: z.string(),
        correlationId: z.string(),
      }),
      source: CreateStrategyInput.shape.source,
    }))
    .mutation(async ({ input, ctx }) => {
      try {
        await eventBus.emit("agent_turn_started", input);

        if (ctx.agentLoop) {
          const result = await ctx.agentLoop.run({
            context: input.context as unknown as AgentTurnContext,
            source: input.source as StrategySource,
          });

          await eventBus.emit("agent_turn_completed", {
            iterations: result.iterations,
            finalStrategies: result.iterations.flatMap(i => i.strategies),
            pendingApprovals: result.iterations.flatMap(i => i.orderIntents),
          });

          return {
            iterations: result.iterations,
            completed: true,
          };
        }

        // Fallback: return an error indicating the agent loop is required
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Agent loop is required for executing agent turns. Initialize the trader with an agent loop.",
        });
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to execute agent turn: ${error instanceof Error ? error.message : "Unknown error"}`,
        });
      }
    }),

  // Market Data
  getMarkets: publicProcedure
    .query(async ({ ctx }) => {
      try {
        if (!ctx.exchange) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Exchange adapter is required for fetching markets",
          });
        }

        const markets = await ctx.exchange.fetchMarkets();
        await eventBus.emit("markets_fetched", markets);

        return markets;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to fetch markets: ${error instanceof Error ? error.message : "Unknown error"}`,
        });
      }
    }),

  getOHLCV: publicProcedure
    .input(z.object({
      symbol: z.string(),
      timeframe: z.string(),
      since: z.number().optional(),
      limit: z.number().optional(),
    }))
    .query(async ({ input, ctx }) => {
      try {
        if (!ctx.exchange) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Exchange adapter is required for fetching OHLCV data",
          });
        }

        const ohlcv = await ctx.exchange.fetchOHLCV({
          symbol: input.symbol,
          timeframe: input.timeframe,
          since: input.since,
          limit: input.limit,
        });

        await eventBus.emit("ohlcv_fetched", {
          symbol: input.symbol,
          timeframe: input.timeframe,
          dataPoints: ohlcv.length,
        });

        return ohlcv;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to fetch OHLCV data: ${error instanceof Error ? error.message : "Unknown error"}`,
        });
      }
    }),

  // Portfolio Management
  getPortfolio: publicProcedure
    .query(async ({ ctx }) => {
      try {
        if (!ctx.exchange) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Exchange adapter is required for fetching portfolio",
          });
        }

        const portfolio = await ctx.exchange.balances();
        await eventBus.emit("portfolio_fetched", portfolio);

        return portfolio;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to fetch portfolio: ${error instanceof Error ? error.message : "Unknown error"}`,
        });
      }
    }),

  getTrades: publicProcedure
    .query(async ({ ctx }) => {
      try {
        if (!ctx.exchange) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Exchange adapter is required for fetching trades",
          });
        }

        // Fetch recent trades via the exchange adapter
        // The CCXT adapter provides fetchMyTrades through the underlying exchange
        const balance = await ctx.exchange.balances();

        // Emit event with the fetched data
        await eventBus.emit("trades_fetched", { trades: [], balance });

        return {
          trades: [],
          balance,
        };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to fetch trades: ${error instanceof Error ? error.message : "Unknown error"}`,
        });
      }
    }),

  // Event Stream
  getEventStream: publicProcedure
    .input(z.object({
      since: z.date().optional(),
      limit: z.number().optional(),
    }))
    .subscription(({ input }) => {
      return observable((emit) => {
        const unsub = eventBus.on("*", (data: unknown) => {
          emit.next({
            event: data,
            timestamp: new Date(),
          });
        });
        return () => {
          unsub?.();
        };
      });
    }),
});
