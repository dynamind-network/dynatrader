import { describe, expect, it } from 'vitest';
import { formatCredentialPresence, missingCredentialEnvNames } from './credentials';

describe('credential presence display', () => {
  it('reports Longbridge alternate token as the effective accepted credential', () => {
    const env = { LONGBRIDGE_TOKEN: 'alternate-token' };
    expect(missingCredentialEnvNames('longbridge', ['longbridge'], 'live', env)).toEqual([]);
    expect(formatCredentialPresence('longbridge', ['longbridge'], env)).toContain('LONGBRIDGE_ACCESS_TOKEN (fallback LONGBRIDGE_TOKEN)=[set]');
    expect(formatCredentialPresence('longbridge', ['longbridge'], env)).not.toContain('LONGBRIDGE_ACCESS_TOKEN=[set]');
    expect(formatCredentialPresence('longbridge', ['longbridge'], env).join(' ')).not.toContain('alternate-token');
  });

  it('reports Longbridge credential missing when both accepted tokens are blank or absent', () => {
    expect(missingCredentialEnvNames('longbridge', ['longbridge'], 'live', {})).toEqual(['LONGBRIDGE_ACCESS_TOKEN']);
    expect(missingCredentialEnvNames('longbridge', ['longbridge'], 'live', { LONGBRIDGE_TOKEN: '  ' })).toEqual(['LONGBRIDGE_ACCESS_TOKEN']);
    expect(formatCredentialPresence('longbridge', ['longbridge'], { LONGBRIDGE_TOKEN: '  ' })).toContain('LONGBRIDGE_ACCESS_TOKEN (fallback LONGBRIDGE_TOKEN)=[missing]');
  });

  it('requires a specific or generic passphrase only for CCXT venues that require it', () => {
    expect(missingCredentialEnvNames('okx', ['okx'], 'live', { EXCHANGE_API_KEY: 'key', EXCHANGE_SECRET: 'secret' })).toEqual(['OKX_PASSPHRASE']);
    expect(missingCredentialEnvNames('okx', ['okx'], 'live', { OKX_API_KEY: 'key', OKX_SECRET: 'secret' })).toEqual(['OKX_PASSPHRASE']);
    expect(missingCredentialEnvNames('okx', ['okx'], 'live', { OKX_API_KEY: 'key', OKX_SECRET: 'secret', EXCHANGE_PASSPHRASE: 'pass' })).toEqual([]);
    expect(missingCredentialEnvNames('binance', ['binance'], 'live', { BINANCE_API_KEY: 'key', BINANCE_SECRET: 'secret' })).toEqual([]);
  });

  it('displays required venue passphrase and eligible generic alias presence', () => {
    expect(formatCredentialPresence('okx', ['okx'], { EXCHANGE_API_KEY: 'key', EXCHANGE_SECRET: 'secret' })).toContain('OKX_PASSPHRASE=[missing]');
    expect(formatCredentialPresence('okx', ['okx'], { EXCHANGE_PASSPHRASE: 'pass' })).toContain('EXCHANGE_PASSPHRASE=[set]');
  });
  it('shows only presence markers, never credential values', () => {
    expect(formatCredentialPresence('binance', ['binance'], { EXCHANGE_SECRET: 'sentinel-secret-1234', EXCHANGE_API_KEY: 'sentinel-key-5678' })).toEqual([
      'BINANCE_API_KEY=[missing]', 'BINANCE_SECRET=[missing]', 'EXCHANGE_API_KEY=[set]', 'EXCHANGE_SECRET=[set]', 'EXCHANGE_PASSPHRASE=[missing]',
    ]);
  });

  it('shows venue-specific presence and eligible generic aliases without values', () => {
    const env = {
      BINANCE_API_KEY: 'synthetic-binance-key',
      BINANCE_SECRET: 'synthetic-binance-secret',
      EXCHANGE_API_KEY: 'synthetic-generic-key',
      EXCHANGE_SECRET: 'synthetic-generic-secret',
    };
    expect(formatCredentialPresence('binance', ['binance'], env)).toEqual([
      'BINANCE_API_KEY=[set]', 'BINANCE_SECRET=[set]', 'EXCHANGE_API_KEY=[set]', 'EXCHANGE_SECRET=[set]', 'EXCHANGE_PASSPHRASE=[missing]',
    ]);
    expect(formatCredentialPresence('binance', ['binance', 'kraken'], env)).toEqual([
      'BINANCE_API_KEY=[set]', 'BINANCE_SECRET=[set]',
    ]);
    expect(formatCredentialPresence('binance', ['binance'], env).join(' ')).not.toContain('synthetic-');
  });

  it('reports absent names for live mode and keeps paper optional', () => {
    expect(missingCredentialEnvNames('binance', ['binance'], 'live', {})).toEqual(['BINANCE_API_KEY', 'BINANCE_SECRET']);
    expect(missingCredentialEnvNames('binance', ['binance'], 'paper', {})).toEqual([]);
  });

  it.each(['paper', 'backtest', 'shadow', 'research'])('does not require credentials in %s mode', (mode) => {
    expect(missingCredentialEnvNames('binance', ['binance'], mode, {})).toEqual([]);
  });

  it('uses generic aliases only for a singleton CCXT exchange', () => {
    const env = { EXCHANGE_API_KEY: 'test-key', EXCHANGE_SECRET: 'test-secret' };
    expect(missingCredentialEnvNames('binance', ['binance'], 'live', env)).toEqual([]);
    expect(missingCredentialEnvNames('binance', ['binance', 'kraken'], 'live', env)).toEqual(['BINANCE_API_KEY', 'BINANCE_SECRET']);
  });

  it('does not display or accept aliases for unsupported or mismatched singleton IDs', () => {
    const env = { EXCHANGE_API_KEY: 'test-key', EXCHANGE_SECRET: 'test-secret' };
    expect(formatCredentialPresence('not-a-real-exchange', ['not-a-real-exchange'], env)).toEqual([
      'NOT-A-REAL-EXCHANGE_API_KEY=[missing]', 'NOT-A-REAL-EXCHANGE_SECRET=[missing]',
    ]);
    expect(missingCredentialEnvNames('not-a-real-exchange', ['not-a-real-exchange'], 'live', env)).toEqual([
      'NOT-A-REAL-EXCHANGE_API_KEY', 'NOT-A-REAL-EXCHANGE_SECRET',
    ]);
    expect(formatCredentialPresence('binance', ['kraken'], env)).toEqual(['BINANCE_API_KEY=[missing]', 'BINANCE_SECRET=[missing]']);
    expect(missingCredentialEnvNames('binance', ['kraken'], 'live', env)).toEqual(['BINANCE_API_KEY', 'BINANCE_SECRET']);
  });
});