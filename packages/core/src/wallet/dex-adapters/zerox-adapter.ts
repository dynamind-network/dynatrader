/**
 * 0x DEX Aggregator Adapter — Permit2 Upgrade
 *
 * Uses the 0x API REST endpoint for cross-chain DEX aggregation.
 * Upgraded to Permit2 allowance-holder endpoints (0x v2) with fee capture.
 * Falls back to v1 if Permit2 fails.
 */

import {
  type Address,
  type Hex,
  formatUnits,
} from 'viem';
import {
  SupportedChainId,
  type SwapQuote,
  type SwapRoute,
  type SwapPool,
  type TransactionRequest,
  type DEXAdapterParams,
  type TokenInfo,
} from '../types';
import type { DEXAdapter } from './adapter.interface';
import { getChainConfig } from '../chain-registry';

// ---------------------------------------------------------------------------
// 0x API Configuration
// ---------------------------------------------------------------------------

const ZERO_X_API_BASE = 'https://api.0x.org';

// 0x chain ID mapping (differs from EVM chain IDs)
const ZERO_X_CHAIN_IDS: Record<SupportedChainId, number> = {
  [SupportedChainId.ETHEREUM]: 1,
  [SupportedChainId.POLYGON]: 137,
  [SupportedChainId.BSC]: 56,
  [SupportedChainId.ARBITRUM]: 42161,
  [SupportedChainId.BASE]: 8453,
  [SupportedChainId.OPTIMISM]: 10,
};

// ---------------------------------------------------------------------------
// 0x API Response Types (Permit2)
// ---------------------------------------------------------------------------

interface ZeroXPermit2QuoteResponse {
  chainId: number;
  price: string;
  guaranteedPrice: string;
  to: string;
  data: string;
  value: string;
  gas: string;
  estimatedGas: string;
  gasPrice: string;
  protocolFee: string;
  minimumProtocolFee: string;
  buyTokenAddress: string;
  sellTokenAddress: string;
  buyAmount: string;
  sellAmount: string;
  sources: Array<{
    name: string;
    proportion: string;
  }>;
  allowanceTarget: string;
  sellTokenToEthRate: string;
  buyTokenToEthRate: string;
  issues?: {
    allowance?: {
      actual: string;
      spender: string;
    };
    balance?: {
      actual: string;
      required: string;
    };
  };
  permit2?: {
    hash: string;
    expiry: string;
  };
}

// Legacy v1 response (fallback)
interface ZeroXV1QuoteResponse {
  chainId: number;
  price: string;
  guaranteedPrice: string;
  to: string;
  data: string;
  value: string;
  gas: string;
  estimatedGas: string;
  gasPrice: string;
  protocolFee: string;
  minimumProtocolFee: string;
  buyTokenAddress: string;
  sellTokenAddress: string;
  buyAmount: string;
  sellAmount: string;
  sources: Array<{
    name: string;
    proportion: string;
    subQuotes?: Array<{
      tokenAddress: string;
      dex: string;
      ratio: string;
    }>;
  }>;
  allowanceTarget: string;
  sellTokenToEthRate: string;
  buyTokenToEthRate: string;
  slippagePercentage: string;
  displayPriceRatios: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 0x Adapter (Permit2)
// ---------------------------------------------------------------------------

export class ZeroXAdapter implements DEXAdapter {
  readonly name = '0x';
  readonly supportedChains: SupportedChainId[] = [
    SupportedChainId.ETHEREUM,
    SupportedChainId.POLYGON,
    SupportedChainId.BSC,
    SupportedChainId.ARBITRUM,
    SupportedChainId.BASE,
    SupportedChainId.OPTIMISM,
  ];

  private apiKey?: string;
  /** Address to receive trade surplus (fee capture) */
  private tradeSurplusRecipient?: string;
  /** Affiliate address for referral fees */
  private affiliateAddress?: string;

  constructor(
    apiKey?: string,
    options?: { tradeSurplusRecipient?: string; affiliateAddress?: string },
  ) {
    this.apiKey = apiKey ?? process.env['ZERO_X_API_KEY'];
    this.tradeSurplusRecipient = options?.tradeSurplusRecipient;
    this.affiliateAddress = options?.affiliateAddress;
  }

  /**
   * Get a price quote from the 0x API.
   * Tries Permit2 endpoint first, falls back to v1.
   */
  async getQuote(params: DEXAdapterParams): Promise<SwapQuote> {
    const tokenIn = this.getTokenInfoFallback(params.chainId, params.tokenIn);
    const tokenOut = this.getTokenInfoFallback(params.chainId, params.tokenOut);

    const zeroXChainId = ZERO_X_CHAIN_IDS[params.chainId];
    if (!zeroXChainId) {
      throw new Error(`Chain ${params.chainId} not supported by 0x API`);
    }

    // Try Permit2 endpoint first (0x v2)
    try {
      return await this.getPermit2Quote(params, tokenIn, tokenOut, zeroXChainId);
    } catch {
      // Fall back to v1
      return await this.getV1Quote(params, tokenIn, tokenOut, zeroXChainId);
    }
  }

  /**
   * Build the calldata for a swap transaction.
   * Tries Permit2 endpoint first, falls back to v1.
   */
  async buildSwapCalldata(params: DEXAdapterParams): Promise<TransactionRequest> {
    const zeroXChainId = ZERO_X_CHAIN_IDS[params.chainId];
    if (!zeroXChainId) {
      throw new Error(`Chain ${params.chainId} not supported by 0x API`);
    }

    // Try Permit2 first
    try {
      return await this.buildPermit2Calldata(params, zeroXChainId);
    } catch {
      // Fall back to v1
      return await this.buildV1Calldata(params, zeroXChainId);
    }
  }

  /**
   * Check if this adapter supports a given token pair on a chain.
   */
  async supportsPair(
    chainId: SupportedChainId,
    _tokenIn: Address,
    _tokenOut: Address,
  ): Promise<boolean> {
    return this.supportedChains.includes(chainId);
  }

  // ---------------------------------------------------------------------------
  // Permit2 Implementation
  // ---------------------------------------------------------------------------

  private async getPermit2Quote(
    params: DEXAdapterParams,
    tokenIn: TokenInfo,
    tokenOut: TokenInfo,
    zeroXChainId: number,
  ): Promise<SwapQuote> {
    const queryParams = new URLSearchParams({
      chainId: String(zeroXChainId),
      sellToken: params.tokenIn,
      buyToken: params.tokenOut,
      sellAmount: params.amountIn,
      slippagePercentage: String((params.slippageTolerance ?? 0.5) / 100),
    });

    // Add fee capture params
    if (this.tradeSurplusRecipient) {
      queryParams.set('tradeSurplusRecipient', this.tradeSurplusRecipient);
    }
    if (this.affiliateAddress) {
      queryParams.set('affiliateAddress', this.affiliateAddress);
    }

    const url = `${ZERO_X_API_BASE}/swap/allowance-holder/quote?${queryParams.toString()}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      '0x-version': 'v2',
    };
    if (this.apiKey) {
      headers['0x-api-key'] = this.apiKey;
    }

    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`0x Permit2 API error (${response.status})`);
    }

    const data = (await response.json()) as ZeroXPermit2QuoteResponse;

    const pools: SwapPool[] = data.sources
      .filter((s) => parseFloat(s.proportion) > 0)
      .map(() => ({
        address: '0x0000000000000000000000000000000000000000' as Address,
        type: 'uniswap_v3' as const,
      }));

    const swapRoute: SwapRoute = {
      path: [params.tokenIn, params.tokenOut],
      pools,
      hops: pools.length,
      estimatedGas: data.estimatedGas,
    };

    const buyAmount = BigInt(data.buyAmount);

    return {
      chainId: params.chainId,
      tokenIn,
      tokenOut,
      amountIn: params.amountIn,
      amountOut: formatUnits(buyAmount, tokenOut.decimals),
      priceImpact: 0,
      route: swapRoute,
      gasEstimate: data.estimatedGas,
      gasPrice: data.gasPrice,
      source: '0x/permit2',
      timestamp: new Date(),
    };
  }

  private async buildPermit2Calldata(
    params: DEXAdapterParams,
    zeroXChainId: number,
  ): Promise<TransactionRequest> {
    const queryParams = new URLSearchParams({
      chainId: String(zeroXChainId),
      sellToken: params.tokenIn,
      buyToken: params.tokenOut,
      sellAmount: params.amountIn,
      slippagePercentage: String((params.slippageTolerance ?? 0.5) / 100),
    });

    if (params.recipient) {
      queryParams.set('takerAddress', params.recipient);
    }
    if (this.tradeSurplusRecipient) {
      queryParams.set('tradeSurplusRecipient', this.tradeSurplusRecipient);
    }
    if (this.affiliateAddress) {
      queryParams.set('affiliateAddress', this.affiliateAddress);
    }

    const url = `${ZERO_X_API_BASE}/swap/allowance-holder/quote?${queryParams.toString()}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      '0x-version': 'v2',
    };
    if (this.apiKey) {
      headers['0x-api-key'] = this.apiKey;
    }

    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`0x Permit2 API error (${response.status})`);
    }

    const data = (await response.json()) as ZeroXPermit2QuoteResponse;

    return {
      chainId: params.chainId,
      to: data.to as Address,
      data: data.data as Hex,
      value: data.value !== '0' ? (data.value as Hex) : undefined,
      gasLimit: data.estimatedGas
        ? (`0x${BigInt(data.estimatedGas).toString(16)}` as Hex)
        : undefined,
      gasPrice: data.gasPrice
        ? (`0x${BigInt(data.gasPrice).toString(16)}` as Hex)
        : undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // V1 Fallback Implementation
  // ---------------------------------------------------------------------------

  private async getV1Quote(
    params: DEXAdapterParams,
    tokenIn: TokenInfo,
    tokenOut: TokenInfo,
    zeroXChainId: number,
  ): Promise<SwapQuote> {
    const queryParams = new URLSearchParams({
      chainId: String(zeroXChainId),
      sellToken: params.tokenIn,
      buyToken: params.tokenOut,
      sellAmount: params.amountIn,
      slippagePercentage: String((params.slippageTolerance ?? 0.5) / 100),
    });

    const url = `${ZERO_X_API_BASE}/swap/v1/quote?${queryParams.toString()}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['0x-api-key'] = this.apiKey;
    }

    const response = await fetch(url, { headers });
    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`0x API error (${response.status}): ${errorBody}`);
    }

    const data = (await response.json()) as ZeroXV1QuoteResponse;

    const pools: SwapPool[] = data.sources
      .filter((s) => parseFloat(s.proportion) > 0)
      .map(() => ({
        address: '0x0000000000000000000000000000000000000000' as Address,
        type: 'uniswap_v3' as const,
      }));

    const swapRoute: SwapRoute = {
      path: [params.tokenIn, params.tokenOut],
      pools,
      hops: pools.length,
      estimatedGas: data.estimatedGas,
    };

    const buyAmount = BigInt(data.buyAmount);

    return {
      chainId: params.chainId,
      tokenIn,
      tokenOut,
      amountIn: params.amountIn,
      amountOut: formatUnits(buyAmount, tokenOut.decimals),
      priceImpact: 0,
      route: swapRoute,
      gasEstimate: data.estimatedGas,
      gasPrice: data.gasPrice,
      source: '0x/v1',
      timestamp: new Date(),
    };
  }

  private async buildV1Calldata(
    params: DEXAdapterParams,
    zeroXChainId: number,
  ): Promise<TransactionRequest> {
    const queryParams = new URLSearchParams({
      chainId: String(zeroXChainId),
      sellToken: params.tokenIn,
      buyToken: params.tokenOut,
      sellAmount: params.amountIn,
      slippagePercentage: String((params.slippageTolerance ?? 0.5) / 100),
    });

    if (params.recipient) {
      queryParams.set('takerAddress', params.recipient);
    }

    const url = `${ZERO_X_API_BASE}/swap/v1/quote?${queryParams.toString()}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['0x-api-key'] = this.apiKey;
    }

    const response = await fetch(url, { headers });
    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`0x API error (${response.status}): ${errorBody}`);
    }

    const data = (await response.json()) as ZeroXV1QuoteResponse;

    return {
      chainId: params.chainId,
      to: data.to as Address,
      data: data.data as Hex,
      value: data.value !== '0' ? (data.value as Hex) : undefined,
      gasLimit: data.estimatedGas
        ? (`0x${BigInt(data.estimatedGas).toString(16)}` as Hex)
        : undefined,
      gasPrice: data.gasPrice
        ? (`0x${BigInt(data.gasPrice).toString(16)}` as Hex)
        : undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private getTokenInfoFallback(
    chainId: SupportedChainId,
    tokenAddress: Address,
  ): TokenInfo {
    const config = getChainConfig(chainId);
    const wethAddress = this.getWrappedNativeAddress(chainId);

    if (tokenAddress.toLowerCase() === wethAddress?.toLowerCase()) {
      return {
        address: tokenAddress,
        symbol: `W${config.nativeCurrency.symbol}`,
        name: `Wrapped ${config.nativeCurrency.name}`,
        decimals: config.nativeCurrency.decimals,
        chainId,
      };
    }

    return {
      address: tokenAddress,
      symbol: 'UNKNOWN',
      name: 'Unknown Token',
      decimals: 18,
      chainId,
    };
  }

  private getWrappedNativeAddress(chainId: SupportedChainId): Address | null {
    const addresses: Record<SupportedChainId, Address> = {
      [SupportedChainId.ETHEREUM]: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      [SupportedChainId.POLYGON]: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
      [SupportedChainId.BSC]: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
      [SupportedChainId.ARBITRUM]: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
      [SupportedChainId.BASE]: '0x4200000000000000000000000000000000000006',
      [SupportedChainId.OPTIMISM]: '0x4200000000000000000000000000000000000006',
    };
    return addresses[chainId] ?? null;
  }
}
