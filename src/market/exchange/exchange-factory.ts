import type { ExchangeAdapter } from '../../types';
import { CCXTAdapter } from '@dyna/exchange-ccxt';
import { AlpacaAdapter } from './alpaca-adapter';
import { IBKRAdapter } from './ibkr-adapter';
import { LongbridgeAdapter } from './longbridge-adapter';
import { HyperliquidAdapter } from './hyperliquid-adapter';

export interface ExchangeFactoryConfig {
  mode?: string;
  exchangeId?: string;
  adapterName?: string;
  auth?: Record<string, unknown>;
}

/** Build the configured exchange adapter without inventing a venue. */
export function createExchangeAdapter(config: ExchangeFactoryConfig): ExchangeAdapter | null {
  const exchangeId = (config.exchangeId ?? config.adapterName ?? (config.mode === 'paper' || config.mode === 'backtest' ? 'binance' : '')).trim();
  if (!exchangeId) return null;

  const auth = config.auth ?? {};
  const isPaper = config.mode === 'paper' || config.mode === 'backtest';
  const apiKey = (auth.apiKey as string | undefined) ?? process.env[`${exchangeId.toUpperCase()}_API_KEY`];
  const secret = (auth.secret as string | undefined) ?? process.env[`${exchangeId.toUpperCase()}_SECRET`];

  switch (exchangeId.toLowerCase()) {
    case 'alpaca':
      return new AlpacaAdapter({
        apiKey: process.env.ALPACA_API_KEY ?? (auth.apiKey as string | undefined),
        secretKey: process.env.ALPACA_SECRET_KEY ?? (auth.secret as string | undefined),
        paper: isPaper,
      });
    case 'ibkr':
      return new IBKRAdapter({
        accountId: process.env.IBKR_ACCOUNT_ID ?? (auth.accountId as string | undefined),
        baseUrl: process.env.IBKR_BASE_URL,
        sessionToken: process.env.IBKR_SESSION_TOKEN,
      });
    case 'longbridge':
      return new LongbridgeAdapter({
        accessToken: process.env.LONGBRIDGE_ACCESS_TOKEN ?? process.env.LONGBRIDGE_TOKEN,
        baseUrl: process.env.LONGBRIDGE_HTTP_URL,
      });
    case 'hyperliquid':
      return new HyperliquidAdapter({
        walletAddress: (auth.walletAddress as string | undefined) ?? process.env.HYPERLIQUID_WALLET_ADDRESS ?? process.env.HYPERLIQUID_PUBLIC_KEY ?? '',
        privateKey: (auth.privateKey as string | undefined) ?? process.env.HYPERLIQUID_PRIVATE_KEY,
        restUrl: process.env.HYPERLIQUID_REST_URL,
      });
    default:
      return new CCXTAdapter({ exchangeId, apiKey, secret, sandbox: isPaper });
  }
}
