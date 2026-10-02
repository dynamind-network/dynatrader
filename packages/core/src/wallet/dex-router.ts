/**
 * Unified DEX Router
 *
 * Multi-adapter best-route selection with parallel quote aggregation.
 * Queries all registered DEX adapters in parallel, returns the best quote.
 * Supports chain-network string pattern: "ethereum-polygon", "arbitrum-mainnet".
 *
 * Integrates with TxPipeline for execution.
 */

import { getAddress, type Address } from 'viem';
import {
  SupportedChainId,
  type SwapParams,
  type SwapQuote,
  type TransactionRequest,
  type DEXAdapter,
  type DEXAdapterParams,
} from './types';
import type { TxPipeline } from './tx-pipeline';
import type { PipelineResult } from './types';

// ---------------------------------------------------------------------------
// Chain Network String Parsing
// ---------------------------------------------------------------------------

const CHAIN_NETWORK_MAP: Record<string, SupportedChainId> = {
  'ethereum': SupportedChainId.ETHEREUM,
  'mainnet': SupportedChainId.ETHEREUM,
  'polygon': SupportedChainId.POLYGON,
  'bsc': SupportedChainId.BSC,
  'binance': SupportedChainId.BSC,
  'arbitrum': SupportedChainId.ARBITRUM,
  'arb': SupportedChainId.ARBITRUM,
  'base': SupportedChainId.BASE,
  'optimism': SupportedChainId.OPTIMISM,
  'op': SupportedChainId.OPTIMISM,
};

/**
 * Parse a chain-network string like "ethereum-polygon" or "arbitrum-mainnet"
 * into a SupportedChainId. Falls back to numeric parsing.
 */
export function parseChainNetwork(chainNetwork: string): SupportedChainId {
  const lower = chainNetwork.toLowerCase().trim();

  // Direct match
  if (CHAIN_NETWORK_MAP[lower]) return CHAIN_NETWORK_MAP[lower];

  // Try "chain-network" format (take first part)
  const parts = lower.split('-');
  const chainPart = parts[0]!;
  if (CHAIN_NETWORK_MAP[chainPart]) return CHAIN_NETWORK_MAP[chainPart];

  // Try numeric
  const num = parseInt(lower, 10);
  if (!isNaN(num) && num in SupportedChainId) return num as SupportedChainId;

  throw new Error(`Unknown chain network: "${chainNetwork}"`);
}

// ---------------------------------------------------------------------------
// DEX Router Configuration
// ---------------------------------------------------------------------------

export interface DEXRouterConfig {
  /** Default adapter name to use if no preference specified */
  defaultAdapter?: string;
  /** Maximum number of adapters to query in parallel (default: 5) */
  maxConcurrentQueries: number;
  /** Timeout per adapter quote in ms (default: 10000) */
  quoteTimeoutMs: number;
  /** Per-chain adapter priority order */
  adapterPriority: Record<SupportedChainId, string[]>;
}

const DEFAULT_ROUTER_CONFIG: DEXRouterConfig = {
  maxConcurrentQueries: 5,
  quoteTimeoutMs: 10_000,
  adapterPriority: {
    [SupportedChainId.ETHEREUM]: ['0x', 'uniswap'],
    [SupportedChainId.POLYGON]: ['0x', 'uniswap'],
    [SupportedChainId.BSC]: ['0x', 'uniswap'],
    [SupportedChainId.ARBITRUM]: ['0x', 'uniswap'],
    [SupportedChainId.BASE]: ['0x', 'uniswap'],
    [SupportedChainId.OPTIMISM]: ['0x', 'uniswap'],
  },
};

// ---------------------------------------------------------------------------
// DEX Router
// ---------------------------------------------------------------------------

export class DEXRouter {
  private adapters = new Map<string, DEXAdapter>();
  private pipeline: TxPipeline;
  private config: DEXRouterConfig;

  constructor(pipeline: TxPipeline, config?: Partial<DEXRouterConfig>) {
    this.pipeline = pipeline;
    this.config = { ...DEFAULT_ROUTER_CONFIG, ...config };
  }

  /**
   * Register a DEX adapter.
   */
  registerAdapter(adapter: DEXAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  /**
   * Get a registered adapter by name.
   */
  getAdapter(name: string): DEXAdapter | undefined {
    return this.adapters.get(name);
  }

  /**
   * Get all adapters that support a given chain.
   */
  getAdaptersForChain(chainId: SupportedChainId): DEXAdapter[] {
    return Array.from(this.adapters.values()).filter((a) =>
      a.supportedChains.includes(chainId),
    );
  }

  /**
   * Get quotes from all adapters that support the pair, return the best one.
   * Queries in parallel with timeout.
   */
  async getBestQuote(params: DEXAdapterParams): Promise<{
    quote: SwapQuote;
    adapter: DEXAdapter;
  }> {
    const adapters = this.getAdaptersForChain(params.chainId);
    if (adapters.length === 0) {
      throw new Error(`No DEX adapters registered for chain ${params.chainId}`);
    }

    // Query all adapters in parallel with timeout
    const results = await Promise.allSettled(
      adapters.map(async (adapter) => {
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Quote timeout')), this.config.quoteTimeoutMs),
        );
        const quotePromise = adapter.getQuote(params);
        const quote = await Promise.race([quotePromise, timeoutPromise]);
        return { adapter, quote };
      }),
    );

    // Filter successful results
    const successful = results
      .filter((r): r is PromiseFulfilledResult<{ adapter: DEXAdapter; quote: SwapQuote }> =>
        r.status === 'fulfilled',
      )
      .map((r) => r.value);

    if (successful.length === 0) {
      const errors = results
        .filter((r) => r.status === 'rejected')
        .map((r) => (r as PromiseRejectedResult).reason?.message ?? 'Unknown error');
      throw new Error(
        `All ${adapters.length} adapters failed: ${errors.join('; ')}`,
      );
    }

    // Select best quote by output amount
    successful.sort((a, b) => {
      const amountA = BigInt(a.quote.amountOut) || 0n;
      const amountB = BigInt(b.quote.amountOut) || 0n;
      return amountB > amountA ? 1 : amountB < amountA ? -1 : 0;
    });

    return successful[0]!;
  }

  /**
   * Execute a swap using the best available adapter.
   * Delegates to TxPipeline for the actual execution.
   */
  async executeSwap(
    params: SwapParams,
    preferredAdapter?: string,
  ): Promise<PipelineResult> {
    let adapter: DEXAdapter;

    if (preferredAdapter) {
      const found = this.adapters.get(preferredAdapter);
      if (!found) {
        throw new Error(`Preferred adapter "${preferredAdapter}" not registered`);
      }
      if (!found.supportedChains.includes(params.chainId)) {
        throw new Error(
          `Adapter "${preferredAdapter}" does not support chain ${params.chainId}`,
        );
      }
      adapter = found;
    } else {
      // Auto-select best adapter
      const adapters = this.getAdaptersForChain(params.chainId);
      if (adapters.length === 0) {
        throw new Error(`No DEX adapters registered for chain ${params.chainId}`);
      }

      // Use priority order from config, fallback to first available
      const priority = this.config.adapterPriority[params.chainId] ?? [];
      let selected: DEXAdapter | undefined;

      for (const name of priority) {
        const found = adapters.find((a) => a.name === name);
        if (found) {
          selected = found;
          break;
        }
      }

      adapter = selected ?? adapters[0]!;
    }

    // Execute through pipeline
    return this.pipeline.executeSwap(params, adapter);
  }

  /**
   * Execute a swap using chain-network string pattern.
   * Example: "ethereum-polygon" → parse to chainId, then execute.
   */
  async executeUnifiedSwap(
    chainNetwork: string,
    walletAddress: string,
    tokenIn: Address,
    tokenOut: Address,
    amountIn: string,
    slippagePct?: number,
    adapterName?: string,
  ): Promise<PipelineResult> {
    const chainId = parseChainNetwork(chainNetwork);

    return this.executeSwap(
      {
        chainId,
        tokenIn,
        tokenOut,
        amountIn,
        slippageTolerance: slippagePct,
        recipient: getAddress(walletAddress),
      },
      adapterName,
    );
  }

  /**
   * Get the number of registered adapters.
   */
  get adapterCount(): number {
    return this.adapters.size;
  }

  /**
   * List all registered adapter names.
   */
  get registeredAdapters(): string[] {
    return Array.from(this.adapters.keys());
  }
}
