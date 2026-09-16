/**
 * Plugin System — Barrel Exports
 *
 * Cordis-style capability seams for DynaTrader.
 * One active provider per capability; consumers call getProvider<T>().
 */

export type {
  PluginCapability,
  DynaPlugin,
  PluginFactory,
  PluginContext,
  PluginLogger,
  PluginManifest,
  PluginToolDeclaration,
  PluginToolHandler,
  MarketDataProvider,
  SignalProvider,
  RiskProvider,
  NewsProvider,
  ExchangeProvider,
  BacktestProvider,
  DeFiProvider,
  MacroProvider,
  Candle,
  OrderBook,
  Signal,
  ConsensusSignal,
  AccuracyStats,
  SignalDirection,
  SignalTier,
  RiskGateRequest,
  RiskGateResult,
  CircuitBreakerConfig,
  NewsArticle,
  SentimentData,
  NewsOptions,
  ExchangeInfo,
  BacktestConfig,
  BacktestResult,
  StrategyInfo,
  Chain,
  Protocol,
  Pool,
  MacroEvent,
  MacroImpact,
  FOMCMeeting,
} from "./types";

export { PluginRegistry } from "./registry";
export type { PluginRegistryOptions, RegisteredPlugin, PluginRegistryStats } from "./registry";

export { MCPBridge } from "./mcp-bridge";
export type { MCPBridgeConfig, MCPToolMapping, MCPBridgeConnection } from "./mcp-bridge";
