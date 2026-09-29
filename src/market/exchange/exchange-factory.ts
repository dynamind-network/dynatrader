import type { ExchangeAdapter } from '../../types';
import { CCXTAdapter } from '@dyna/exchange-ccxt';
import { AlpacaAdapter } from './alpaca-adapter';
import { IBKRAdapter } from './ibkr-adapter';
import { LongbridgeAdapter } from './longbridge-adapter';
import { HyperliquidAdapter } from './hyperliquid-adapter';
import { createHyperliquidActionSigner } from './hyperliquid-signer-provider';
import type { HyperliquidNetwork } from './hyperliquid-adapter';
import { resolveCredentialValues } from './credential-env';

export interface ExchangeFactoryConfig {
  mode?: string;
  exchangeId?: string;
  exchangeIds?: readonly string[];
  adapterName?: string;
  auth?: Record<string, unknown>;
  network?: import('./hyperliquid-adapter').HyperliquidNetwork;
}

/** Build the configured exchange adapter without inventing a venue. */
export function createExchangeAdapter(config: ExchangeFactoryConfig): ExchangeAdapter | null {
  const requestedId = config.exchangeId?.trim() || config.adapterName?.trim();
  const exchangeId = requestedId || process.env.EXCHANGE_ID?.trim() || (config.mode === 'paper' || config.mode === 'backtest' ? 'binance' : '');
  if (!exchangeId) return null;

  const auth = config.auth ?? {};
  const isPaper = config.mode === 'paper' || config.mode === 'backtest';
  const creds = resolveCredentialValues(exchangeId, config.exchangeIds ?? [exchangeId]);
  const nonblank = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;
  const authFirst = (authValue: unknown, envValue: string | undefined) => nonblank(authValue) ?? envValue;
  const envFirst = (authValue: unknown, envValue: string | undefined) => envValue ?? nonblank(authValue);
  const apiKey = authFirst(auth.apiKey, creds.apiKey);
  const secret = authFirst(auth.secret, creds.secret);
  const passphrase = authFirst(auth.passphrase, creds.passphrase);

  switch (exchangeId.toLowerCase()) {
    case 'alpaca':
      return new AlpacaAdapter({
        apiKey: envFirst(auth.apiKey, creds.apiKey),
        secretKey: envFirst(auth.secret, creds.secret),
        paper: isPaper,
      });
    case 'ibkr':
      return new IBKRAdapter({
        accountId: nonblank(creds.accountId) ?? nonblank(auth.accountId),
        baseUrl: creds.baseUrl,
        sessionToken: creds.sessionToken,
      });
    case 'longbridge':
      return new LongbridgeAdapter({
        accessToken: authFirst(auth.accessToken, creds.accessToken),
        baseUrl: creds.baseUrl,
      });
    case 'hyperliquid': {
      const network = (config.network ?? auth.network ?? creds.network) as HyperliquidNetwork | undefined;
      const privateKey = authFirst(auth.privateKey, creds.privateKey);
      return new HyperliquidAdapter({
        walletAddress: authFirst(auth.walletAddress, creds.walletAddress) ?? '',
        signer: privateKey ? createHyperliquidActionSigner(privateKey as `0x${string}`, network === 'testnet' ? 'b' : 'a') : undefined,
        restUrl: creds.restUrl,
        network,
      });
    }
    default:
      return new CCXTAdapter({ exchangeId, apiKey, secret, passphrase, sandbox: isPaper });
  }
}
