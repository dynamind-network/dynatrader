/**
 * Wallet & DEX Type Definitions
 *
 * Core types for EVM wallet management, DEX trading, and on-chain operations.
 * All components must adhere to these contracts for type safety.
 *
 * Includes Zod schemas for runtime validation.
 */

import { z } from 'zod';
import type { Hex, Address, TransactionRequest as ViemTransactionRequest } from 'viem';

// ---------------------------------------------------------------------------
// Supported Chains
// ---------------------------------------------------------------------------

export enum SupportedChainId {
  ETHEREUM = 1,
  POLYGON = 137,
  BSC = 56,
  ARBITRUM = 42161,
  BASE = 8453,
  OPTIMISM = 10,
}

export const SUPPORTED_CHAIN_IDS = Object.values(SupportedChainId).filter(
  (v): v is SupportedChainId => typeof v === 'number',
);

// ---------------------------------------------------------------------------
// Chain Configuration
// ---------------------------------------------------------------------------

export interface NativeCurrency {
  name: string;
  symbol: string;
  decimals: number;
}

export interface ChainConfig {
  chainId: SupportedChainId;
  name: string;
  rpcUrl: string;
  nativeCurrency: NativeCurrency;
  blockExplorerUrl: string;
  blockExplorerApiUrl: string;
  contracts: {
    multicall3?: Address;
    universalRouter?: Address;
    swapRouter?: Address;
    swapRouter02?: Address;
  };
}

// ---------------------------------------------------------------------------
// Wallet Configuration
// ---------------------------------------------------------------------------

export interface WalletConfig {
  /** Environment variable name for private key (never store raw keys) */
  privateKeyEnvVar: string;
  /** Chains to initialize wallets for */
  chains: SupportedChainId[];
  /** Encryption master key for key-at-rest encryption */
  encryptionKey?: string;
}

export interface WalletInfo {
  address: Address;
  chainId: SupportedChainId;
  chainName: string;
}

// ---------------------------------------------------------------------------
// Token Information
// ---------------------------------------------------------------------------

export interface TokenInfo {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  chainId: SupportedChainId;
  logoUri?: string;
}

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

export interface WalletBalance {
  chainId: SupportedChainId;
  chainName: string;
  address: Address;
  nativeBalance: string;
  nativeBalanceFormatted: string;
  tokenBalances: TokenBalance[];
}

export interface TokenBalance {
  token: TokenInfo;
  balance: string;
  balanceFormatted: string;
}

// ---------------------------------------------------------------------------
// DEX Swap Types
// ---------------------------------------------------------------------------

export interface SwapParams {
  chainId: SupportedChainId;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: string;
  slippageTolerance?: number;
  deadlineMinutes?: number;
  recipient?: Address;
}

export interface SwapQuote {
  chainId: SupportedChainId;
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  amountIn: string;
  amountOut: string;
  priceImpact: number;
  route: SwapRoute;
  gasEstimate?: string;
  gasPrice?: string;
  source: string;
  timestamp: Date;
}

export interface SwapRoute {
  path: Address[];
  pools: SwapPool[];
  hops: number;
  estimatedGas?: string;
}

export interface SwapPool {
  address: Address;
  fee?: number;
  type: 'uniswap_v2' | 'uniswap_v3' | 'curve' | 'balancer';
}

// ---------------------------------------------------------------------------
// Transaction Types
// ---------------------------------------------------------------------------

export interface TransactionRequest {
  chainId: SupportedChainId;
  to: Address;
  data: Hex;
  value?: Hex;
  gasLimit?: Hex;
  gasPrice?: Hex;
  maxFeePerGas?: Hex;
  maxPriorityFeePerGas?: Hex;
  nonce?: number;
}

export interface TransactionResult {
  txHash: Hex;
  chainId: SupportedChainId;
  status: 'pending' | 'confirmed' | 'reverted' | 'failed';
  blockNumber?: bigint;
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
  logs?: TransactionLog[];
  error?: string;
}

export interface TransactionLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
  txHash: Hex;
  logIndex: number;
}

// ---------------------------------------------------------------------------
// Approval Types
// ---------------------------------------------------------------------------

export interface ApprovalRequest {
  token: Address;
  spender: Address;
  amount: string;
  chainId: SupportedChainId;
}

export interface ApprovalResult {
  txHash: Hex;
  chainId: SupportedChainId;
  token: Address;
  spender: Address;
  amount: string;
}

export interface ApprovalInfo {
  token: Address;
  spender: Address;
  allowance: string;
  chainId: SupportedChainId;
}

// ---------------------------------------------------------------------------
// DEX Adapter Interface
// ---------------------------------------------------------------------------

export interface DEXAdapterParams {
  chainId: SupportedChainId;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: string;
  slippageTolerance?: number;
  deadlineMinutes?: number;
  recipient?: Address;
}

export interface DEXAdapter {
  readonly name: string;
  readonly supportedChains: SupportedChainId[];
  getQuote(params: DEXAdapterParams): Promise<SwapQuote>;
  buildSwapCalldata(params: DEXAdapterParams): Promise<TransactionRequest>;
}

// ---------------------------------------------------------------------------
// Wallet Capabilities
// ---------------------------------------------------------------------------

export interface WalletCapabilities {
  supportedChains: SupportedChainId[];
  maxConcurrentTransactions: number;
  supportsEIP1559: boolean;
  supportsEIP2612: boolean;
  supportsFlashbots: boolean;
}

// ---------------------------------------------------------------------------
// Pipeline Stage Types
// ---------------------------------------------------------------------------

export type PipelineStage =
  | 'validate'
  | 'simulate'
  | 'approve'
  | 'sign'
  | 'broadcast'
  | 'confirm'
  | 'gas_wait'
  | 'policy';

export interface PipelineStageResult {
  stage: PipelineStage;
  success: boolean;
  data?: unknown;
  error?: string;
  durationMs: number;
}

export interface PipelineResult {
  txHash?: Hex;
  chainId: SupportedChainId;
  stages: PipelineStageResult[];
  success: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Zod Schemas (Runtime Validation)
// ---------------------------------------------------------------------------

/** Discriminated union for transaction request types */
export const DexSwapRequestSchema = z.object({
  type: z.literal('dex_swap'),
  chainId: z.nativeEnum(SupportedChainId),
  tokenIn: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  tokenOut: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  amountIn: z.string(),
  slippageTolerance: z.number().min(0).max(100).optional(),
  deadlineMinutes: z.number().positive().optional(),
  recipient: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
});

export const ERC20TransferRequestSchema = z.object({
  type: z.literal('erc20_transfer'),
  chainId: z.nativeEnum(SupportedChainId),
  token: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  to: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  amount: z.string(),
});

export const ContractCallRequestSchema = z.object({
  type: z.literal('contract_call'),
  chainId: z.nativeEnum(SupportedChainId),
  to: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  data: z.string().regex(/^0x[a-fA-F0-9]*$/),
  value: z.string().optional(),
});

export const ApproveRequestSchema = z.object({
  type: z.literal('approve'),
  chainId: z.nativeEnum(SupportedChainId),
  token: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  spender: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  amount: z.string().optional(),
});

export const BatchRequestSchema = z.object({
  type: z.literal('batch'),
  chainId: z.nativeEnum(SupportedChainId),
  transactions: z.array(z.object({
    to: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    data: z.string().regex(/^0x[a-fA-F0-9]*$/),
    value: z.string().optional(),
  })).min(1),
});

/** 5-type discriminated union for all transaction request variants */
export const TransactionRequestSchema = z.discriminatedUnion('type', [
  DexSwapRequestSchema,
  ERC20TransferRequestSchema,
  ContractCallRequestSchema,
  ApproveRequestSchema,
  BatchRequestSchema,
]);

export type TransactionRequestType = z.infer<typeof TransactionRequestSchema>;

/** Discriminated union for transaction result status */
export const TransactionResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('pending'),
    txHash: z.string(),
    chainId: z.nativeEnum(SupportedChainId),
  }),
  z.object({
    status: z.literal('confirmed'),
    txHash: z.string(),
    chainId: z.nativeEnum(SupportedChainId),
    blockNumber: z.bigint(),
    gasUsed: z.bigint().optional(),
    effectiveGasPrice: z.bigint().optional(),
    logs: z.array(z.any()).optional(),
  }),
  z.object({
    status: z.literal('reverted'),
    txHash: z.string(),
    chainId: z.nativeEnum(SupportedChainId),
    error: z.string().optional(),
  }),
  z.object({
    status: z.literal('failed'),
    txHash: z.string(),
    chainId: z.nativeEnum(SupportedChainId),
    error: z.string(),
  }),
]);

export type TypedTransactionResult = z.infer<typeof TransactionResultSchema>;

// ---------------------------------------------------------------------------
// Chain Error Classification (CONC-01 pattern)
// ---------------------------------------------------------------------------

export type ChainErrorCategory = 'PERMANENT' | 'TRANSIENT' | 'STALE';

export class ChainError extends Error {
  constructor(
    message: string,
    public readonly category: ChainErrorCategory,
    public readonly originalError?: Error,
  ) {
    super(message);
    this.name = 'ChainError';
  }
}

// ---------------------------------------------------------------------------
// Policy Tier (4-tier classification)
// ---------------------------------------------------------------------------

export type PolicyTier = 'INSTANT' | 'NOTIFY' | 'DELAY' | 'APPROVAL';

export interface TransactionPolicyInput {
  type: string;
  amount: string;
  chainId: SupportedChainId;
  tokenIn?: Address;
  tokenOut?: Address;
  gasEstimate?: string;
  gasPrice?: string;
  tradeValueUsd?: number;
}

export interface TransactionPolicyEvaluation {
  tier: PolicyTier;
  allowed: boolean;
  reason?: string;
  delaySeconds?: number;
  maxSlippage?: number;
  maxGasRatio?: number;
}
