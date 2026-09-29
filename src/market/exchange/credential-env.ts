import ccxt, { type Exchange } from 'ccxt';
export interface CredentialEnvDescriptor {
  required: readonly string[];
  optional?: readonly string[];
  requiredAlternatives?: Readonly<Record<string, readonly string[]>>;
}

export interface CredentialValues { apiKey?: string; secret?: string; passphrase?: string; accountId?: string; accessToken?: string; walletAddress?: string; privateKey?: string; baseUrl?: string; sessionToken?: string; restUrl?: string; network?: string }

const NATIVE_EXCHANGE_IDS = new Set(['alpaca', 'ibkr', 'longbridge', 'hyperliquid']);

export function canUseGenericCredentialAliases(exchangeId: string, exchangeIds: readonly string[]): boolean {
  const canonicalId = exchangeId.trim();
  return !NATIVE_EXCHANGE_IDS.has(canonicalId.toLowerCase())
    && Object.hasOwn(ccxt.pro, canonicalId)
    && exchangeIds.length === 1
    && exchangeIds[0]?.trim() === canonicalId;
}

export function resolveCredentialValues(exchangeId: string, exchangeIds: readonly string[], env: NodeJS.ProcessEnv = process.env): CredentialValues {
  const descriptor = getCredentialEnv(exchangeId);
  const [keyName, secretName] = descriptor.required;
  const canonicalId = exchangeId.trim();
  const singleton = canUseGenericCredentialAliases(exchangeId, exchangeIds);
  const nonblank = (value: string | undefined) => value?.trim() ? value : undefined;
  const apiKey = nonblank(env[keyName ?? '']) ?? (singleton ? nonblank(env.EXCHANGE_API_KEY) : undefined);
  const secret = nonblank(env[secretName ?? '']) ?? (singleton ? nonblank(env.EXCHANGE_SECRET) : undefined);
  const passphrase = nonblank(env[`${canonicalId.toUpperCase()}_PASSPHRASE`]) ?? (singleton ? nonblank(env.EXCHANGE_PASSPHRASE) : undefined);
  if (canonicalId.toLowerCase() === 'alpaca') return { apiKey: nonblank(env.ALPACA_API_KEY) ?? nonblank(env.ALPACA_API_KEY_ID), secret: nonblank(env.ALPACA_SECRET_KEY) ?? nonblank(env.ALPACA_API_SECRET) };
  if (canonicalId.toLowerCase() === 'ibkr') return { accountId: nonblank(env.IBKR_ACCOUNT_ID), baseUrl: nonblank(env.IBKR_BASE_URL), sessionToken: nonblank(env.IBKR_SESSION_TOKEN) };
  if (canonicalId.toLowerCase() === 'longbridge') return { accessToken: nonblank(env.LONGBRIDGE_ACCESS_TOKEN) ?? nonblank(env.LONGBRIDGE_TOKEN), baseUrl: nonblank(env.LONGBRIDGE_HTTP_URL) };
  if (canonicalId.toLowerCase() === 'hyperliquid') return { walletAddress: nonblank(env.HYPERLIQUID_WALLET_ADDRESS) ?? nonblank(env.HYPERLIQUID_PUBLIC_KEY), privateKey: nonblank(env.HYPERLIQUID_PRIVATE_KEY), restUrl: nonblank(env.HYPERLIQUID_REST_URL), network: nonblank(env.HYPERLIQUID_NETWORK) };
  return { ...(apiKey ? { apiKey } : {}), ...(secret ? { secret } : {}), ...(passphrase ? { passphrase } : {}) };
}

/** Environment names consumed by each currently supported exchange adapter. */
export function getCredentialEnv(exchangeId: string): CredentialEnvDescriptor {
  switch (exchangeId.trim().toLowerCase()) {
    case 'alpaca': return { required: ['ALPACA_API_KEY', 'ALPACA_SECRET_KEY'] };
    case 'ibkr': return { required: ['IBKR_ACCOUNT_ID'], optional: ['IBKR_BASE_URL', 'IBKR_SESSION_TOKEN'] };
    case 'longbridge': return { required: ['LONGBRIDGE_ACCESS_TOKEN'], requiredAlternatives: { LONGBRIDGE_ACCESS_TOKEN: ['LONGBRIDGE_TOKEN'] }, optional: ['LONGBRIDGE_HTTP_URL'] };
    case 'hyperliquid': return { required: ['HYPERLIQUID_WALLET_ADDRESS', 'HYPERLIQUID_PRIVATE_KEY'], optional: ['HYPERLIQUID_PUBLIC_KEY', 'HYPERLIQUID_NETWORK', 'HYPERLIQUID_REST_URL'] };
    default: {
      if (!/^[a-z0-9_-]+$/i.test(exchangeId.trim())) return { required: [] };
      const prefix = exchangeId.trim().toUpperCase();
      const required = [`${prefix}_API_KEY`, `${prefix}_SECRET`];
      const klass = Object.hasOwn(ccxt.pro, exchangeId.trim()) ? (ccxt.pro as Record<string, typeof Exchange>)[exchangeId.trim()] : undefined;
      if (klass && new klass().requiredCredentials.password) required.push(`${prefix}_PASSPHRASE`);
      return { required };
    }
  }
}

export function hasCredentialEnv(exchangeId: string, env: NodeJS.ProcessEnv = process.env, exchangeIds: readonly string[] = [exchangeId]): boolean {
  const descriptor = getCredentialEnv(exchangeId);
  const values = resolveCredentialValues(exchangeId, exchangeIds, env);
  const required = [...descriptor.required];
  return required.every((name) => {
    const alternatives = descriptor.requiredAlternatives?.[name] ?? [];
    if (alternatives.some((alternative) => Boolean(nonblank(env[alternative])))) return true;
    if (name.endsWith('_API_KEY')) return Boolean(values.apiKey);
    if (name.endsWith('_SECRET')) return Boolean(values.secret);
    if (name.endsWith('_PASSPHRASE')) return Boolean(values.passphrase);
    return Boolean(nonblank(env[name]));
  });
}

function nonblank(value: string | undefined): string | undefined { return value?.trim() ? value : undefined; }