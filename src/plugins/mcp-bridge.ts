/**
 * MCP Bridge
 *
 * Connects external MCP servers as capability providers.
 * Wraps MCP tools as typed capability providers and registers them
 * with the plugin registry.
 *
 * Example: A user adds a custom risk analysis MCP server — the bridge
 * wraps its tools as a RiskProvider and registers it.
 */

import { Logger } from "@dyna/audit";
import type {
  PluginCapability,
  MarketDataProvider,
  SignalProvider,
  RiskProvider,
  NewsProvider,
  OrderBook,
  Signal,
  ConsensusSignal,
  AccuracyStats,
  RiskGateRequest,
  RiskGateResult,
  CircuitBreakerConfig,
  NewsArticle,
  SentimentData,
  NewsOptions,
} from "./types";
import type { PluginRegistry } from "./registry";
import { McpClient } from "../mcp/client";
import { ToolRegistryImpl } from "../runtime/tools/tool-registry";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MCPBridgeConfig {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  capability: PluginCapability;
  toolMapping: MCPToolMapping;
}

export interface MCPToolMapping {
  /** MCP tool name to call for each capability method */
  methods: Record<string, string>;
  /** Default arguments to merge into each call */
  defaultArgs?: Record<string, unknown>;
}

export interface MCPBridgeConnection {
  name: string;
  capability: PluginCapability;
  connected: boolean;
  tools: string[];
}

// ---------------------------------------------------------------------------
// MCP Bridge
// ---------------------------------------------------------------------------

export class MCPBridge {
  private readonly logger: Logger;
  private readonly registry: PluginRegistry;
  private readonly connections = new Map<string, MCPBridgeConnection>();
  private readonly clients = new Map<string, MCPClientHandle>();

  constructor(registry: PluginRegistry, logger?: Logger) {
    this.registry = registry;
    this.logger = logger ?? new Logger("MCPBridge");
  }

  /**
   * Connect an MCP server and register it as a capability provider.
   */
  async connect(config: MCPBridgeConfig): Promise<MCPBridgeConnection> {
    this.logger.info(`Connecting MCP server: ${config.name} -> ${config.capability}`);

    // Create MCP client connection
    const client = await this.createClient(config);
    this.clients.set(config.name, client);

    // Create capability provider wrapper
    const provider = this.wrapAsProvider(config, client);

    // Register with plugin registry
    const plugin = {
      id: `mcp-${config.name}`,
      version: "1.0.0",
      description: `MCP bridge: ${config.name} providing ${config.capability}`,
      capabilities: [config.capability],
      init: async (ctx: { registerService: <T>(name: string, handle: T) => void }) => {
        ctx.registerService(config.capability, provider);
      },
    };

    await this.registry.register(plugin);

    const connection: MCPBridgeConnection = {
      name: config.name,
      capability: config.capability,
      connected: true,
      tools: Object.values(config.toolMapping.methods),
    };

    this.connections.set(config.name, connection);
    this.logger.info(
      `MCP bridge connected: ${config.name} -> ${config.capability} ` +
      `(${connection.tools.length} tools)`,
    );

    return connection;
  }

  /**
   * Disconnect an MCP server.
   */
  async disconnect(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (client) {
      await client.disconnect();
      this.clients.delete(name);
    }
    await this.registry.unregister(`mcp-${name}`);
    this.connections.delete(name);
    this.logger.info(`MCP bridge disconnected: ${name}`);
  }

  /**
   * List all active connections.
   */
  listConnections(): MCPBridgeConnection[] {
    return [...this.connections.values()];
  }

  /**
   * Disconnect all servers.
   */
  async disconnectAll(): Promise<void> {
    for (const [name] of this.clients) {
      await this.disconnect(name);
    }
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async createClient(config: MCPBridgeConfig): Promise<MCPClientHandle> {
    const client = new McpClient(new ToolRegistryImpl());
    await client.connect({ name: config.name, transport: config.transport, command: config.command, args: config.args, url: config.url, env: config.env });
    return {
      call: async (method, args) => decodeMcpToolResult(await client.call(config.name, method, args)),
      disconnect: () => client.disconnect(config.name),
    };
  }

  private wrapAsProvider(
    config: MCPBridgeConfig,
    client: MCPClientHandle,
  ): unknown {
    const { capability, toolMapping } = config;

    switch (capability) {
      case "market_data":
        return this.wrapMarketData(client, toolMapping);
      case "signal":
        return this.wrapSignal(client, toolMapping);
      case "risk":
        return this.wrapRisk(client, toolMapping);
      case "news":
        return this.wrapNews(client, toolMapping);
      default:
        return this.wrapGeneric(client, toolMapping);
    }
  }

  private wrapMarketData(
    client: MCPClientHandle,
    mapping: MCPToolMapping,
  ): MarketDataProvider {
    return {
      fetchUniverse: async () => {
        const result = await client.call(mapping.methods.fetchUniverse ?? "fetch_universe", mapping.defaultArgs ?? {});
        return requireStringArrayField(result, "symbols");
      },
      getPrice: async (symbol: string) => {
        const result = await client.call(mapping.methods.getPrice ?? "get_price", { symbol, ...(mapping.defaultArgs ?? {}) });
        return requireFiniteNumberField(result, "price");
      },
      getOHLCV: async (symbol: string, timeframe: string, limit?: number) => {
        const result = await client.call(mapping.methods.getOHLCV ?? "get_ohlcv", { symbol, timeframe, limit, ...(mapping.defaultArgs ?? {}) });
        return requireArrayField(result, "candles").map((value) => {
          if (!isRecord(value)) {
            throw new Error("MCP market-data response contains an invalid candle");
          }
          return {
            timestamp: requireFiniteCandleNumber(value.timestamp, "timestamp"),
            open: requireFiniteCandleNumber(value.open, "open"),
            high: requireFiniteCandleNumber(value.high, "high"),
            low: requireFiniteCandleNumber(value.low, "low"),
            close: requireFiniteCandleNumber(value.close, "close"),
            volume: requireFiniteCandleNumber(value.volume, "volume"),
          };
        });
      },
      getOrderBook: async (symbol: string) => {
        const result = await client.call(mapping.methods.getOrderBook ?? "get_orderbook", { symbol, ...(mapping.defaultArgs ?? {}) });
        return requireOrderBook(result);
      },
      get24hVolume: async (symbol: string) => {
        const result = await client.call(mapping.methods.get24hVolume ?? "get_24h_volume", { symbol, ...(mapping.defaultArgs ?? {}) });
        return requireFiniteNumberField(result, "volume");
      },
    };
  }

  private wrapSignal(
    client: MCPClientHandle,
    mapping: MCPToolMapping,
  ): SignalProvider {
    return {
      getSignal: async (symbol: string) => {
        const result = await client.call(mapping.methods.getSignal ?? "get_signal", { symbol, ...(mapping.defaultArgs ?? {}) });
        return result as Signal;
      },
      getConsensus: async (symbol: string) => {
        const result = await client.call(mapping.methods.getConsensus ?? "get_consensus", { symbol, ...(mapping.defaultArgs ?? {}) });
        return result as ConsensusSignal;
      },
      getAccuracy: async () => {
        const result = await client.call(mapping.methods.getAccuracy ?? "get_accuracy", mapping.defaultArgs ?? {});
        return result as AccuracyStats;
      },
    };
  }

  private wrapRisk(
    client: MCPClientHandle,
    mapping: MCPToolMapping,
  ): RiskProvider {
    return {
      evaluateTrade: async (request: RiskGateRequest) => {
        const result = await client.call(mapping.methods.evaluateTrade ?? "evaluate_trade", { request, ...(mapping.defaultArgs ?? {}) });
        return result as RiskGateResult;
      },
      getCircuitBreakerConfig: async () => {
        const result = await client.call(mapping.methods.getCircuitBreakerConfig ?? "get_circuit_breaker_config", mapping.defaultArgs ?? {});
        return result as CircuitBreakerConfig;
      },
    };
  }

  private wrapNews(
    client: MCPClientHandle,
    mapping: MCPToolMapping,
  ): NewsProvider {
    return {
      getNews: async (options?: NewsOptions) => {
        const result = await client.call(mapping.methods.getNews ?? "get_news", { options, ...(mapping.defaultArgs ?? {}) });
        return requireNewsArticles(result);
      },
      getSentiment: async (symbol?: string) => {
        const result = await client.call(mapping.methods.getSentiment ?? "get_sentiment", { symbol, ...(mapping.defaultArgs ?? {}) });
        return result as SentimentData;
      },
    };
  }

  private wrapGeneric(
    client: MCPClientHandle,
    mapping: MCPToolMapping,
  ): Record<string, (args: unknown) => Promise<unknown>> {
    const methods: Record<string, (args: unknown) => Promise<unknown>> = {};
    for (const [methodName, toolName] of Object.entries(mapping.methods)) {
      methods[methodName] = async (args: unknown) => {
        return client.call(toolName, { ...(args as Record<string, unknown>), ...(mapping.defaultArgs ?? {}) });
      };
    }
    return methods;
  }
}

// ---------------------------------------------------------------------------
// Internal MCP Client Handle
// ---------------------------------------------------------------------------

function requireNewsArticles(result: unknown): NewsArticle[] {
  const articles = Array.isArray(result)
    ? result
    : isRecord(result)
      ? result.articles
      : undefined;
  if (!Array.isArray(articles)) {
    throw new Error("MCP news response must include an articles array");
  }

  if (!articles.every(isNewsArticle)) {
    throw new Error("MCP news response contains an invalid article");
  }
  return articles;
}

function isNewsArticle(value: unknown): value is NewsArticle {
  if (!isRecord(value)) return false;
  return typeof value.title === "string" &&
    typeof value.url === "string" &&
    typeof value.source === "string" &&
    typeof value.publishedAt === "string" &&
    (value.sentiment === undefined || value.sentiment === "bullish" || value.sentiment === "bearish" || value.sentiment === "neutral") &&
    (value.score === undefined || (typeof value.score === "number" && Number.isFinite(value.score))) &&
    (value.categories === undefined || isStringArray(value.categories));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireArrayField(result: unknown, field: string): unknown[] {
  const value = isRecord(result) ? result[field] : undefined;
  if (!Array.isArray(value)) {
    throw new Error(`MCP market-data response must include an array "${field}" field`);
  }
  return value;
}

function requireFiniteCandleNumber(value: unknown, field: string): number {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(numeric)) {
    throw new Error(`MCP market-data candle field "${field}" must be finite`);
  }
  return numeric;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function requireStringArrayField(result: unknown, field: string): string[] {
  const value = isRecord(result) ? result[field] : undefined;
  if (!isStringArray(value)) {
    throw new Error(`MCP market-data response must include a string array "${field}" field`);
  }
  return value;
}

function isOrderBookLevel(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 &&
    typeof value[0] === "number" && Number.isFinite(value[0]) &&
    typeof value[1] === "number" && Number.isFinite(value[1]);
}

function isOrderBookLevels(value: unknown): value is Array<[number, number]> {
  return Array.isArray(value) && value.every(isOrderBookLevel);
}

function isOrderBook(value: unknown): value is OrderBook {
  return isRecord(value) &&
    isOrderBookLevels(value.bids) &&
    isOrderBookLevels(value.asks) &&
    typeof value.timestamp === "number" &&
    Number.isFinite(value.timestamp);
}

function requireOrderBook(result: unknown): OrderBook {
  if (!isOrderBook(result)) {
    throw new Error("MCP market-data response must include valid bids, asks, and timestamp");
  }
  return result;
}

function requireFiniteNumberField(result: unknown, field: string): number {
  if (!isRecord(result)) {
    throw new Error(`MCP market-data response must include a finite numeric "${field}" field`);
  }

  const value = result[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`MCP market-data response must include a finite numeric "${field}" field`);
  }
  return value;
}

function decodeMcpToolResult(result: unknown): unknown {
  if (!Array.isArray(result) || result.length === 0) return result;

  const textBlocks: string[] = [];
  for (const content of result) {
    if (!isRecord(content) || content.type !== "text" || typeof content.text !== "string") {
      return result;
    }
    textBlocks.push(content.text);
  }

  const text = textBlocks.join("");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return textBlocks.length === 1 ? text : result;
  }
}

interface MCPClientHandle {
  call(method: string, args: Record<string, unknown>): Promise<unknown>;
  disconnect(): Promise<void>;
}
