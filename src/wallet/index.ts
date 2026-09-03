/**
 * Wallet Module - Barrel Exports
 *
 * EVM wallet management, DEX trading adapters, and on-chain transaction pipeline.
 */

// Types
export {
  SupportedChainId,
  SUPPORTED_CHAIN_IDS,
  type NativeCurrency,
  type ChainConfig,
  type WalletConfig,
  type WalletInfo,
  type TokenInfo,
  type WalletBalance,
  type TokenBalance,
  type SwapParams,
  type SwapQuote,
  type SwapRoute,
  type SwapPool,
  type TransactionRequest,
  type TransactionResult,
  type TransactionLog,
  type ApprovalRequest,
  type ApprovalResult,
  type ApprovalInfo,
  type DEXAdapter,
  type DEXAdapterParams,
  type WalletCapabilities,
  type PipelineStage,
  type PipelineStageResult,
  type PipelineResult,
} from './types';

// Chain Registry
export {
  getChainConfig,
  getAllChainConfigs,
  getSupportedChainIds,
  getPublicClient,
  getNativeCurrency,
  formatNativeBalance,
  parseToWei,
} from './chain-registry';

// Wallet Manager
export { WalletManager } from './wallet-manager';

// Approval Manager
export { ApprovalManager } from './approval-manager';

// Transaction Pipeline
export { TxPipeline } from './tx-pipeline';
export type { TxPipelineConfig } from './tx-pipeline';

// DEX Adapters
export type { DEXAdapter as DEXAdapterInterface } from './dex-adapters/adapter.interface';
export { UniswapAdapter } from './dex-adapters/uniswap-adapter';
export { ZeroXAdapter } from './dex-adapters/zerox-adapter';
