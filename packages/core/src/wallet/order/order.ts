import {
  OrderStatus,
  OrderSide,
  OrderType,
  TimeInForce,
  OrderEventType,
  ORDER_STATUS_TRANSITIONS,
} from './types';
import type {
  OrderId,
  ClientOrderId,
  VenueOrderId,
  OrderCore,
  OrderEvent,
  OrderTimestamps,
  OrderFilter,
} from './types';

// ---------------------------------------------------------------------------
// Order Class (Nautilus pattern: event-sourced with state machine)
// ---------------------------------------------------------------------------

export class Order {
  private _events: OrderEvent[] = [];
  private _core: OrderCore;

  constructor(core: OrderCore) {
    this._core = { ...core };
  }

  // -- Identity getters --

  get id(): OrderId { return this._core.id; }
  get clientOrderId(): ClientOrderId { return this._core.clientOrderId; }
  get venueOrderId(): VenueOrderId | undefined { return this._core.venueOrderId; }
  get side(): OrderSide { return this._core.side; }
  get orderType(): OrderType { return this._core.orderType; }
  get quantity(): string { return this._core.quantity; }
  get price(): string | undefined { return this._core.price; }
  get triggerPrice(): string | undefined { return this._core.triggerPrice; }
  get filledQty(): string { return this._core.filledQty; }
  get leavesQty(): string { return this._core.leavesQty; }
  get avgPx(): string | undefined { return this._core.avgPx; }
  get status(): OrderStatus { return this._core.status; }
  get timeInForce(): TimeInForce { return this._core.timeInForce; }
  get chainId(): number { return this._core.chainId; }
  get instrumentId(): string { return this._core.instrumentId; }
  get tokenIn(): string | undefined { return this._core.tokenIn; }
  get tokenOut(): string | undefined { return this._core.tokenOut; }
  get txHash(): string | undefined { return this._core.txHash; }
  get timestamps(): OrderTimestamps { return { ...this._core.timestamps }; }
  get events(): ReadonlyArray<OrderEvent> { return [...this._events]; }
  get isBuy(): boolean { return this._core.side === OrderSide.BUY; }
  get isSell(): boolean { return this._core.side === OrderSide.SELL; }
  get isOpen(): boolean {
    return [OrderStatus.SUBMITTED, OrderStatus.ACCEPTED, OrderStatus.PARTIALLY_FILLED]
      .includes(this._core.status);
  }
  get isClosed(): boolean {
    return [OrderStatus.FILLED, OrderStatus.CANCELED, OrderStatus.EXPIRED, OrderStatus.REJECTED, OrderStatus.DENIED]
      .includes(this._core.status);
  }

  // -- Core state machine: apply(event) --

  apply(event: OrderEvent): void {
    const allowed = ORDER_STATUS_TRANSITIONS[this._core.status];
    const nextStatus = this._statusFromEvent(event.type);

    if (nextStatus && !allowed.includes(nextStatus)) {
      throw new Error(
        `Invalid transition: ${this._core.status} -> ${nextStatus} (event: ${event.type})`,
      );
    }

    this._handleEvent(event);
    this._events.push(event);

    if (nextStatus) {
      this._core.status = nextStatus;
    }
  }

  // -- Serialization --

  toCore(): OrderCore {
    return { ...this._core };
  }

  static fromCore(core: OrderCore, events: OrderEvent[] = []): Order {
    const order = new Order(core);
    order._events = [...events];
    return order;
  }

  // -- Event handlers --

  private _handleEvent(event: OrderEvent): void {
    const now = event.timestamp;

    switch (event.type) {
      case OrderEventType.SUBMITTED:
        this._core.timestamps.submittedAt = now;
        break;

      case OrderEventType.ACCEPTED:
        this._core.timestamps.acceptedAt = now;
        this._core.venueOrderId = event.venueOrderId;
        break;

      case OrderEventType.PARTIAL_FILL: {
        const filled = this._addQuantity(this._core.filledQty, event.lastQty);
        const leaves = this._subQuantity(this._core.quantity, filled);
        this._core.filledQty = filled;
        this._core.leavesQty = leaves;
        this._core.avgPx = this._recalcAvgPx(
          this._core.avgPx,
          this._core.filledQty,
          event.lastPx,
          event.lastQty,
        );
        break;
      }

      case OrderEventType.FILLED: {
        const filled = this._addQuantity(this._core.filledQty, event.lastQty);
        const leaves = '0';
        this._core.filledQty = filled;
        this._core.leavesQty = leaves;
        this._core.timestamps.filledAt = now;
        this._core.avgPx = this._recalcAvgPx(
          this._core.avgPx,
          this._core.filledQty,
          event.lastPx,
          event.lastQty,
        );
        break;
      }

      case OrderEventType.CANCELED:
        this._core.timestamps.canceledAt = now;
        break;

      case OrderEventType.REJECTED:
      case OrderEventType.DENIED:
        break;

      default:
        break;
    }
  }

  private _statusFromEvent(type: OrderEventType): OrderStatus | null {
    switch (type) {
      case OrderEventType.INITIALIZED: return OrderStatus.INITIALIZED;
      case OrderEventType.SUBMITTED: return OrderStatus.SUBMITTED;
      case OrderEventType.ACCEPTED: return OrderStatus.ACCEPTED;
      case OrderEventType.PARTIAL_FILL: return OrderStatus.PARTIALLY_FILLED;
      case OrderEventType.FILLED: return OrderStatus.FILLED;
      case OrderEventType.CANCELED: return OrderStatus.CANCELED;
      case OrderEventType.EXPIRED: return OrderStatus.EXPIRED;
      case OrderEventType.REJECTED: return OrderStatus.REJECTED;
      case OrderEventType.DENIED: return OrderStatus.DENIED;
      case OrderEventType.PENDING_CANCEL: return null;
      case OrderEventType.CANCEL_REJECTED: return null;
    }
  }

  // -- Quantity arithmetic helpers --

  private _addQuantity(a: string, b: string): string {
    return (parseFloat(a) + parseFloat(b)).toString();
  }

  private _subQuantity(a: string, b: string): string {
    return Math.max(0, parseFloat(a) - parseFloat(b)).toString();
  }

  private _recalcAvgPx(
    currentAvgPx: string | undefined,
    totalFilled: string,
    lastPx: string,
    lastQty: string,
  ): string {
    if (!currentAvgPx) return lastPx;

    const prevFilled = parseFloat(totalFilled) - parseFloat(lastQty);
    if (prevFilled <= 0) return lastPx;

    const prevValue = prevFilled * parseFloat(currentAvgPx);
    const lastValue = parseFloat(lastQty) * parseFloat(lastPx);
    return ((prevValue + lastValue) / parseFloat(totalFilled)).toString();
  }
}

// ---------------------------------------------------------------------------
// Order Factory (Nautilus pattern: centralized order creation)
// ---------------------------------------------------------------------------

let _nextOrderId = 0;

export function createOrder(params: {
  side: OrderSide;
  orderType: OrderType;
  quantity: string;
  price?: string;
  triggerPrice?: string;
  timeInForce?: TimeInForce;
  chainId: number;
  instrumentId: string;
  tokenIn?: string;
  tokenOut?: string;
  clientOrderId?: string;
}): Order {
  const now = Date.now();
  const clientOrderId = params.clientOrderId || `order-${++_nextOrderId}-${now}`;

  const core: OrderCore = {
    id: `oid-${clientOrderId}` as OrderId,
    clientOrderId: clientOrderId as ClientOrderId,
    side: params.side,
    orderType: params.orderType,
    quantity: params.quantity,
    price: params.price,
    triggerPrice: params.triggerPrice,
    filledQty: '0',
    leavesQty: params.quantity,
    status: OrderStatus.INITIALIZED,
    timeInForce: params.timeInForce || TimeInForce.GTC,
    chainId: params.chainId,
    instrumentId: params.instrumentId,
    tokenIn: params.tokenIn as any,
    tokenOut: params.tokenOut as any,
    timestamps: { createdAt: now },
  };

  const order = new Order(core);
  order.apply({
    type: OrderEventType.INITIALIZED,
    orderId: core.id,
    clientOrderId: core.clientOrderId,
    timestamp: now,
  });

  return order;
}
