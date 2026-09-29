import { canUseGenericCredentialAliases, getCredentialEnv, hasCredentialEnv } from '../../market/exchange/credential-env';

const DISPLAY_ENV_KEYS = ['EXCHANGE_API_KEY', 'EXCHANGE_SECRET', 'EXCHANGE_PASSPHRASE'] as const;

export function formatCredentialPresence(exchangeId: string, exchangeIds: readonly string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const descriptor = getCredentialEnv(exchangeId);
  const alternatives = descriptor.requiredAlternatives ?? {};
  const keys = [...descriptor.required.flatMap((name) => [name, ...(alternatives[name] ?? [])]), ...(descriptor.optional ?? [])];
  const aliasesEligible = canUseGenericCredentialAliases(exchangeId, exchangeIds);
  if (aliasesEligible) keys.push(...DISPLAY_ENV_KEYS);
  const presence = (key: string) => env[key]?.trim() ? '[set]' : '[missing]';
  const requiredKeys = new Set(descriptor.required);
  return [...new Set(keys)].map((key) => {
    if (requiredKeys.has(key) && alternatives[key]?.length) {
      const effective = [key, ...alternatives[key]!].some((candidate) => Boolean(env[candidate]?.trim()));
      return `${key} (fallback ${alternatives[key]!.join(', ')})=${effective ? '[set]' : '[missing]'}`;
    }
    return `${key}=${presence(key)}`;
  });
}

export function missingCredentialEnvNames(exchangeId: string, exchangeIds: readonly string[], mode: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!['live', 'micro_live'].includes(mode.trim().toLowerCase())) return [];
  const descriptor = getCredentialEnv(exchangeId);
  const aliasesEligible = canUseGenericCredentialAliases(exchangeId, exchangeIds);
  const required = [...descriptor.required];
  return required.filter((name) => {
    const candidates = [name, ...(descriptor.requiredAlternatives?.[name] ?? [])];
    if (candidates.some((candidate) => Boolean(env[candidate]?.trim()))) return false;
    const generic = name.endsWith('_API_KEY') ? 'EXCHANGE_API_KEY' : name.endsWith('_SECRET') ? 'EXCHANGE_SECRET' : name.endsWith('_PASSPHRASE') ? 'EXCHANGE_PASSPHRASE' : undefined;
    return !(aliasesEligible && generic && env[generic]?.trim());
  });
}