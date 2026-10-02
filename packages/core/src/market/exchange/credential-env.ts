import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Exchange } from 'ccxt';

const require = createRequire(import.meta.url);
const exchangeClassCache = new Map<string, typeof Exchange | null>();

function getCCXTExchangeClass(exchangeId: string): typeof Exchange | undefined {
  const id = exchangeId.trim();
  if (!/^[a-z0-9_-]+$/i.test(id)) return undefined;
  if (exchangeClassCache.has(id)) return exchangeClassCache.get(id) ?? undefined;

  let exchangeClass: typeof Exchange | undefined;
  try {
    // Loading `ccxt` itself eagerly imports hundreds of exchange classes.
    // Resolve the package root, then load only the requested Pro adapter. Node
    // 22.19+ supports synchronous require() of ESM modules without top-level
    // await, which keeps the existing synchronous credential diagnostics API.
    const packageRoot = path.dirname(path.dirname(require.resolve('ccxt')));
    const exchangePath = path.join(packageRoot, 'js', 'src', 'pro', `${id}.js`);
    if (existsSync(exchangePath)) {
      const loaded = require(exchangePath) as { default?: typeof Exchange; [name: string]: unknown };
      const candidate = loaded.default ?? loaded[id];
      if (typeof candidate === 'function') exchangeClass = candidate as typeof Exchange;
    }
  } catch {
    exchangeClass = undefined;
  }

  exchangeClassCache.set(id, exchangeClass ?? null);
  return exchangeClass;
}
export interface CredentialEnvDescriptor {
  required: readonly string[];
  optional?: readonly string[];
  requiredAlternatives?: Readonly<Record<string, readonly string[]>>;
}

export interface CredentialValues { apiKey?: string; secret?: string; passphrase?: string; accountId?: string; accessToken?: string; walletAddress?: string; privateKey?: string; baseUrl?: string; sessionToken?: string; restUrl?: string; network?: string }

const NATIVE_EXCHANGE_IDS = new Set(['alpaca', 'ibkr', 'longbridge', 'hyperliquid']);

export function canUseGenericCredentialAliases(exchangeId: string, exchangeIds: readonly string[]): boolean {
  const canonicalId = exchangeId.trim();
  if (NATIVE_EXCHANGE_IDS.has(canonicalId.toLowerCase()) || exchangeIds.length !== 1 || exchangeIds[0]?.trim() !== canonicalId) {
    return false;
  }
  return getCCXTExchangeClass(canonicalId) !== undefined;
}

export function resolveCredentialValues(exchangeId: string, exchangeIds: readonly string[], env: NodeJS.ProcessEnv = process.env): CredentialValues {
  const descriptor = getBaseCredentialEnv(exchangeId);
  const [keyName, secretName] = descriptor.required;
  const canonicalId = exchangeId.trim();
  const nonblank = (value: string | undefined) => value?.trim() ? value : undefined;
  const genericCredentialsConfigured = nonblank(env.EXCHANGE_API_KEY) || nonblank(env.EXCHANGE_SECRET) || nonblank(env.EXCHANGE_PASSPHRASE);
  const singleton = Boolean(genericCredentialsConfigured && canUseGenericCredentialAliases(exchangeId, exchangeIds));
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
  const descriptor = getBaseCredentialEnv(exchangeId);
  if (descriptor.required.length === 0 || NATIVE_EXCHANGE_IDS.has(exchangeId.trim().toLowerCase())) return descriptor;
  const klass = getCCXTExchangeClass(exchangeId);
  if (klass && new klass().requiredCredentials.password) {
    return { ...descriptor, required: [...descriptor.required, `${exchangeId.trim().toUpperCase()}_PASSPHRASE`] };
  }
  return descriptor;
}

function getBaseCredentialEnv(exchangeId: string): CredentialEnvDescriptor {
  switch (exchangeId.trim().toLowerCase()) {
    case 'alpaca': return { required: ['ALPACA_API_KEY', 'ALPACA_SECRET_KEY'] };
    case 'ibkr': return { required: ['IBKR_ACCOUNT_ID'], optional: ['IBKR_BASE_URL', 'IBKR_SESSION_TOKEN'] };
    case 'longbridge': return { required: ['LONGBRIDGE_ACCESS_TOKEN'], requiredAlternatives: { LONGBRIDGE_ACCESS_TOKEN: ['LONGBRIDGE_TOKEN'] }, optional: ['LONGBRIDGE_HTTP_URL'] };
    case 'hyperliquid': return { required: ['HYPERLIQUID_WALLET_ADDRESS', 'HYPERLIQUID_PRIVATE_KEY'], optional: ['HYPERLIQUID_PUBLIC_KEY', 'HYPERLIQUID_NETWORK', 'HYPERLIQUID_REST_URL'] };
    default: {
      if (!/^[a-z0-9_-]+$/i.test(exchangeId.trim())) return { required: [] };
      const prefix = exchangeId.trim().toUpperCase();
      return { required: [`${prefix}_API_KEY`, `${prefix}_SECRET`] };
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
