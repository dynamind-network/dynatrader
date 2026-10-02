import type { Address } from 'viem';
import type { SupportedChainId } from '../types';
import type { OrderSide, OrderId, TradeId, OrderFilledEvent } from '../order/types';

// ---------------------------------------------------------------------------
// Branded Identifiers
// ---------------------------------------------------------------------------

export type PositionId = string & { readonly __brand: 'PositionId' };
export const createPositionId = (id: string): PositionId => id as PositionId;

// ---------------------------------------------------------------------------
// Position Enums
// ---------------------------------------------------------------------------

export enum PositionSide {
  FLAT = 'FLAT',
  LONG = 'LONG',
  SHORT = 'SHORT',
}

export enum PositionStatus {
  OPEN = 'OPEN',
  CLOSED = 'CLOSED',
}

// ---------------------------------------------------------------------------
// Position Types
// ---------------------------------------------------------------------------

export interface PositionCore {
  id: PositionId;
  symbol: string;
  chainId: SupportedChainId;
  instrumentId: string;
  tokenIn?: Address;
  tokenOut?: Address;
  side: PositionSide;
  status: PositionStatus;
  quantity: string;
  signedQty: number;
  peakQty: string;
  avgPxOpen: string;
  avgPxClose?: string;
  realizedReturn?: number;
  realizedPnl?: string;
  buyQty: string;
  sellQty: string;
  commissions: Record<string, string>;
  openedAt: number;
  closedAt?: number;
  lastUpdatedAt: number;
}

// ---------------------------------------------------------------------------
// Position Events
// ---------------------------------------------------------------------------

export enum PositionEventType {
  OPENED = 'PositionOpened',
  CHANGED = 'PositionChanged',
  CLOSED = 'PositionClosed',
}

export interface PositionEventBase {
  type: PositionEventType;
  positionId: PositionId;
  timestamp: number;
}

export interface PositionOpenedEvent extends PositionEventBase {
  type: PositionEventType.OPENED;
  fill: OrderFilledEvent;
}

export interface PositionChangedEvent extends PositionEventBase {
  type: PositionEventType.CHANGED;
  fill: OrderFilledEvent;
  previousQty: string;
  newQty: string;
}

export interface PositionClosedEvent extends PositionEventBase {
  type: PositionEventType.CLOSED;
  fill: OrderFilledEvent;
  realizedPnl: string;
}

export type PositionEvent =
  | PositionOpenedEvent
  | PositionChangedEvent
  | PositionClosedEvent;

// ---------------------------------------------------------------------------
// Position Query Filters
// ---------------------------------------------------------------------------

export interface PositionFilter {
  status?: PositionStatus | PositionStatus[];
  side?: PositionSide;
  symbol?: string;
  chainId?: SupportedChainId;
}

// ---------------------------------------------------------------------------
// Position Snapshot (for portfolio tracking)
// ---------------------------------------------------------------------------

export interface PositionSnapshot {
  id: PositionId;
  symbol: string;
  chainId: SupportedChainId;
  side: PositionSide;
  quantity: string;
  avgPxOpen: string;
  currentPrice?: string;
  unrealizedPnl?: string;
  realizedPnl?: string;
  openedAt: number;
  lastUpdatedAt: number;
}
