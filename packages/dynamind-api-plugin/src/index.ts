/**
 * @dyna/plugin-dynamind-api
 *
 * DynaMind Data API plugin — the bundled default provider for DynaTrader.
 * Wraps every DynaMind API endpoint as a capability provider.
 *
 * This plugin ships with DynaTrader and is the default for all capabilities.
 * Users hit API rate limits → buy credits → drives sales.
 *
 * Other plugins can override any capability by registering the same one.
 */

import type { DynaPlugin, PluginContext } from "dynatrader";
import { createMarketDataProvider, type DynaMindMarketDataConfig } from "./market-data";
import { createSignalProvider, type DynaMindSignalConfig } from "./signals";
import { createRiskProvider, type DynaMindRiskConfig } from "./risk";
import { createNewsProvider, type DynaMindNewsConfig } from "./news";
import { createBacktestProvider, type DynaMindBacktestConfig } from "./backtest";
import { createDeFiProvider, type DynaMindDeFiConfig } from "./defi";
import { createMacroProvider, type DynaMindMacroConfig } from "./macro";

// ---------------------------------------------------------------------------
// Plugin Config
// ---------------------------------------------------------------------------

export interface DynaMindPluginConfig {
  baseUrl: string;
  apiKey?: string;
}

// ---------------------------------------------------------------------------
// Plugin Factory
// ---------------------------------------------------------------------------

export default function createDynaMindPlugin(
  userConfig: Partial<DynaMindPluginConfig> = {},
): DynaPlugin {
  const config: DynaMindPluginConfig = {
    baseUrl: userConfig.baseUrl ?? process.env["DYNAMIND_API_URL"] ?? "http://localhost:3000",
    apiKey: userConfig.apiKey ?? process.env["DYNAMIND_API_KEY"],
  };

  return {
    id: "dynamind-api",
    version: "1.0.0",
    description: "DynaMind Data API — premium market data, AI signals, and analytics",
    capabilities: [
      "market_data",
      "signal",
      "risk",
      "news",
      "backtest",
      "defi",
      "macro",
    ],

    async init(ctx: PluginContext) {
      const apiConfig: DynaMindMarketDataConfig & DynaMindSignalConfig &
        DynaMindRiskConfig & DynaMindNewsConfig & DynaMindBacktestConfig &
        DynaMindDeFiConfig & DynaMindMacroConfig = {
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
      };

      ctx.registerService("market_data", createMarketDataProvider(apiConfig));
      ctx.registerService("signal", createSignalProvider(apiConfig));
      ctx.registerService("risk", createRiskProvider(apiConfig));
      ctx.registerService("news", createNewsProvider(apiConfig));
      ctx.registerService("backtest", createBacktestProvider(apiConfig));
      ctx.registerService("defi", createDeFiProvider(apiConfig));
      ctx.registerService("macro", createMacroProvider(apiConfig));

      ctx.logger.info(
        `DynaMind API plugin connected to ${config.baseUrl}` +
        (config.apiKey ? " (authenticated)" : " (anonymous)"),
      );
    },
  };
}

// Re-export all provider types
export type { DynaMindMarketDataConfig } from "./market-data";
export type { DynaMindSignalConfig } from "./signals";
export type { DynaMindRiskConfig } from "./risk";
export type { DynaMindNewsConfig } from "./news";
export type { DynaMindBacktestConfig } from "./backtest";
export type { DynaMindDeFiConfig } from "./defi";
export type { DynaMindMacroConfig } from "./macro";
