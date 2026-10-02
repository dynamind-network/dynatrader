import { describe, expect, it } from 'vitest';
import { isLoopbackHost, isPublicAddress, validateWebhookUrl } from '../src/async/safe-webhook.js';

describe('webhook destination validation', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.31.255.1',
    '192.168.1.1',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
  ])('rejects non-public address %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'])('accepts public address %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    'http://localhost/',
    'http://service.local/',
    'http://[::1]/',
    'http://127.0.0.1/',
    'ftp://example.com/file',
    'https://user:password@example.com/',
  ])('rejects unsafe URL %s before resolving it', async (url) => {
    await expect(validateWebhookUrl(url)).rejects.toThrow();
  });

  it('recognizes only loopback bind hosts as safe without an API key', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.2')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('192.168.1.3')).toBe(false);
  });
});
