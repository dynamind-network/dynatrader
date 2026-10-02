/**
 * Uniswap V2/V3 DEX Adapter
 *
 * Uses viem to resolve token pairs, calculate quotes, and build swap calls.
 */

import {
  type Address,
  type Hex,
  formatUnits,
  parseUnits,
  getContract,
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
import { getChainConfig, getPublicClient } from '../chain-registry';

// ---------------------------------------------------------------------------
// Well-Known Token Addresses
// ---------------------------------------------------------------------------

const WETH_ADDRESSES: Record<SupportedChainId, Address> = {
  [SupportedChainId.ETHEREUM]: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  [SupportedChainId.POLYGON]: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
  [SupportedChainId.BSC]: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  [SupportedChainId.ARBITRUM]: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  [SupportedChainId.BASE]: '0x4200000000000000000000000000000000000006',
  [SupportedChainId.OPTIMISM]: '0x4200000000000000000000000000000000000006',
};

const USDC_ADDRESSES: Record<SupportedChainId, Address> = {
  [SupportedChainId.ETHEREUM]: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  [SupportedChainId.POLYGON]: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  [SupportedChainId.BSC]: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
  [SupportedChainId.ARBITRUM]: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  [SupportedChainId.BASE]: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  [SupportedChainId.OPTIMISM]: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
};

const USDT_ADDRESSES: Record<SupportedChainId, Address> = {
  [SupportedChainId.ETHEREUM]: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  [SupportedChainId.POLYGON]: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
  [SupportedChainId.BSC]: '0x55d398326f99059fF775485246999027B3197955',
  [SupportedChainId.ARBITRUM]: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
  [SupportedChainId.BASE]: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
  [SupportedChainId.OPTIMISM]: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
};

// Uniswap V2 Router addresses
const UNISWAP_V2_ROUTER: Record<SupportedChainId, Address> = {
  [SupportedChainId.ETHEREUM]: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
  [SupportedChainId.POLYGON]: '0xEdf4690956E527163fE6D37B0F6C6d75beC5F2D1',
  [SupportedChainId.BSC]: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
  [SupportedChainId.ARBITRUM]: '0x16e71B13fE6079943E2EB495BFcEdB31DB3F5c80',
  [SupportedChainId.BASE]: '0x2626664c2603336E57B271c5C0b26F421741e481',
  [SupportedChainId.OPTIMISM]: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
};

// Uniswap V3 SwapRouter02 addresses
const UNISWAP_V3_ROUTER: Record<SupportedChainId, Address> = {
  [SupportedChainId.ETHEREUM]: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  [SupportedChainId.POLYGON]: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  [SupportedChainId.BSC]: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  [SupportedChainId.ARBITRUM]: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  [SupportedChainId.BASE]: '0x2626664c2603336E57B271c5C0b26F421741e481',
  [SupportedChainId.OPTIMISM]: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
};

// Uniswap V2 Factory addresses
const UNISWAP_V2_FACTORY: Record<SupportedChainId, Address> = {
  [SupportedChainId.ETHEREUM]: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
  [SupportedChainId.POLYGON]: '0x5757371414317b86AC0e2130d363C400c16AbC5C',
  [SupportedChainId.BSC]: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
  [SupportedChainId.ARBITRUM]: '0xf6D607Ac4621dC360536C080bE6732D71eC4730F',
  [SupportedChainId.BASE]: '0x8909Dc15e40173Ff4699343b6eB8132c65f18cC0',
  [SupportedChainId.OPTIMISM]: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
};

// Uniswap V3 Factory addresses
const UNISWAP_V3_FACTORY: Record<SupportedChainId, Address> = {
  [SupportedChainId.ETHEREUM]: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  [SupportedChainId.POLYGON]: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  [SupportedChainId.BSC]: '0xdB1d100046e720A9af3cB4d119c08e4E4d41E927',
  [SupportedChainId.ARBITRUM]: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  [SupportedChainId.BASE]: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
  [SupportedChainId.OPTIMISM]: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
};

// ERC20 ABI for reading token info
const ERC20_ABI = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
] as const;

// Uniswap V2 Pair ABI
const UNISWAP_V2_PAIR_ABI = [
  { type: 'function', name: 'getReserves', stateMutability: 'view', inputs: [], outputs: [{ name: 'reserve0', type: 'uint112' }, { name: 'reserve1', type: 'uint112' }, { name: 'blockTimestampLast', type: 'uint32' }] },
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'token1', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
] as const;

// Uniswap V2 Factory ABI
const UNISWAP_V2_FACTORY_ABI = [
  { type: 'function', name: 'getPair', stateMutability: 'view', inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }], outputs: [{ name: 'pair', type: 'address' }] },
] as const;

// Uniswap V2 Router ABI
const UNISWAP_V2_ROUTER_ABI = [
  {
    type: 'function',
    name: 'swapExactTokensForTokens',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
  {
    type: 'function',
    name: 'getAmountsOut',
    stateMutability: 'view',
    inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'path', type: 'address[]' }],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
] as const;

// ---------------------------------------------------------------------------
// Uniswap Adapter
// ---------------------------------------------------------------------------

export class UniswapAdapter implements DEXAdapter {
  readonly name = 'uniswap';
  readonly supportedChains: SupportedChainId[] = [
    SupportedChainId.ETHEREUM,
    SupportedChainId.POLYGON,
    SupportedChainId.ARBITRUM,
    SupportedChainId.BASE,
    SupportedChainId.OPTIMISM,
  ];

  /**
   * Get a price quote for a swap via Uniswap V2.
   */
  async getQuote(params: DEXAdapterParams): Promise<SwapQuote> {
    const tokenIn = await this.getTokenInfo(params.chainId, params.tokenIn);
    const tokenOut = await this.getTokenInfo(params.chainId, params.tokenOut);

    const inputAmount = parseUnits(params.amountIn, tokenIn.decimals);

    // Get reserves from pair contract
    const publicClient = getPublicClient(params.chainId);
    const factoryAddress = UNISWAP_V2_FACTORY[params.chainId];
    const routerAddress = UNISWAP_V2_ROUTER[params.chainId];

    if (!factoryAddress || !routerAddress) {
      throw new Error(`Uniswap V2 not available on chain ${params.chainId}`);
    }

    const factory = getContract({
      address: factoryAddress,
      abi: UNISWAP_V2_FACTORY_ABI,
      client: publicClient,
    });

    const pairAddress = await factory.read.getPair([params.tokenIn, params.tokenOut]);
    if (pairAddress === '0x0000000000000000000000000000000000000000') {
      throw new Error(`No Uniswap V2 pair found for ${tokenIn.symbol}/${tokenOut.symbol}`);
    }

    // Get reserves
    const pair = getContract({
      address: pairAddress,
      abi: UNISWAP_V2_PAIR_ABI,
      client: publicClient,
    });

    const [token0Address, reserves] = await Promise.all([
      pair.read.token0(),
      pair.read.getReserves(),
    ]);

    // Determine token ordering
    const isToken0 = token0Address.toLowerCase() === params.tokenIn.toLowerCase();
    const reserveIn = isToken0 ? reserves[0] : reserves[1];
    const reserveOut = isToken0 ? reserves[1] : reserves[0];

    // Calculate output amount using constant product formula: x * y = k
    const amountInWithFee = inputAmount * 997n;
    const numerator = amountInWithFee * reserveOut;
    const denominator = reserveIn * 1000n + amountInWithFee;
    const amountOut = numerator / denominator;

    // Calculate price impact
    const priceImpact = this.calculatePriceImpact(
      inputAmount,
      amountOut,
      reserveIn,
      reserveOut,
    );

    // Get gas estimate from router
    const router = getContract({
      address: routerAddress,
      abi: UNISWAP_V2_ROUTER_ABI,
      client: publicClient,
    });

    let estimatedGas: string | undefined;
    try {
      const amounts = await router.read.getAmountsOut([inputAmount, [params.tokenIn, params.tokenOut]]);
      // Rough estimate: 150k gas for swap
      estimatedGas = '150000';
    } catch {
      estimatedGas = '150000';
    }

    const pools: SwapPool[] = [{
      address: pairAddress,
      type: 'uniswap_v2',
    }];

    const swapRoute: SwapRoute = {
      path: [params.tokenIn, params.tokenOut],
      pools,
      hops: 1,
      estimatedGas,
    };

    return {
      chainId: params.chainId,
      tokenIn,
      tokenOut,
      amountIn: params.amountIn,
      amountOut: formatUnits(amountOut, tokenOut.decimals),
      priceImpact,
      route: swapRoute,
      gasEstimate: estimatedGas,
      source: 'uniswap_v2',
      timestamp: new Date(),
    };
  }

  /**
   * Build the calldata for a Uniswap V2 swap transaction.
   */
  async buildSwapCalldata(params: DEXAdapterParams): Promise<TransactionRequest> {
    const tokenIn = await this.getTokenInfo(params.chainId, params.tokenIn);
    const tokenOut = await this.getTokenInfo(params.chainId, params.tokenOut);

    const inputAmount = parseUnits(params.amountIn, tokenIn.decimals);
    const slippage = params.slippageTolerance ?? 0.5;
    const deadlineMinutes = params.deadlineMinutes ?? 20;

    const routerAddress = UNISWAP_V2_ROUTER[params.chainId];
    if (!routerAddress) {
      throw new Error(`Uniswap V2 router not available on chain ${params.chainId}`);
    }

    // Get quote for minimum output calculation
    const quote = await this.getQuote(params);
    const minAmountOut = parseUnits(quote.amountOut, tokenOut.decimals) * BigInt(Math.round((100 - slippage) * 100)) / 10000n;

    const deadline = Math.floor(Date.now() / 1000) + deadlineMinutes * 60;
    const recipient = params.recipient ?? '0x0000000000000000000000000000000000000000' as Address;

    // Encode swap call
    const data = this.encodeSwapCall(
      inputAmount,
      minAmountOut,
      [params.tokenIn, params.tokenOut],
      recipient,
      BigInt(deadline),
    );

    return {
      chainId: params.chainId,
      to: routerAddress,
      data,
      value: params.tokenIn.toLowerCase() === WETH_ADDRESSES[params.chainId]?.toLowerCase()
        ? `0x${inputAmount.toString(16)}` as Hex
        : undefined,
      gasLimit: '0x249f0' as Hex, // 150k gas
    };
  }

  /**
   * Check if this adapter supports a given token pair on a chain.
   */
  async supportsPair(
    chainId: SupportedChainId,
    _tokenIn: Address,
    _tokenOut: Address,
  ): Promise<boolean> {
    return this.supportedChains.includes(chainId) && UNISWAP_V2_ROUTER[chainId] !== undefined;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async getTokenInfo(
    chainId: SupportedChainId,
    tokenAddress: Address,
  ): Promise<TokenInfo> {
    // Check known tokens first
    const known = this.findKnownToken(chainId, tokenAddress);
    if (known) return known;

    // Fetch from chain
    const publicClient = getPublicClient(chainId);

    try {
      const contract = getContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        client: publicClient,
      });

      const [symbol, name, decimals] = await Promise.all([
        contract.read.symbol(),
        contract.read.name(),
        contract.read.decimals(),
      ]);

      return {
        address: tokenAddress,
        symbol,
        name,
        decimals,
        chainId,
      };
    } catch {
      throw new Error(`Failed to get token info for ${tokenAddress} on chain ${chainId}`);
    }
  }

  private findKnownToken(
    chainId: SupportedChainId,
    address: Address,
  ): TokenInfo | null {
    const weth = WETH_ADDRESSES[chainId];
    const usdc = USDC_ADDRESSES[chainId];
    const usdt = USDT_ADDRESSES[chainId];

    if (weth && address.toLowerCase() === weth.toLowerCase()) {
      return { address: weth, symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, chainId };
    }
    if (usdc && address.toLowerCase() === usdc.toLowerCase()) {
      return { address: usdc, symbol: 'USDC', name: 'USD Coin', decimals: 6, chainId };
    }
    if (usdt && address.toLowerCase() === usdt.toLowerCase()) {
      return { address: usdt, symbol: 'USDT', name: 'Tether USD', decimals: 6, chainId };
    }
    return null;
  }

  private calculatePriceImpact(
    inputAmount: bigint,
    outputAmount: bigint,
    reserveIn: bigint,
    reserveOut: bigint,
  ): number {
    // Price impact = (execution price / market price - 1) * 100
    const marketPrice = Number(reserveOut) / Number(reserveIn);
    const executionPrice = Number(outputAmount) / Number(inputAmount);
    return Math.abs((executionPrice / marketPrice - 1) * 100);
  }

  private encodeSwapCall(
    amountIn: bigint,
    amountOutMin: bigint,
    path: Address[],
    to: Address,
    deadline: bigint,
  ): Hex {
    // Manual ABI encoding for swapExactTokensForTokens
    const functionSelector = '0x38ed1739'; // swapExactTokensForTokens selector
    const encoded = this.abiEncode([
      { type: 'uint256', value: amountIn },
      { type: 'uint256', value: amountOutMin },
      { type: 'address[]', value: path },
      { type: 'address', value: to },
      { type: 'uint256', value: deadline },
    ]);
    return (functionSelector + encoded) as Hex;
  }

  private abiEncode(params: Array<{ type: string; value: unknown }>): string {
    // Simple ABI encoder for common types
    let result = '';
    const dynamicParts: string[] = [];

    for (const param of params) {
      switch (param.type) {
        case 'uint256':
        case 'address':
          result += this.abiEncodePrimitive(param.type, param.value);
          break;
        case 'address[]':
          // Dynamic type - encode offset then data
          result += '0000000000000000000000000000000000000000000000000000000000000020'; // offset
          const arr = param.value as Address[];
          result += this.abiEncodePrimitive('uint256', BigInt(arr.length));
          for (const addr of arr) {
            result += this.abiEncodePrimitive('address', addr);
          }
          break;
      }
    }

    return result;
  }

  private abiEncodePrimitive(type: string, value: unknown): string {
    if (type === 'uint256') {
      return (value as bigint).toString(16).padStart(64, '0');
    }
    if (type === 'address') {
      return (value as string).toLowerCase().slice(2).padStart(64, '0');
    }
    return '';
  }
}
