/**
 * Plugin Capability Interfaces (Seams)
 *
 * Every capability is a typed interface that plugins can implement.
 * The plugin registry holds one active provider per capability.
 * DynaMind API ships as the default for all capabilities.
 */

// ---------------------------------------------------------------------------
// Base Plugin
// ---------------------------------------------------------------------------

/** All capability types a plugin can provide */
export type PluginCapability =
  | "market_data"
  | "signal"
  | "risk"
  | "news"
  | "exchange"
  | "backtest"
  | "defi"
  | "macro"
  | "wallet"
  | "dex_routing"
  | "gas_estimation";

/** A DynaTrader plugin */
export interface DynaPlugin {
  id: string;
  version: string;
  description: string;
  capabilities: PluginCapability[];
  init(ctx: PluginContext): Promise<void> | void;
  stop?(ctx: PluginContext): Promise<void> | void;
}

/**
 * Plugin entry contract (dsh/Cordis style): a plugin module's default export
 * is a factory that receives its resolved config row and returns a plugin.
 * Registrations made during init are effects that unwind on unmount.
 */
export type PluginFactory = (
  config: Record<string, unknown>,
) => DynaPlugin | Promise<DynaPlugin>;

/** Declaration of a model-facing tool contributed by a plugin. */
export interface PluginToolDeclaration {
  name: string;
  description: string;
  category: string;
  inputSchema: Record<string, unknown>;
  permissionsRequired?: string[];
  sideEffects?: string[];
  riskLevel?: "low" | "medium" | "high" | "critical";
  timeoutMs?: number;
  canRunInParallel?: boolean;
  readOnly?: boolean;
  profiles?: string[];
}

/** Execution handler for a plugin-contributed tool. */
export type PluginToolHandler = (
  call: { args: Record<string, unknown> },
) => Promise<unknown>;

/** Context handed to a plugin during init/stop */
export interface PluginContext {
  readonly id: string;
  /** Resolved config for this plugin (manifest defaults overlaid by the composition row). */
  readonly config: Readonly<Record<string, unknown>>;
  registerService<T>(name: string, handle: T): void;
  getService<T>(name: string): T | undefined;
  emit(event: string, payload?: unknown): Promise<void>;
  on(event: string, handler: (payload: unknown) => void | Promise<void>): () => void;
  /** Register a model-facing tool on the shared ToolRegistry (unwinds on unmount). */
  registerTool(decl: PluginToolDeclaration, handler: PluginToolHandler): void;
  readonly logger: PluginLogger;
}

export interface PluginLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

// ---------------------------------------------------------------------------
// Market Data Provider
// ---------------------------------------------------------------------------

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OrderBook {
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
  timestamp: number;
}

export interface MarketDataProvider {
  fetchUniverse(): Promise<string[]>;
  getPrice(symbol: string): Promise<number>;
  getOHLCV(symbol: string, timeframe: string, limit?: number): Promise<Candle[]>;
  getOrderBook(symbol: string): Promise<OrderBook>;
  get24hVolume(symbol: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// Signal Provider
// ---------------------------------------------------------------------------

export type SignalDirection = "BULLISH" | "BEARISH" | "NEUTRAL";
export type SignalTier = "STRONG" | "MODERATE" | "WEAK";

export interface Signal {
  symbol: string;
  direction: SignalDirection;
  tier: SignalTier;
  confidence: number;
  rationale: string;
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  riskReward?: number;
  timeframe: string;
  timestamp: string;
}

export interface ConsensusSignal {
  symbol: string;
  direction: SignalDirection;
  tier: SignalTier;
  confidence: number;
  timeframe_signals: Record<string, Signal>;
  weights: Record<string, number>;
}

export interface AccuracyStats {
  totalSignals: number;
  correctSignals: number;
  accuracy: number;
  byTier: Record<SignalTier, { total: number; correct: number; accuracy: number }>;
}

export interface SignalProvider {
  getSignal(symbol: string): Promise<Signal>;
  getConsensus(symbol: string): Promise<ConsensusSignal>;
  getAccuracy(): Promise<AccuracyStats>;
}

// ---------------------------------------------------------------------------
// Risk Provider
// ---------------------------------------------------------------------------

export interface RiskGateRequest {
  portfolioValue: number;
  positionSize: number;
  proposedTradePct: number;
  currentPositions: Record<string, number>;
  dailyLoss: number;
  weeklyLoss: number;
  regime: "trending_up" | "trending_down" | "ranging" | "volatile";
  kellyPct: number;
  icScore?: number;
  irScore?: number;
}

export interface RiskGateResult {
  approved: boolean;
  reason: string;
  reductions: string[];
  mandatoryReasoning: string;
}

export interface CircuitBreakerConfig {
  dailyLossThreshold: number;
  weeklyLossThreshold: number;
  marketMoveThreshold: number;
  llmFailureThreshold: number;
  autoResetMinutes: number;
}

export interface RiskProvider {
  evaluateTrade(request: RiskGateRequest): Promise<RiskGateResult>;
  getCircuitBreakerConfig(): CircuitBreakerConfig | Promise<CircuitBreakerConfig>;
}

// ---------------------------------------------------------------------------
// News Provider
// ---------------------------------------------------------------------------

export interface NewsArticle {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  sentiment?: "bullish" | "bearish" | "neutral";
  score?: number;
  categories?: string[];
}

export interface SentimentData {
  overall: "bullish" | "bearish" | "neutral";
  score: number;
  sources: number;
}

export interface NewsOptions {
  symbol?: string;
  category?: string;
  limit?: number;
  minScore?: number;
}

export interface NewsProvider {
  getNews(options?: NewsOptions): Promise<NewsArticle[]>;
  getSentiment(symbol?: string): Promise<SentimentData>;
}

// ---------------------------------------------------------------------------
// Exchange Provider
// ---------------------------------------------------------------------------

export interface ExchangeInfo {
  id: string;
  name: string;
  type: "cex" | "dex";
  supported: string[];
}

export interface ExchangeProvider {
  getExchanges(): ExchangeInfo[];
  getAdapter(id: string): unknown | undefined;
}

// ---------------------------------------------------------------------------
// Backtest Provider
// ---------------------------------------------------------------------------

export interface BacktestConfig {
  strategy: string;
  symbol: string;
  timeframe: string;
  startDate: string;
  endDate: string;
  initialCapital: number;
  parameters?: Record<string, unknown>;
}

export interface BacktestResult {
  strategy: string;
  symbol: string;
  totalReturn: number;
  sharpeRatio: number;
  maxDrawdown: number;
  winRate: number;
  totalTrades: number;
  profitFactor: number;
  trades: Array<{
    entry: { price: number; timestamp: string };
    exit: { price: number; timestamp: string };
    side: "buy" | "sell";
    pnl: number;
  }>;
}

export interface StrategyInfo {
  id: string;
  name: string;
  description: string;
  parameters: Record<string, { type: string; default: unknown; description: string }>;
}

export interface BacktestProvider {
  runBacktest(config: BacktestConfig): Promise<BacktestResult>;
  listStrategies(): Promise<StrategyInfo[]>;
}

// ---------------------------------------------------------------------------
// DeFi Provider
// ---------------------------------------------------------------------------

export interface Chain {
  id: number;
  name: string;
  tvl: number;
  change24h: number;
}

export interface Protocol {
  name: string;
  slug: string;
  chain: string;
  tvl: number;
  change24h: number;
  category: string;
}

export interface Pool {
  address: string;
  chain: string;
  token0: string;
  token1: string;
  tvl: number;
  volume24h: number;
}

export interface DeFiProvider {
  getChains(): Promise<Chain[]>;
  getProtocols(): Promise<Protocol[]>;
  getPools(chainId?: number): Promise<Pool[]>;
}

// ---------------------------------------------------------------------------
// Macro Provider
// ---------------------------------------------------------------------------

export type MacroImpact = "high" | "medium" | "low";

export interface MacroEvent {
  date: string;
  title: string;
  impact: MacroImpact;
  currency: string;
  actual?: string;
  forecast?: string;
  previous?: string;
}

export interface FOMCMeeting {
  date: string;
  time: string;
  type: string;
}

export interface MacroProvider {
  getCalendar(): Promise<MacroEvent[]>;
  getFOMC(): Promise<FOMCMeeting[]>;
}

// ---------------------------------------------------------------------------
// Wallet Provider
// ---------------------------------------------------------------------------

export interface WalletBalanceInfo {
  chainId: number;
  address: string;
  nativeBalance: string;
  tokenBalances: Array<{
    token: string;
    symbol: string;
    balance: string;
    decimals: number;
  }>;
}

export interface WalletSwapQuote {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  priceImpact: number;
  gasEstimate?: string;
  source: string;
}

export interface WalletProvider {
  getBalance(chainId: number, address: string): Promise<WalletBalanceInfo>;
  getSwapQuote(params: {
    chainId: number;
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
    slippageTolerance?: number;
  }): Promise<WalletSwapQuote>;
  executeSwap(params: {
    chainId: number;
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
    slippageTolerance?: number;
  }): Promise<{ txHash: string; status: string }>;
  getGasPrice(chainId: number): Promise<{
    gasPrice?: string;
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
    isEIP1559: boolean;
  }>;
}

// ---------------------------------------------------------------------------
// DEX Routing Provider
// ---------------------------------------------------------------------------

export interface DEXRouteInfo {
  adapterName: string;
  amountOut: string;
  priceImpact: number;
  gasEstimate?: string;
  route: string[];
}

export interface DexRoutingProvider {
  getBestRoute(params: {
    chainId: number;
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
  }): Promise<DEXRouteInfo>;
  getSupportedAdapters(chainId: number): string[];
  getAdaptersForChain(chainId: number): Array<{
    name: string;
    supportedPairs: number;
  }>;
}

// ---------------------------------------------------------------------------
// Gas Estimation Provider
// ---------------------------------------------------------------------------

export interface GasEstimateResult {
  gasLimit: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  isEIP1559: boolean;
  estimatedAt: string;
}

export interface GasHistoryEntry {
  timestamp: string;
  gasPrice: string;
  maxFeePerGas?: string;
}

export interface GasEstimationProvider {
  estimateGas(params: {
    chainId: number;
    to: string;
    data?: string;
    value?: string;
  }): Promise<GasEstimateResult>;
  estimateGasPrice(chainId: number): Promise<GasEstimateResult>;
  getGasHistory(chainId: number, hours?: number): Promise<GasHistoryEntry[]>;
}

// ---------------------------------------------------------------------------
// Plugin Manifest (extends existing PluginManifest)
// ---------------------------------------------------------------------------

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  entry: string;
  author?: string;
  capabilities: PluginCapability[];
  permissions?: {
    network?: boolean;
    filesystem?: boolean;
    credentials?: boolean;
    orderExecution?: boolean;
  };
  hooks?: Array<{
    event: string;
    handler: string;
    timeout?: number;
    failurePolicy?: "fail_closed" | "fail_open" | "warn_only";
  }>;
  dependencies?: string[];
  config?: Record<string, unknown>;
}
