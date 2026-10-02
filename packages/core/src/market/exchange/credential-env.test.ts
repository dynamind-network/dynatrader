import { describe, expect, it } from 'vitest';
import { canUseGenericCredentialAliases, getCredentialEnv, hasCredentialEnv, resolveCredentialValues } from './credential-env';

describe('venue credential environment descriptors', () => {
  it('treats native single-token requirements and Longbridge alternate token as complete', () => {
    expect(hasCredentialEnv('ibkr', { IBKR_ACCOUNT_ID: 'DU123' })).toBe(true);
    expect(hasCredentialEnv('ibkr', {})).toBe(false);
    expect(hasCredentialEnv('longbridge', { LONGBRIDGE_TOKEN: 'token' })).toBe(true);
    expect(hasCredentialEnv('longbridge', { LONGBRIDGE_TOKEN: '  ' })).toBe(false);
  });

  it('requires passphrase only for CCXT venues whose installed metadata requires password', () => {
    expect(getCredentialEnv('okx').required).toEqual(['OKX_API_KEY', 'OKX_SECRET', 'OKX_PASSPHRASE']);
    const okx = { OKX_API_KEY: 'key', OKX_SECRET: 'secret' };
    expect(hasCredentialEnv('okx', okx)).toBe(false);
    expect(hasCredentialEnv('okx', { ...okx, OKX_PASSPHRASE: 'pass' })).toBe(true);
    expect(hasCredentialEnv('okx', { EXCHANGE_API_KEY: 'key', EXCHANGE_SECRET: 'secret', EXCHANGE_PASSPHRASE: 'pass' })).toBe(true);
    expect(hasCredentialEnv('binance', { BINANCE_API_KEY: 'key', BINANCE_SECRET: 'secret' })).toBe(true);
  }, 15_000);
  it.each([
    ['alpaca', ['ALPACA_API_KEY', 'ALPACA_SECRET_KEY']],
    ['ibkr', ['IBKR_ACCOUNT_ID']],
    ['longbridge', ['LONGBRIDGE_ACCESS_TOKEN']],
    ['hyperliquid', ['HYPERLIQUID_WALLET_ADDRESS', 'HYPERLIQUID_PRIVATE_KEY']],
    ['binance', ['BINANCE_API_KEY', 'BINANCE_SECRET']],
  ])('describes %s', (venue, required) => expect(getCredentialEnv(venue).required).toEqual(required));

  it('checks only presence and never returns values', () => {
    const env = { BINANCE_API_KEY: 'test-key-only', BINANCE_SECRET: 'test-secret-only' };
    expect(hasCredentialEnv('binance', env)).toBe(true);
    expect(hasCredentialEnv('binance', { BINANCE_API_KEY: 'test-key-only' })).toBe(false);
    expect(JSON.stringify(getCredentialEnv('binance'))).not.toContain('test-secret-only');
  });

  it('uses generic aliases only when exactly one exchange is configured', () => {
    const env = { EXCHANGE_API_KEY: 'generic-test-key', EXCHANGE_SECRET: 'generic-test-secret', EXCHANGE_PASSPHRASE: 'generic-test-pass' };
    expect(resolveCredentialValues('binance', ['binance'], env)).toEqual({ apiKey: 'generic-test-key', secret: 'generic-test-secret', passphrase: 'generic-test-pass' });
    expect(resolveCredentialValues('binance', ['binance', 'kraken'], env)).toEqual({});
  });

  it('accepts aliases only for a registered CCXT ID matching the sole configured ID', () => {
    const env = { EXCHANGE_API_KEY: 'generic-key', EXCHANGE_SECRET: 'generic-secret' };
    expect(resolveCredentialValues('not-a-real-exchange', ['not-a-real-exchange'], env)).toEqual({});
    expect(resolveCredentialValues('binance', ['kraken'], env)).toEqual({});
    expect(resolveCredentialValues('binance', ['binance'], env)).toEqual({ apiKey: 'generic-key', secret: 'generic-secret' });
  });

  it('allows generic aliases only for the exact registered singleton ID', () => {
    expect(canUseGenericCredentialAliases('binance', ['binance'])).toBe(true);
    expect(canUseGenericCredentialAliases('not-a-real-exchange', ['not-a-real-exchange'])).toBe(false);
    expect(canUseGenericCredentialAliases('binance', ['kraken'])).toBe(false);
    expect(canUseGenericCredentialAliases('binance', ['binance', 'kraken'])).toBe(false);
    expect(canUseGenericCredentialAliases('alpaca', ['alpaca'])).toBe(false);
  });

  it('uses nonblank generic fallback when venue-specific values are blank', () => {
    expect(resolveCredentialValues('binance', ['binance'], { BINANCE_API_KEY: '  ', BINANCE_SECRET: '', EXCHANGE_API_KEY: 'generic-key', EXCHANGE_SECRET: 'generic-secret', BINANCE_PASSPHRASE: ' ', EXCHANGE_PASSPHRASE: 'generic-pass' })).toEqual({ apiKey: 'generic-key', secret: 'generic-secret', passphrase: 'generic-pass' });
  });

  it('checks canonical aliases when explicitly passed configured exchange IDs', () => {
    const env = { EXCHANGE_API_KEY: 'generic-key', EXCHANGE_SECRET: 'generic-secret' };
    expect(hasCredentialEnv('binance', env, ['binance'])).toBe(true);
    expect(hasCredentialEnv('binance', env, ['binance', 'kraken'])).toBe(false);
  });

  it('does not resolve generic aliases for native adapters', () => {
    expect(resolveCredentialValues('alpaca', ['alpaca'], { EXCHANGE_API_KEY: 'generic-key', EXCHANGE_SECRET: 'generic-secret' })).toEqual({});
  });

  it('prefers venue-specific environment values', () => {
    expect(resolveCredentialValues('okx', ['okx'], { OKX_API_KEY: 'venue-key', OKX_SECRET: 'venue-secret', OKX_PASSPHRASE: 'venue-pass', EXCHANGE_API_KEY: 'generic-key' })).toEqual({ apiKey: 'venue-key', secret: 'venue-secret', passphrase: 'venue-pass' });
  });
});
