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
  Candle,
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

  private async createClient(_config: MCPBridgeConfig): Promise<MCPClientHandle> {
    // Placeholder — real implementation connects via stdio/HTTP transport
    return {
      call: async (_method: string, _args: Record<string, unknown>) => {
        throw new Error("MCP transport not yet connected");
      },
      disconnect: async () => {},
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
        return (result as { symbols?: string[] }).symbols ?? [];
      },
      getPrice: async (symbol: string) => {
        const result = await client.call(mapping.methods.getPrice ?? "get_price", { symbol, ...(mapping.defaultArgs ?? {}) });
        return (result as { price?: number }).price ?? 0;
      },
      getOHLCV: async (symbol: string, timeframe: string, limit?: number) => {
        const result = await client.call(mapping.methods.getOHLCV ?? "get_ohlcv", { symbol, timeframe, limit, ...(mapping.defaultArgs ?? {}) });
        const raw = (result as { candles?: Array<Record<string, unknown>> }).candles ?? [];
        return raw.map((c) => ({
          timestamp: Number(c.timestamp),
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close),
          volume: Number(c.volume),
        })) as Candle[];
      },
      getOrderBook: async (symbol: string) => {
        const result = await client.call(mapping.methods.getOrderBook ?? "get_orderbook", { symbol, ...(mapping.defaultArgs ?? {}) });
        return (result as OrderBook) ?? { bids: [], asks: [], timestamp: Date.now() };
      },
      get24hVolume: async (symbol: string) => {
        const result = await client.call(mapping.methods.get24hVolume ?? "get_24h_volume", { symbol, ...(mapping.defaultArgs ?? {}) });
        return (result as { volume?: number }).volume ?? 0;
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
        return (result as { articles?: NewsArticle[] }).articles ?? [];
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

interface MCPClientHandle {
  call(method: string, args: Record<string, unknown>): Promise<unknown>;
  disconnect(): Promise<void>;
}
