// WebSocket Multi-Exchange Service
// Provides real-time normalized data from 10 major perpetual exchanges

export * from './types.js';
export * from './manager.js';
export * from './baseAdapter.js';

// Exchange Adapters
export { BinanceAdapter } from './exchanges/binance.js';
export { BybitAdapter } from './exchanges/bybit.js';
export { OkxAdapter } from './exchanges/okx.js';
export { BitgetAdapter } from './exchanges/bitget.js';
export { HyperliquidAdapter } from './exchanges/hyperliquid.js';
export { DydxAdapter } from './exchanges/dydx.js';
export { KrakenAdapter } from './exchanges/kraken.js';
export { GmxAdapter } from './exchanges/gmx.js';
export { GateAdapter } from './exchanges/gate.js';

