import { lookup } from 'node:dns/promises';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Agent, fetch } from 'undici';

const blockedIpv4 = new BlockList();
for (const subnet of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedIpv4.addSubnet(subnet[0], subnet[1], 'ipv4');
}
const blockedIpv6 = new BlockList();
for (const subnet of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blockedIpv6.addSubnet(subnet[0], subnet[1], 'ipv6');
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (!family) return false;
  return !(family === 4 ? blockedIpv4 : blockedIpv6).check(address, family === 4 ? 'ipv4' : 'ipv6');
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '');
}

function validateUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Webhook URL must use HTTP or HTTPS');
  }
  if (url.username || url.password) {
    throw new Error('Webhook URL must not contain credentials');
  }
  const hostname = normalizeHostname(url.hostname);
  if (!hostname || /(?:^|\.)(?:localhost|local|internal)$/i.test(hostname)) {
    throw new Error('Webhook URL cannot point to a local or internal host');
  }
  if (isIP(hostname) && !isPublicAddress(hostname)) {
    throw new Error('Webhook URL cannot point to a private or reserved address');
  }
  return url;
}

async function resolvePublicAddresses(hostname: string) {
  if (isIP(hostname)) {
    if (!isPublicAddress(hostname)) {
      throw new Error('Webhook URL cannot point to a private or reserved address');
    }
    return [{ address: hostname, family: isIP(hostname) as 4 | 6 }];
  }

  const records = await lookup(hostname, { all: true, verbatim: true });
  if (records.length === 0 || records.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('Webhook host resolves to a private or reserved address');
  }
  return records;
}

export async function validateWebhookUrl(value: string): Promise<URL> {
  const url = validateUrl(value);
  await resolvePublicAddresses(normalizeHostname(url.hostname));
  return url;
}

const safeLookup: LookupFunction = (hostname, options, callback) => {
  void resolvePublicAddresses(hostname).then(
    (records) => options.all
      ? callback(null, records)
      : callback(null, records[0]!.address, records[0]!.family),
    (error: unknown) => callback(error instanceof Error ? error as NodeJS.ErrnoException : new Error(String(error)), '', 0),
  );
};

export async function postWebhook(value: string, body: unknown, headers: Record<string, string>): Promise<{ ok: boolean; status: number }> {
  const url = await validateWebhookUrl(value);
  const dispatcher = new Agent({ connect: { lookup: safeLookup } });
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      dispatcher,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();
    return { ok: response.ok, status: response.status };
  } finally {
    await dispatcher.close();
  }
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true;
  const family = isIP(normalized);
  if (family === 4) return Number(normalized.split('.')[0]) === 127;
  return family === 6 && normalized === '::1';
}

