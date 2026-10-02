import { OrderSide, OrderType, TimeInForce, OrderEventType } from '../../wallet/order/types';
import type { OrderId, ClientOrderId, OrderEvent, OrderFilledEvent } from '../../wallet/order/types';
import type { OrderParams } from '../../wallet/order/types';
import { createOrder } from '../../wallet/order/order';
import type { PositionId } from '../../wallet/position/types';
import type { PositionEvent } from '../../wallet/position/types';

// ---------------------------------------------------------------------------
// Strategy State (Nautilus pattern: component lifecycle)
// ---------------------------------------------------------------------------

export enum StrategyState {
  REGISTERED = 'REGISTERED',
  READY = 'READY',
  RUNNING = 'RUNNING',
  STOPPED = 'STOPPED',
  DISPOSED = 'DISPOSED',
  DEGRADED = 'DEGRADED',
  FAULTED = 'FAULTED',
}

// ---------------------------------------------------------------------------
// Strategy Base Class (Nautilus pattern: lifecycle hooks)
// ---------------------------------------------------------------------------

export abstract class Strategy {
  private _state: StrategyState = StrategyState.REGISTERED;
  private _strategyId: string;
  private _orders = new Map<ClientOrderId, any>();
  private _positions = new Map<PositionId, any>();

  constructor(strategyId: string) {
    this._strategyId = strategyId;
  }

  // -- Identity --

  get strategyId(): string { return this._strategyId; }
  get state(): StrategyState { return this._state; }
  get isReady(): boolean { return this._state === StrategyState.READY; }
  get isRunning(): boolean { return this._state === StrategyState.RUNNING; }
  get isStopped(): boolean { return this._state === StrategyState.STOPPED; }

  // -- Lifecycle Hooks (override these) --

  on_start(): void { }
  on_stop(): void { }
  on_resume(): void { }
  on_reset(): void { }
  on_dispose(): void { }
  on_degrade(): void { }
  on_fault(): void { }

  // -- Market Data Hooks (override these) --

  on_quote(quote: QuoteTick): void { }
  on_bar(bar: Bar): void { }
  on_trade(trade: TradeTick): void { }
  on_book(book: OrderBook): void { }

  // -- Order Event Hooks (override these) --

  on_order_initialized(event: OrderEvent): void { }
  on_order_submitted(event: OrderEvent): void { }
  on_order_accepted(event: OrderEvent): void { }
  on_order_filled(event: OrderFilledEvent): void { }
  on_order_canceled(event: OrderEvent): void { }
  on_order_rejected(event: OrderEvent): void { }
  on_order_expired(event: OrderEvent): void { }

  // -- Position Event Hooks (override these) --

  on_position_opened(event: PositionEvent): void { }
  on_position_changed(event: PositionEvent): void { }
  on_position_closed(event: PositionEvent): void { }

  // -- State Management --

  start(): void {
    if (this._state !== StrategyState.READY && this._state !== StrategyState.REGISTERED) {
      throw new Error(`Cannot start strategy in state ${this._state}`);
    }
    this._state = StrategyState.RUNNING;
    this.on_start();
  }

  stop(): void {
    if (this._state !== StrategyState.RUNNING) {
      throw new Error(`Cannot stop strategy in state ${this._state}`);
    }
    this._state = StrategyState.STOPPED;
    this.on_stop();
  }

  resume(): void {
    if (this._state !== StrategyState.STOPPED) {
      throw new Error(`Cannot resume strategy in state ${this._state}`);
    }
    this._state = StrategyState.RUNNING;
    this.on_resume();
  }

  reset(): void {
    this._state = StrategyState.READY;
    this._orders.clear();
    this._positions.clear();
    this.on_reset();
  }

  dispose(): void {
    this._state = StrategyState.DISPOSED;
    this.on_dispose();
  }

  degrade(): void {
    this._state = StrategyState.DEGRADED;
    this.on_degrade();
  }

  fault(): void {
    this._state = StrategyState.FAULTED;
    this.on_fault();
  }

  // -- Order Management --

  submitOrder(params: OrderParams): any {
    if (!this.isRunning) {
      throw new Error('Strategy must be running to submit orders');
    }

    const order = createOrder(params);
    this._orders.set(order.clientOrderId, order);

    this.on_order_initialized({
      type: OrderEventType.INITIALIZED,
      orderId: order.id,
      clientOrderId: order.clientOrderId,
      timestamp: Date.now(),
    });

    return order;
  }

  cancelOrder(clientOrderId: ClientOrderId): void {
    const order = this._orders.get(clientOrderId);
    if (!order) {
      throw new Error(`Order ${clientOrderId} not found`);
    }

    this.on_order_canceled({
      type: OrderEventType.CANCELED,
      orderId: order.id,
      clientOrderId: order.clientOrderId,
      timestamp: Date.now(),
    });
  }

  cancelAllOrders(): void {
    for (const [clientOrderId] of this._orders) {
      this.cancelOrder(clientOrderId);
    }
  }

  // -- Event Dispatch --

  handleOrderEvent(event: OrderEvent): void {
    switch (event.type) {
      case OrderEventType.INITIALIZED:
        this.on_order_initialized(event);
        break;
      case OrderEventType.SUBMITTED:
        this.on_order_submitted(event);
        break;
      case OrderEventType.ACCEPTED:
        this.on_order_accepted(event);
        break;
      case OrderEventType.FILLED:
        this.on_order_filled(event as OrderFilledEvent);
        break;
      case OrderEventType.CANCELED:
        this.on_order_canceled(event);
        break;
      case OrderEventType.REJECTED:
        this.on_order_rejected(event);
        break;
      case OrderEventType.EXPIRED:
        this.on_order_expired(event);
        break;
    }
  }

  handlePositionEvent(event: PositionEvent): void {
    switch (event.type) {
      case 'PositionOpened':
        this.on_position_opened(event);
        break;
      case 'PositionChanged':
        this.on_position_changed(event);
        break;
      case 'PositionClosed':
        this.on_position_closed(event);
        break;
    }
  }

  // -- Data Types (simplified for DeFi context) --

  protected get orders(): ReadonlyMap<ClientOrderId, any> {
    return this._orders;
  }

  protected get positions(): ReadonlyMap<PositionId, any> {
    return this._positions;
  }
}

// ---------------------------------------------------------------------------
// Data Types (simplified for strategy hooks)
// ---------------------------------------------------------------------------

export interface QuoteTick {
  symbol: string;
  bid: string;
  ask: string;
  timestamp: number;
}

export interface Bar {
  symbol: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  timestamp: number;
}

export interface TradeTick {
  symbol: string;
  price: string;
  quantity: string;
  side: 'BUY' | 'SELL';
  timestamp: number;
}

export interface OrderBook {
  symbol: string;
  bids: Array<{ price: string; quantity: string }>;
  asks: Array<{ price: string; quantity: string }>;
  timestamp: number;
}
