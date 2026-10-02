/**
 * DynaMind API — DeFi Provider
 *
 * Wraps the DynaMind Data API's DeFi endpoints as a DeFiProvider.
 * Provides: chain rankings, protocol data, DEX pools.
 */

import type {
  DeFiProvider,
  DeFiChain as Chain,
  DeFiProtocol as Protocol,
  DeFiPool as Pool,
} from "@dyna/core";
import { requestDynaMindApi } from "./http.js";

export interface DynaMindDeFiConfig {
  baseUrl: string;
  apiKey?: string;
}
export function createDeFiProvider(config: DynaMindDeFiConfig): DeFiProvider {
  async function request<T>(path: string): Promise<T> {
    return requestDynaMindApi<T>(config, path, { timeoutMs: 10_000 });
  }

  return {
    async getChains(): Promise<Chain[]> {
      const data = await request<{
        chains: Array<{
          id: number;
          name: string;
          tvl: number;
          change_24h: number;
        }>;
      }>("/api/v1/defi/chains");

      return data.chains.map((c) => ({
        id: c.id,
        name: c.name,
        tvl: c.tvl,
        change24h: c.change_24h,
      }));
    },

    async getProtocols(): Promise<Protocol[]> {
      const data = await request<{
        protocols: Array<{
          name: string;
          slug: string;
          chain: string;
          tvl: number;
          change_24h: number;
          category: string;
        }>;
      }>("/api/v1/defi/protocols");

      return data.protocols.map((p) => ({
        name: p.name,
        slug: p.slug,
        chain: p.chain,
        tvl: p.tvl,
        change24h: p.change_24h,
        category: p.category,
      }));
    },

    async getPools(chainId?: number): Promise<Pool[]> {
      const params = chainId ? `?chain_id=${chainId}` : "";
      const data = await request<{
        pools: Array<{
          address: string;
          chain: string;
          token0: string;
          token1: string;
          tvl: number;
          volume_24h: number;
        }>;
      }>(`/api/v1/dex/pools${params}`);

      return data.pools.map((p) => ({
        address: p.address,
        chain: p.chain,
        token0: p.token0,
        token1: p.token1,
        tvl: p.tvl,
        volume24h: p.volume_24h,
      }));
    },
  };
}
