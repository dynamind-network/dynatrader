import { ethers } from 'ethers';
import { ChainManager } from './chain-manager.js';
import type { WalletBalance, Portfolio, WalletInfo } from '../types/wallet.js';
import { getChainConfig, formatAddress, isValidAddress } from '../utils/chains.js';

export class WalletService {
  private chainManager: ChainManager;
  private privateKey: string;
  private mainAddress: string;
  private evmWallets: Map<string, ethers.Wallet> = new Map();
  private initialized: boolean = false;

  constructor(chainManager: ChainManager) {
    this.chainManager = chainManager;
    this.privateKey = '';
    this.mainAddress = '';
  }

  initialize(privateKey: string, mainAddress: string) {
    if (!privateKey || !mainAddress) {
      throw new Error('PRIVATE_KEY and MAIN_ADDRESS must be provided');
    }

    // Ensure private key has 0x prefix
    this.privateKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    this.mainAddress = mainAddress.toLowerCase();
    this.initializeWallets();
    this.initialized = true;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  private initializeWallets() {
    const evmChains = ['ethereum', 'polygon', 'base', 'arbitrum', 'optimism'];

    for (const chainName of evmChains) {
      const provider = this.chainManager.getEvmProvider(chainName);
      if (provider) {
        try {
          const wallet = new ethers.Wallet(this.privateKey, provider);
          this.evmWallets.set(chainName, wallet);
        } catch (error) {
          console.error(`Failed to initialize wallet for ${chainName}:`, error);
        }
      }
    }
  }

  getMainAddress(): string {
    return this.mainAddress;
  }

  getFormattedAddress(): string {
    return formatAddress(this.mainAddress);
  }

  getEvmWallet(chainName: string): ethers.Wallet | undefined {
    return this.evmWallets.get(chainName.toLowerCase());
  }

  async getPortfolio(): Promise<Portfolio> {
    if (!this.initialized) {
      return {
        totalValueUsd: 0,
        balances: [],
        lastUpdated: new Date(),
        chains: [],
      };
    }

    const balances: WalletBalance[] = [];
    const chains = this.chainManager.getSupportedChains();
    let totalValueUsd = 0;

    for (const chainName of chains) {
      try {
        const nativeBalance = await this.getBalance(chainName, this.mainAddress);
        if (nativeBalance) {
          balances.push(nativeBalance);
          if (nativeBalance.valueUsd) {
            totalValueUsd += nativeBalance.valueUsd;
          }
        }

        try {
          const tokenBalances = await this.getEvmTokenBalances(chainName, this.mainAddress);
          for (const tokenBalance of tokenBalances) {
            if (parseFloat(tokenBalance.balance) > 0) {
              balances.push(tokenBalance);
              if (tokenBalance.valueUsd) {
                totalValueUsd += tokenBalance.valueUsd;
              }
            }
          }
        } catch (tokenError) {
          // Silently skip token balance errors
        }
      } catch (error) {
        // Silently skip chain balance errors
      }
    }

    return {
      totalValueUsd,
      balances,
      lastUpdated: new Date(),
      chains,
    };
  }

  async getBalance(
    chainName: string,
    address: string = this.mainAddress
  ): Promise<WalletBalance | null> {
    if (!isValidAddress(address)) {
      throw new Error(`Invalid address ${address} for chain ${chainName}`);
    }

    const config = getChainConfig(chainName);
    if (!config) {
      throw new Error(`Chain ${chainName} not supported`);
    }

    try {
      const rawBalance = await this.chainManager.getBalance(chainName, address);
      const balance = ethers.formatUnits(rawBalance, config.nativeCurrency.decimals);

      const walletBalance: WalletBalance = {
        address: address.toLowerCase(),
        chain: chainName,
        token: 'native',
        symbol: config.nativeCurrency.symbol,
        balance,
        decimals: config.nativeCurrency.decimals,
        valueUsd: 0,
        priceUsd: 0,
      };

      return walletBalance;
    } catch (error) {
      console.error(`Failed to get balance for ${address} on ${chainName}:`, error);
      return null;
    }
  }

  async getWalletInfo(): Promise<WalletInfo> {
    const portfolio = await this.getPortfolio();
    const transactionCount = await this.getTotalTransactionCount();

    return {
      address: this.mainAddress,
      chains: portfolio.chains,
      totalValueUsd: portfolio.totalValueUsd,
      transactions: transactionCount,
    };
  }

  private async getEvmTokenBalances(chainName: string, address: string): Promise<WalletBalance[]> {
    const wallet = this.getEvmWallet(chainName);
    if (!wallet) {
      return [];
    }

    const tokenContracts: Record<
      string,
      Array<{ symbol: string; address: string; decimals: number }>
    > = {
      arbitrum: [
        { symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
        { symbol: 'USDT', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
        { symbol: 'WETH', address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18 },
      ],
      ethereum: [
        { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
        { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
        { symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
      ],
      polygon: [
        { symbol: 'USDC', address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', decimals: 6 },
        { symbol: 'USDT', address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6 },
        { symbol: 'WMATIC', address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', decimals: 18 },
      ],
      base: [
        { symbol: 'USDC', address: '0xd9aAEc86CE65be6B6f312d46Ae46F4e45346e8Bf', decimals: 6 },
        { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
      ],
      optimism: [
        { symbol: 'USDC', address: '0x0b2C639c533813f4Aa9D7837CAf62653E096aE50', decimals: 6 },
        { symbol: 'USDT', address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6 },
        { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
      ],
    };

    const chainTokens = tokenContracts[chainName];
    if (!chainTokens) {
      return [];
    }

    const balances: WalletBalance[] = [];
    const erc20Abi = [
      'function balanceOf(address) view returns (uint256)',
      'function decimals() view returns (uint8)',
      'function symbol() view returns (string)',
    ];

    for (const token of chainTokens) {
      try {
        const contract = new ethers.Contract(token.address, erc20Abi, wallet.provider);
        const balance = await contract.balanceOf(address);
        const balanceFormatted = ethers.formatUnits(balance, token.decimals);

        if (parseFloat(balanceFormatted) > 0) {
          balances.push({
            address: address.toLowerCase(),
            chain: chainName,
            token: token.address,
            symbol: token.symbol,
            balance: balanceFormatted,
            decimals: token.decimals,
            valueUsd: 0,
            priceUsd: 0,
          });
        }
      } catch (error) {
        // Skip failed token balance fetches
      }
    }

    return balances;
  }

  private async getTotalTransactionCount(): Promise<number> {
    return 0;
  }

  async sendTransaction(
    chainName: string,
    to: string,
    value: string,
    data?: string
  ): Promise<string> {
    const wallet = this.getEvmWallet(chainName);
    if (!wallet) {
      throw new Error(`Wallet not found for chain: ${chainName}`);
    }

    try {
      const tx = await wallet.sendTransaction({
        to,
        value: ethers.parseEther(value),
        data,
      });

      return tx.hash;
    } catch (error) {
      console.error(`Failed to send transaction on ${chainName}:`, error);
      throw error;
    }
  }

  async estimateGas(chainName: string, to: string, value: string, data?: string): Promise<string> {
    const wallet = this.getEvmWallet(chainName);
    if (!wallet) {
      throw new Error(`Wallet not found for chain: ${chainName}`);
    }

    try {
      const provider = wallet.provider;
      if (!provider) {
        throw new Error('Provider not available for wallet');
      }

      const gasEstimate = await provider.estimateGas({
        from: wallet.address,
        to,
        value: ethers.parseEther(value),
        data,
      });

      const gasPrice = await provider.getFeeData();
      const gasCost = gasEstimate * (gasPrice.gasPrice || 0n);

      return ethers.formatEther(gasCost);
    } catch (error) {
      console.error(`Failed to estimate gas for transaction on ${chainName}:`, error);
      throw error;
    }
  }

  async getNonce(chainName: string): Promise<number> {
    const wallet = this.getEvmWallet(chainName);
    if (!wallet) {
      throw new Error(`Wallet not found for chain: ${chainName}`);
    }

    try {
      return await wallet.getNonce();
    } catch (error) {
      console.error(`Failed to get nonce for ${chainName}:`, error);
      throw error;
    }
  }

  /**
   * Clear sensitive data from memory to prevent exposure in heap dumps or core dumps.
   * Call this when the service is no longer needed or during shutdown.
   */
  clearSensitiveData(): void {
    if (this.privateKey) {
      const length = this.privateKey.length;
      this.privateKey = '\0'.repeat(length);
      this.privateKey = '';
    }

    this.evmWallets.clear();

    if (this.mainAddress) {
      this.mainAddress = '';
    }

    this.initialized = false;
  }
}

