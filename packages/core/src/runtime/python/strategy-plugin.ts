/**
 * Python strategy kernel plugin
 *
 * Wraps the PythonStrategyBridge in a kernel PluginDefinition so the Dyna-Trader
 * kernel can mount a single "everything is a plugin" plugin that exposes
 * `python.strategy` and `python.health` services. Convention-coded responses
 * from the Python process are forwarded onto the kernel event bus under their
 * method name (e.g. `strategy.signal`).
 */

import { PythonStrategyBridge } from "./strategy-bridge";
import type {
  BacktestMetrics,
  HealthStatus,
  PluginInfo,
  RiskGate,
  SpawnFn,
  StrategySignal,
} from "./strategy-bridge";
import type { KernelPluginContext, PluginDefinition } from "../../kernel";

/** Public service handle exposed under `python.strategy`. */
export interface PythonStrategyService {
  info(): Promise<PluginInfo>;
  health(): Promise<HealthStatus>;
  onMarket(symbol: string): Promise<StrategySignal>;
  generateSignals(symbols: string[]): Promise<StrategySignal[]>;
  validateBacktest(result: Record<string, unknown>): Promise<BacktestMetrics>;
  riskCheck(
    signal: Record<string, unknown>,
    positionSize: number,
    maxRisk: number,
  ): Promise<RiskGate>;
  stop(): Promise<void>;
}

export interface PythonStrategyPluginOptions {
  /** Plugin id. Defaults to "python-strategy". */
  id?: string;
  /** Plugin version. Defaults to "1.0.0". */
  version?: string;
  /** Human readable description. */
  description?: string;
  /** Command forwarded to the bridge. */
  command?: string;
  /** Args forwarded to the bridge. */
  args?: string[];
  /** Working directory forwarded to the bridge. */
  cwd?: string;
  /** Environment forwarded to the bridge. */
  env?: NodeJS.ProcessEnv;
  /** Per-request timeout forwarded to the bridge. */
  timeoutMs?: number;
  /** Injectable spawn function (tests). */
  spawnFn?: SpawnFn;
}

/**
 * Build a lazy python-strategy kernel plugin. The child process is only
 * spawned on the first request through one of the exposed services.
 */
export function createPythonStrategyPlugin<TMeta = PythonStrategyPluginOptions>(
  options: PythonStrategyPluginOptions = {},
): PluginDefinition<TMeta> {
  const id = options.id ?? "python-strategy";
  const version = options.version ?? "1.0.0";
  const description =
    options.description ??
    "Strategy and research plugin executed by the Python DynaTrader SDK over stdio";

  let bridge: PythonStrategyBridge | null = null;

  return {
    id,
    version,
    description,
    meta: options as TMeta,
    init: async (ctx: KernelPluginContext): Promise<void> => {
      bridge = new PythonStrategyBridge({
        command: options.command,
        args: options.args,
        cwd: options.cwd,
        env: options.env,
        timeoutMs: options.timeoutMs,
        spawnFn: options.spawnFn,
      });

      // Forward convention-coded notifications from the Python process onto
      // the kernel event bus (e.g. method "strategy.signal").
      bridge.on("notification", (notification) => {
        if (
          typeof notification.method === "string" &&
          notification.method.startsWith("strategy.")
        ) {
          void ctx.emit(notification.method, notification.params);
        }
      });

      const service: PythonStrategyService = {
        info: () => bridge!.info(),
        health: () => bridge!.health(),
        onMarket: (symbol) => bridge!.onMarket(symbol),
        generateSignals: (symbols) => bridge!.generateSignals(symbols),
        validateBacktest: (result) => bridge!.validateBacktest(result),
        riskCheck: (signal, positionSize, maxRisk) =>
          bridge!.riskCheck(signal, positionSize, maxRisk),
        stop: () => bridge!.stop(),
      };

      ctx.registerService("python.strategy", service, {
        pluginId: ctx.id,
        version,
      });
      ctx.registerService("python.health", () => service.health(), {
        pluginId: ctx.id,
        version,
      });

      ctx.logger.info(
        `python strategy plugin '${id}' mounted (spawns on first call)`,
      );
    },
    stop: async (): Promise<void> => {
      if (bridge) {
        await bridge.stop();
      }
      bridge = null;
    },
  };
}