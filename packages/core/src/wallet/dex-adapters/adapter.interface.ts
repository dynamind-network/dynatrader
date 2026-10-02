/**
 * DEX Adapter Interface
 *
 * Defines the contract that all DEX adapter implementations must follow.
 * Each adapter wraps a specific DEX protocol or aggregator.
 */

import type { Address } from 'viem';
import type {
  SupportedChainId,
  SwapQuote,
  TransactionRequest,
  DEXAdapterParams,
} from '../types';

export interface DEXAdapter {
  /** Human-readable adapter name */
  readonly name: string;

  /** Chain IDs this adapter supports */
  readonly supportedChains: SupportedChainId[];

  /**
   * Get a price quote for a swap without executing it.
   * Returns detailed routing and pricing information.
   */
  getQuote(params: DEXAdapterParams): Promise<SwapQuote>;

  /**
   * Build the calldata for a swap transaction.
   * Does not sign or broadcast - only constructs the transaction request.
   */
  buildSwapCalldata(params: DEXAdapterParams): Promise<TransactionRequest>;

  /**
   * Check if this adapter supports a given token pair on a chain.
   */
  supportsPair(chainId: SupportedChainId, tokenIn: Address, tokenOut: Address): Promise<boolean>;
}
