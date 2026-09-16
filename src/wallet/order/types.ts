import type { Hex, Address } from 'viem';
import type { SupportedChainId } from '../types';

// ---------------------------------------------------------------------------
// Branded Identifiers (Nautilus pattern)
// ---------------------------------------------------------------------------

export type OrderId = string & { readonly __brand: 'OrderId' };
export type ClientOrderId = string & { readonly __brand: 'ClientOrderId' };
export type VenueOrderId = string & { readonly __brand: 'VenueOrderId' };
export type TradeId = string & { readonly __brand: 'TradeId' };

export const createOrderId = (id: string): OrderId => id as OrderId;
export const createClientOrderId = (id: string): ClientOrderId => id as ClientOrderId;
export const createVenueOrderId = (id: string): VenueOrderId => id as VenueOrderId;
export const createTradeId = (id: string): TradeId => id as TradeId;

// ---------------------------------------------------------------------------
// Order Side & Type
// ---------------------------------------------------------------------------

export enum OrderSide {
  BUY = 'BUY',
  SELL = 'SELL',
}

export enum OrderType {
  MARKET = 'MARKET',
  LIMIT = 'LIMIT',
  STOP_MARKET = 'STOP_MARKET',
  STOP_LIMIT = 'STOP_LIMIT',
}

export enum TimeInForce {
  GTC = 'GTC',
  IOC = 'IOC',
  FOK = 'FOK',
  GTD = 'GTD',
}

// ---------------------------------------------------------------------------
// Order Status State Machine (Nautilus pattern)
// ---------------------------------------------------------------------------

export enum OrderStatus {
  INITIALIZED = 'INITIALIZED',
  SUBMITTED = 'SUBMITTED',
  ACCEPTED = 'ACCEPTED',
  PARTIALLY_FILLED = 'PARTIALLY_FILLED',
  FILLED = 'FILLED',
  CANCELED = 'CANCELED',
  EXPIRED = 'EXPIRED',
  REJECTED = 'REJECTED',
  DENIED = 'DENIED',
}

export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.INITIALIZED]: [OrderStatus.SUBMITTED, OrderStatus.DENIED],
  [OrderStatus.SUBMITTED]: [OrderStatus.ACCEPTED, OrderStatus.REJECTED, OrderStatus.CANCELED],
  [OrderStatus.ACCEPTED]: [
    OrderStatus.PARTIALLY_FILLED,
    OrderStatus.FILLED,
    OrderStatus.CANCELED,
    OrderStatus.EXPIRED,
  ],
  [OrderStatus.PARTIALLY_FILLED]: [
    OrderStatus.FILLED,
    OrderStatus.CANCELED,
  ],
  [OrderStatus.FILLED]: [],
  [OrderStatus.CANCELED]: [],
  [OrderStatus.EXPIRED]: [],
  [OrderStatus.REJECTED]: [],
  [OrderStatus.DENIED]: [],
};

// ---------------------------------------------------------------------------
// Order Core (shared state for all orders)
// ---------------------------------------------------------------------------

export interface OrderCore {
  id: OrderId;
  clientOrderId: ClientOrderId;
  venueOrderId?: VenueOrderId;
  side: OrderSide;
  orderType: OrderType;
  quantity: string;
  price?: string;
  triggerPrice?: string;
  filledQty: string;
  leavesQty: string;
  avgPx?: string;
  status: OrderStatus;
  timeInForce: TimeInForce;
  chainId: SupportedChainId;
  instrumentId: string;
  tokenIn?: Address;
  tokenOut?: Address;
  txHash?: Hex;
  timestamps: OrderTimestamps;
}

export interface OrderTimestamps {
  createdAt: number;
  submittedAt?: number;
  acceptedAt?: number;
  filledAt?: number;
  canceledAt?: number;
}

// ---------------------------------------------------------------------------
// Order Events (18 types from Nautilus)
// ---------------------------------------------------------------------------

export enum OrderEventType {
  INITIALIZED = 'OrderInitialized',
  SUBMITTED = 'OrderSubmitted',
  ACCEPTED = 'OrderAccepted',
  PARTIAL_FILL = 'OrderPartialFill',
  FILLED = 'OrderFilled',
  CANCELED = 'OrderCanceled',
  EXPIRED = 'OrderExpired',
  REJECTED = 'OrderRejected',
  DENIED = 'OrderDenied',
  PENDING_CANCEL = 'OrderPendingCancel',
  CANCEL_REJECTED = 'OrderCancelRejected',
}

export interface OrderEventBase {
  type: OrderEventType;
  orderId: OrderId;
  clientOrderId: ClientOrderId;
  timestamp: number;
}

export interface OrderInitializedEvent extends OrderEventBase {
  type: OrderEventType.INITIALIZED;
}

export interface OrderSubmittedEvent extends OrderEventBase {
  type: OrderEventType.SUBMITTED;
}

export interface OrderAcceptedEvent extends OrderEventBase {
  type: OrderEventType.ACCEPTED;
  venueOrderId: VenueOrderId;
}

export interface OrderPartialFillEvent extends OrderEventBase {
  type: OrderEventType.PARTIAL_FILL;
  lastQty: string;
  lastPx: string;
  tradeId: TradeId;
}

export interface OrderFilledEvent extends OrderEventBase {
  type: OrderEventType.FILLED;
  side: OrderSide;
  lastQty: string;
  lastPx: string;
  tradeId: TradeId;
  commission?: string;
}

export interface OrderCanceledEvent extends OrderEventBase {
  type: OrderEventType.CANCELED;
  reason?: string;
}

export interface OrderExpiredEvent extends OrderEventBase {
  type: OrderEventType.EXPIRED;
}

export interface OrderRejectedEvent extends OrderEventBase {
  type: OrderEventType.REJECTED;
  reason: string;
}

export interface OrderDeniedEvent extends OrderEventBase {
  type: OrderEventType.DENIED;
  reason: string;
}

export interface OrderPendingCancelEvent extends OrderEventBase {
  type: OrderEventType.PENDING_CANCEL;
}

export interface OrderCancelRejectedEvent extends OrderEventBase {
  type: OrderEventType.CANCEL_REJECTED;
  reason: string;
}

export type OrderEvent =
  | OrderInitializedEvent
  | OrderSubmittedEvent
  | OrderAcceptedEvent
  | OrderPartialFillEvent
  | OrderFilledEvent
  | OrderCanceledEvent
  | OrderExpiredEvent
  | OrderRejectedEvent
  | OrderDeniedEvent
  | OrderPendingCancelEvent
  | OrderCancelRejectedEvent;

// ---------------------------------------------------------------------------
// Order Creation Params
// ---------------------------------------------------------------------------

export interface OrderParams {
  side: OrderSide;
  orderType: OrderType;
  quantity: string;
  price?: string;
  triggerPrice?: string;
  timeInForce?: TimeInForce;
  chainId: SupportedChainId;
  instrumentId: string;
  tokenIn?: Address;
  tokenOut?: Address;
  clientOrderId?: ClientOrderId;
}

// ---------------------------------------------------------------------------
// Order Query Filters
// ---------------------------------------------------------------------------

export interface OrderFilter {
  status?: OrderStatus | OrderStatus[];
  side?: OrderSide;
  chainId?: SupportedChainId;
  instrumentId?: string;
}
