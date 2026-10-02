import { providers } from './providers.js';
import type { Exchange } from '../services/websocket/types.js';

export function resolveExchangeWebSocketUrl(exchange: Exchange, fallbackUrl: string): string {
  return providers.exchangeUrls?.[exchange] ?? fallbackUrl;
}

