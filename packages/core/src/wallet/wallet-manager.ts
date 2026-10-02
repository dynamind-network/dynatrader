/**
 * Wallet Manager
 *
 * Core EVM wallet management using viem.
 * Handles private key loading, encryption at rest, wallet client creation,
 * balance queries, and transaction sending across multiple chains.
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  type WalletClient,
  type PublicClient,
  type Hex,
  type Address,
  type TransactionReceipt,
  type Chain,
  formatEther,
  formatUnits,
  parseUnits,
  getContract,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  mainnet,
  polygon,
  bsc,
  arbitrum,
  base,
  optimism,
} from 'viem/chains';

import {
  SupportedChainId,
  type WalletConfig,
  type WalletInfo,
  type WalletBalance,
  type TokenBalance,
  type TokenInfo,
  type TransactionResult,
  type TransactionLog,
} from './types';
import { getChainConfig, getPublicClient, formatNativeBalance } from './chain-registry';
import { EncryptionService } from '../monitoring/security/encryption';

// ---------------------------------------------------------------------------
// ERC20 ABI (minimal)
// ---------------------------------------------------------------------------

const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'name',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const;

// ---------------------------------------------------------------------------
// Viem Chain Mapping
// ---------------------------------------------------------------------------

// Viem Chain Mapping (cast to Chain to avoid literal type mismatch)
const VIEM_CHAINS: Record<SupportedChainId, Chain> = {
  [SupportedChainId.ETHEREUM]: mainnet as Chain,
  [SupportedChainId.POLYGON]: polygon as Chain,
  [SupportedChainId.BSC]: bsc as Chain,
  [SupportedChainId.ARBITRUM]: arbitrum as Chain,
  [SupportedChainId.BASE]: base as Chain,
  [SupportedChainId.OPTIMISM]: optimism as Chain,
};

// ---------------------------------------------------------------------------
// Wallet Manager
// ---------------------------------------------------------------------------

export class WalletManager {
  private walletClients: Map<SupportedChainId, WalletClient> = new Map();
  private publicClients: Map<SupportedChainId, PublicClient> = new Map();
  private encryption: EncryptionService;
  private account: ReturnType<typeof privateKeyToAccount> | null = null;
  private config: WalletConfig;
  private encryptedKeyData: string | null = null;

  constructor(config: WalletConfig) {
    this.config = config;
    this.encryption = new EncryptionService(
      config.encryptionKey ? { masterKey: config.encryptionKey } : {},
    );
  }

  /**
   * Initialize wallet from private key environment variable.
   * Encrypts the key at rest and creates wallet clients for all configured chains.
   */
  async initialize(): Promise<void> {
    const envVarName = this.config.privateKeyEnvVar;
    const privateKey = process.env[envVarName];

    if (!privateKey) {
      throw new Error(
        `Private key not found in environment variable: ${envVarName}. ` +
        `Set ${envVarName} to your EVM private key (0x-prefixed hex).`,
      );
    }

    // Validate private key format
    if (!privateKey.startsWith('0x') || privateKey.length !== 66) {
      throw new Error(
        `Invalid private key format in ${envVarName}. Expected 0x-prefixed 64 hex characters.`,
      );
    }

    // Encrypt the private key for at-rest storage
    this.encryptedKeyData = JSON.stringify(this.encryption.encrypt(privateKey));

    // Create viem account from private key
    this.account = privateKeyToAccount(privateKey as Hex);

    // Create wallet clients for each configured chain
    for (const chainId of this.config.chains) {
      const chain = VIEM_CHAINS[chainId];
      if (!chain) {
        throw new Error(`Unsupported chain ID: ${chainId}`);
      }

      const config = getChainConfig(chainId);
      const publicClient = getPublicClient(chainId);

      this.publicClients.set(chainId, publicClient);

      const walletClient = createWalletClient({
        account: this.account,
        chain,
        transport: http(config.rpcUrl, {
          timeout: 30_000,
          retryCount: 3,
        }),
      });

      this.walletClients.set(chainId, walletClient);
    }
  }

  /**
   * Get the wallet address.
   */
  getAddress(): Address {
    if (!this.account) {
      throw new Error('Wallet not initialized. Call initialize() first.');
    }
    return this.account.address;
  }

  /**
   * Get wallet info for all configured chains.
   */
  getWalletInfo(): WalletInfo[] {
    const address = this.getAddress();
    return this.config.chains.map((chainId) => ({
      address,
      chainId,
      chainName: getChainConfig(chainId).name,
    }));
  }

  /**
   * Get native currency balance for a specific chain.
   */
  async getNativeBalance(chainId: SupportedChainId): Promise<string> {
    const publicClient = this.publicClients.get(chainId);
    if (!publicClient) {
      throw new Error(`No public client for chain ${chainId}`);
    }

    const address = this.getAddress();
    const balance = await publicClient.getBalance({ address });
    return formatNativeBalance(chainId, balance);
  }

  /**
   * Get ERC20 token balance for a specific chain.
   */
  async getTokenBalance(
    chainId: SupportedChainId,
    tokenAddress: Address,
  ): Promise<{ balance: string; decimals: number }> {
    const publicClient = this.publicClients.get(chainId);
    if (!publicClient) {
      throw new Error(`No public client for chain ${chainId}`);
    }

    const address = this.getAddress();

    const contract = getContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      client: publicClient,
    });

    const [balance, decimals] = await Promise.all([
      contract.read.balanceOf([address]),
      contract.read.decimals(),
    ]);

    return {
      balance: formatUnits(balance, decimals),
      decimals,
    };
  }

  /**
   * Get comprehensive balance across all configured chains and tokens.
   */
  async getBalances(tokens?: Array<{ chainId: SupportedChainId; address: Address }>): Promise<WalletBalance[]> {
    const address = this.getAddress();
    const balances: WalletBalance[] = [];

    for (const chainId of this.config.chains) {
      const config = getChainConfig(chainId);
      const nativeBalance = await this.getNativeBalance(chainId);
      const tokenBalances: TokenBalance[] = [];

      // Query specified tokens for this chain
      const chainTokens = tokens?.filter((t) => t.chainId === chainId) ?? [];
      for (const token of chainTokens) {
        try {
          const { balance } = await this.getTokenBalance(chainId, token.address);
          const publicClient = this.publicClients.get(chainId);
          if (!publicClient) continue;

          const contract = getContract({
            address: token.address,
            abi: ERC20_ABI,
            client: publicClient,
          });

          const [symbol, decimals] = await Promise.all([
            contract.read.symbol(),
            contract.read.decimals(),
          ]);

          tokenBalances.push({
            token: {
              address: token.address,
              symbol,
              name: symbol,
              decimals,
              chainId,
            },
            balance,
            balanceFormatted: balance,
          });
        } catch {
          // Skip tokens that fail to query
        }
      }

      balances.push({
        chainId,
        chainName: config.name,
        address,
        nativeBalance: nativeBalance,
        nativeBalanceFormatted: nativeBalance,
        tokenBalances,
      });
    }

    return balances;
  }

  /**
   * Send a native currency transfer.
   */
  async sendNativeTransfer(
    chainId: SupportedChainId,
    to: Address,
    amount: string,
  ): Promise<TransactionResult> {
    const walletClient = this.walletClients.get(chainId);
    if (!walletClient) {
      throw new Error(`No wallet client for chain ${chainId}`);
    }

    const account = this.getAccount();
    const config = getChainConfig(chainId);
    const value = parseUnits(amount, config.nativeCurrency.decimals);

    const hash = await walletClient.sendTransaction({
      to,
      value,
      chain: VIEM_CHAINS[chainId],
      account,
    });

    return this.waitForTransaction(chainId, hash);
  }

  /**
   * Send an ERC20 token transfer.
   */
  async sendTokenTransfer(
    chainId: SupportedChainId,
    tokenAddress: Address,
    to: Address,
    amount: string,
  ): Promise<TransactionResult> {
    const walletClient = this.walletClients.get(chainId);
    const publicClient = this.publicClients.get(chainId);
    if (!walletClient || !publicClient) {
      throw new Error(`No wallet/public client for chain ${chainId}`);
    }

    const account = this.getAccount();

    const contract = getContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      client: { public: publicClient, wallet: walletClient },
    });

    // Get decimals for proper formatting
    const decimals = await contract.read.decimals();
    const value = parseUnits(amount, decimals);

    const { request } = await contract.simulate.transfer([to, value]);
    const hash = await walletClient.writeContract({
      ...request,
      chain: VIEM_CHAINS[chainId],
      account,
    });

    return this.waitForTransaction(chainId, hash);
  }

  /**
   * Send a raw transaction with arbitrary calldata.
   */
  async sendTransaction(
    chainId: SupportedChainId,
    params: {
      to: Address;
      data: Hex;
      value?: bigint;
      gasLimit?: bigint;
      gasPrice?: bigint;
      maxFeePerGas?: bigint;
      maxPriorityFeePerGas?: bigint;
    },
  ): Promise<TransactionResult> {
    const walletClient = this.walletClients.get(chainId);
    if (!walletClient) {
      throw new Error(`No wallet client for chain ${chainId}`);
    }

    const account = this.getAccount();

    // Build transaction parameters, only including relevant gas fields
    const txParams: Record<string, unknown> = {
      to: params.to,
      data: params.data,
      chain: VIEM_CHAINS[chainId],
      account,
    };

    if (params.value !== undefined) txParams.value = params.value;
    if (params.gasLimit !== undefined) txParams.gas = params.gasLimit;

    // Only set one type of gas pricing
    if (params.gasPrice !== undefined) {
      txParams.gasPrice = params.gasPrice;
    } else if (params.maxFeePerGas !== undefined) {
      txParams.maxFeePerGas = params.maxFeePerGas;
      if (params.maxPriorityFeePerGas !== undefined) {
        txParams.maxPriorityFeePerGas = params.maxPriorityFeePerGas;
      }
    }

    const hash = await walletClient.sendTransaction(txParams as Parameters<typeof walletClient.sendTransaction>[0]);

    return this.waitForTransaction(chainId, hash);
  }

  /**
   * Wait for a transaction to be confirmed and return the result.
   */
  async waitForTransaction(
    chainId: SupportedChainId,
    txHash: Hex,
  ): Promise<TransactionResult> {
    const publicClient = this.publicClients.get(chainId);
    if (!publicClient) {
      throw new Error(`No public client for chain ${chainId}`);
    }

    try {
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: 120_000,
      });

      return {
        txHash,
        chainId,
        status: receipt.status === 'success' ? 'confirmed' : 'reverted',
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
        effectiveGasPrice: receipt.effectiveGasPrice,
        logs: receipt.logs.map((log) => ({
          address: log.address,
          topics: log.topics as Hex[],
          data: log.data,
          blockNumber: log.blockNumber,
          txHash: log.transactionHash,
          logIndex: log.logIndex,
        })),
      };
    } catch (error) {
      return {
        txHash,
        chainId,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get a wallet client for a specific chain.
   */
  getWalletClient(chainId: SupportedChainId): WalletClient | undefined {
    return this.walletClients.get(chainId);
  }

  /**
   * Get a public client for a specific chain.
   */
  getPublicClientForChain(chainId: SupportedChainId): PublicClient | undefined {
    return this.publicClients.get(chainId);
  }

  /**
   * Get the underlying viem Account object.
   */
  getAccount(): ReturnType<typeof privateKeyToAccount> {
    if (!this.account) {
      throw new Error('Wallet not initialized. Call initialize() first.');
    }
    return this.account;
  }

  /**
   * Get the encrypted private key data (for persistence).
   */
  getEncryptedKeyData(): string | null {
    return this.encryptedKeyData;
  }

  /**
   * Get transaction history by querying recent blocks for events.
   * Returns transactions sent from this wallet address.
   */
  async getTransactionHistory(
    chainId: SupportedChainId,
    options?: { fromBlock?: bigint; toBlock?: bigint; limit?: number },
  ): Promise<Array<{
    hash: Hex;
    blockNumber: bigint;
    to: Address | null;
    value: bigint;
    gasUsed: bigint;
    status: 'success' | 'reverted';
    timestamp: number;
  }>> {
    const publicClient = this.publicClients.get(chainId);
    if (!publicClient) {
      throw new Error(`No public client for chain ${chainId}`);
    }

    const address = this.getAddress();
    const toBlock = options?.toBlock ?? await publicClient.getBlockNumber();
    const fromBlock = options?.fromBlock ?? (toBlock - 1000n);
    const limit = options?.limit ?? 50;

    // Get logs from recent blocks
    const logs = await publicClient.getLogs({
      address: undefined,
      fromBlock,
      toBlock,
    });

    // Filter logs where our address is the sender (topic[1] is the from address in Transfer events)
    const addressTopic = `0x000000000000000000000000${address.slice(2).toLowerCase()}`;
    const txHashes = new Set<Hex>();
    for (const log of logs) {
      if (txHashes.size >= limit) break;
      // Check if our address is in the topics (Transfer event indexed from address)
      if (log.topics[1]?.toLowerCase() === addressTopic) {
        txHashes.add(log.transactionHash);
      }
    }

    const transactions: Array<{
      hash: Hex;
      blockNumber: bigint;
      to: Address | null;
      value: bigint;
      gasUsed: bigint;
      status: 'success' | 'reverted';
      timestamp: number;
    }> = [];

    for (const hash of txHashes) {
      try {
        const receipt = await publicClient.getTransactionReceipt({ hash });
        if (!receipt) continue;

        const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });

        transactions.push({
          hash: receipt.transactionHash,
          blockNumber: receipt.blockNumber,
          to: receipt.to,
          value: 0n, // Would need the original tx to get value
          gasUsed: receipt.gasUsed,
          status: receipt.status === 'success' ? 'success' : 'reverted',
          timestamp: Number(block.timestamp),
        });
      } catch {
        // Skip transactions that fail to fetch
      }
    }

    return transactions.sort((a, b) => Number(b.blockNumber - a.blockNumber));
  }
}
