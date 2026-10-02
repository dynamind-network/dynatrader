import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
} from 'react';
import type { ReactNode } from 'react';
import type { ChainManager } from '../services/chain-manager.js';
import type { WalletService } from '../services/wallet-service.js';
import type { Portfolio, WalletBalance, PositionWithPnL } from '../types/wallet.js';

interface WalletContextType {
  isConnected: boolean;
  isLoading: boolean;
  address: string;
  formattedAddress: string;
  portfolio: Portfolio | null;
  positions: PositionWithPnL[];
  error: string | null;
  refresh: () => Promise<void>;
  walletService: WalletService | null;
}

const WalletContext = createContext<WalletContextType>({
  isConnected: false,
  isLoading: true,
  address: '',
  formattedAddress: '',
  portfolio: null,
  positions: [],
  error: null,
  refresh: async () => {},
  walletService: null,
});

interface WalletProviderProps {
  children: ReactNode;
  privateKey?: string;
  mainAddress?: string;
}

export function WalletProvider({ children, privateKey, mainAddress }: WalletProviderProps) {
  const [walletService, setWalletService] = useState<WalletService | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [positions, setPositions] = useState<PositionWithPnL[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fetchPrices = useCallback(async (symbols: string[]): Promise<Record<string, number>> => {
    try {
      const { buildMarketUrl, getMarketTicker24hrPath } = await import('../config/market-provider.js');
      const url = buildMarketUrl(getMarketTicker24hrPath(), {});
      const response = await fetch(url);
      const tickers = (await response.json()) as Array<{ symbol: string; lastPrice: string }>;

      const prices: Record<string, number> = {};
      for (const sym of symbols) {
        const ticker = tickers.find((t) => t.symbol === `${sym}USDT`);
        if (ticker) {
          prices[sym] = parseFloat(ticker.lastPrice);
        }
      }
      return prices;
    } catch {
      return {};
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!walletService?.isInitialized()) {
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const { getStoredPositions } = await import('../services/portfolio-storage.js');
      const portfolioData = await walletService.getPortfolio();

      const storedPositions = getStoredPositions();
      const symbols = [
        ...new Set([
          ...portfolioData.balances.map((b) => b.symbol),
          ...storedPositions.map((p) => p.symbol),
        ]),
      ];

      const prices = await fetchPrices(symbols);

      const balancesWithPrices = portfolioData.balances.map((b) => ({
        ...b,
        priceUsd: prices[b.symbol] || 0,
        valueUsd: (prices[b.symbol] || 0) * parseFloat(b.balance),
      }));

      let totalValueUsd = 0;
      balancesWithPrices.forEach((b) => {
        totalValueUsd += b.valueUsd || 0;
      });

      const positionsWithPnL: PositionWithPnL[] = balancesWithPrices
        .filter((b) => parseFloat(b.balance) > 0)
        .map((b) => {
          const storedPos = storedPositions.find(
            (p) => p.symbol === b.symbol && p.chain === b.chain
          );
          const entryPrice = storedPos?.entryPrice || b.priceUsd || 0;
          const currentPrice = b.priceUsd || 0;
          const quantity = parseFloat(b.balance);
          const pnl = (currentPrice - entryPrice) * quantity;
          const pnlPercent = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;

          return {
            symbol: b.symbol,
            chain: b.chain,
            token: b.token,
            quantity,
            entryPrice,
            currentPrice,
            pnl,
            pnlPercent,
            valueUsd: b.valueUsd || 0,
          };
        });

      setPortfolio({
        ...portfolioData,
        balances: balancesWithPrices,
        totalValueUsd,
      });
      setPositions(positionsWithPnL);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch portfolio';
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, [walletService, fetchPrices]);

  useEffect(() => {
    const pk = privateKey || process.env.PRIVATE_KEY;
    const addr = mainAddress || process.env.MAIN_ADDRESS;

    if (!pk || !addr) {
      setIsConnected(false);
      setIsLoading(false);
      setError('Wallet not configured. Set PRIVATE_KEY and MAIN_ADDRESS environment variables.');
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    void (async () => {
      try {
        const [{ ChainManager }, { WalletService: WalletServiceImpl }] = await Promise.all([
          import('../services/chain-manager.js'),
          import('../services/wallet-service.js'),
        ]);
        if (cancelled) return;
        const service = new WalletServiceImpl(new ChainManager());
        service.initialize(pk, addr);
        setWalletService(service);
        setIsConnected(true);
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Failed to initialize wallet';
        setError(message);
        setIsConnected(false);
        setIsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [privateKey, mainAddress]);

  useEffect(() => {
    if (walletService) void refresh();
  }, [walletService, refresh]);

  const value: WalletContextType = {
    isConnected,
    isLoading,
    address: walletService?.getMainAddress() ?? '',
    formattedAddress: walletService?.getFormattedAddress() ?? '',
    portfolio,
    positions,
    error,
    refresh,
    walletService,
  };

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextType {
  const context = useContext(WalletContext);
  if (!context) {
    throw new Error('useWallet must be used within a WalletProvider');
  }
  return context;
}

export { WalletContext };

