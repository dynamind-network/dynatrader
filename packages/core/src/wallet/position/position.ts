import { PositionSide, PositionStatus, PositionEventType } from './types';
import type {
  PositionId,
  PositionCore,
  PositionEvent,
  PositionSnapshot,
} from './types';
import type { OrderFilledEvent, OrderSide } from '../order/types';

// ---------------------------------------------------------------------------
// Position Class (Nautilus pattern: event-sourced with PnL calculations)
// ---------------------------------------------------------------------------

export class Position {
  private _events: PositionEvent[] = [];
  private _core: PositionCore;

  constructor(core: PositionCore) {
    this._core = { ...core };
  }

  // -- Identity getters --

  get id(): PositionId { return this._core.id; }
  get symbol(): string { return this._core.symbol; }
  get chainId(): number { return this._core.chainId; }
  get instrumentId(): string { return this._core.instrumentId; }
  get side(): PositionSide { return this._core.side; }
  get status(): PositionStatus { return this._core.status; }
  get quantity(): string { return this._core.quantity; }
  get signedQty(): number { return this._core.signedQty; }
  get peakQty(): string { return this._core.peakQty; }
  get avgPxOpen(): string { return this._core.avgPxOpen; }
  get avgPxClose(): string | undefined { return this._core.avgPxClose; }
  get realizedReturn(): number | undefined { return this._core.realizedReturn; }
  get realizedPnl(): string | undefined { return this._core.realizedPnl; }
  get buyQty(): string { return this._core.buyQty; }
  get sellQty(): string { return this._core.sellQty; }
  get commissions(): Record<string, string> { return { ...this._core.commissions }; }
  get openedAt(): number { return this._core.openedAt; }
  get closedAt(): number | undefined { return this._core.closedAt; }
  get lastUpdatedAt(): number { return this._core.lastUpdatedAt; }
  get events(): ReadonlyArray<PositionEvent> { return [...this._events]; }
  get isOpen(): boolean { return this._core.status === PositionStatus.OPEN; }
  get isClosed(): boolean { return this._core.status === PositionStatus.CLOSED; }
  get isLong(): boolean { return this._core.side === PositionSide.LONG; }
  get isShort(): boolean { return this._core.side === PositionSide.SHORT; }
  get isFlat(): boolean { return this._core.side === PositionSide.FLAT; }

  // -- Core state machine: apply(fill) --

  applyFill(fill: OrderFilledEvent): void {
    const now = fill.timestamp;

    if (this._core.status === PositionStatus.CLOSED) {
      throw new Error(`Cannot apply fill to closed position ${this._core.id}`);
    }

    if (!this.isOpen) {
      this._openPosition(fill, now);
    } else {
      this._updatePosition(fill, now);
    }

    this._core.lastUpdatedAt = now;
  }

  // -- PnL Calculations (Nautilus pattern) --

  unrealizedPnl(lastPrice: string): number {
    const qty = parseFloat(this._core.quantity);
    const avgOpen = parseFloat(this._core.avgPxOpen);
    const last = parseFloat(lastPrice);

    if (this.isLong) {
      return qty * (last - avgOpen);
    } else {
      return qty * (avgOpen - last);
    }
  }

  totalPnl(lastPrice: string): number {
    const unrealized = this.unrealizedPnl(lastPrice);
    const realized = this._core.realizedPnl ? parseFloat(this._core.realizedPnl) : 0;
    return realized + unrealized;
  }

  notionalValue(price: string): number {
    return parseFloat(this._core.quantity) * parseFloat(price);
  }

  // -- Snapshot --

  snapshot(currentPrice?: string): PositionSnapshot {
    return {
      id: this._core.id,
      symbol: this._core.symbol,
      chainId: this._core.chainId,
      side: this._core.side,
      quantity: this._core.quantity,
      avgPxOpen: this._core.avgPxOpen,
      currentPrice,
      unrealizedPnl: currentPrice ? this.unrealizedPnl(currentPrice).toString() : undefined,
      realizedPnl: this._core.realizedPnl,
      openedAt: this._core.openedAt,
      lastUpdatedAt: this._core.lastUpdatedAt,
    };
  }

  // -- Serialization --

  toCore(): PositionCore {
    return { ...this._core };
  }

  static fromCore(core: PositionCore, events: PositionEvent[] = []): Position {
    const pos = new Position(core);
    pos._events = [...events];
    return pos;
  }

  // -- Internal position management --

  private _openPosition(fill: OrderFilledEvent, now: number): void {
    const side = this._sideFromOrder(fill.side);
    const qty = parseFloat(fill.lastQty);

    this._core.side = side;
    this._core.status = PositionStatus.OPEN;
    this._core.quantity = fill.lastQty;
    this._core.signedQty = side === PositionSide.LONG ? qty : -qty;
    this._core.peakQty = fill.lastQty;
    this._core.avgPxOpen = fill.lastPx;
    this._core.buyQty = fill.side === 'BUY' ? fill.lastQty : '0';
    this._core.sellQty = fill.side === 'SELL' ? fill.lastQty : '0';
    this._core.openedAt = now;
    this._core.lastUpdatedAt = now;

    if (fill.commission) {
      this._core.commissions[fill.tradeId] = fill.commission;
    }

    const event: PositionEvent = {
      type: PositionEventType.OPENED,
      positionId: this._core.id,
      timestamp: now,
      fill,
    };
    this._events.push(event);
  }

  private _updatePosition(fill: OrderFilledEvent, now: number): void {
    const prevQty = parseFloat(this._core.quantity);
    const fillQty = parseFloat(fill.lastQty);
    const isLong = this.isLong;

    let newQty: number;
    let isClosing = false;

    if (fill.side === (isLong ? 'SELL' : 'BUY')) {
      newQty = prevQty - fillQty;
      if (newQty <= 0) {
        isClosing = true;
        newQty = 0;
      }
    } else {
      newQty = prevQty + fillQty;
    }

    if (isClosing) {
      this._closePosition(fill, now, newQty === 0 ? prevQty : fillQty);
    } else {
      this._partialFill(fill, now, newQty);
    }
  }

  private _partialFill(fill: OrderFilledEvent, now: number, newQty: number): void {
    const isLong = this.isLong;
    const prevQty = parseFloat(this._core.quantity);
    const fillQty = parseFloat(fill.lastQty);

    // Recalculate average entry price
    const prevValue = prevQty * parseFloat(this._core.avgPxOpen);
    const fillValue = fillQty * parseFloat(fill.lastPx);
    const newAvgPx = ((prevValue + fillValue) / newQty).toString();

    this._core.quantity = newQty.toString();
    this._core.signedQty = isLong ? newQty : -newQty;
    this._core.avgPxOpen = newAvgPx;

    if (newQty > parseFloat(this._core.peakQty)) {
      this._core.peakQty = newQty.toString();
    }

    if (fill.side === 'BUY') {
      this._core.buyQty = (parseFloat(this._core.buyQty) + fillQty).toString();
    } else {
      this._core.sellQty = (parseFloat(this._core.sellQty) + fillQty).toString();
    }

    if (fill.commission) {
      this._core.commissions[fill.tradeId] = fill.commission;
    }

    this._core.lastUpdatedAt = now;
  }

  private _closePosition(fill: OrderFilledEvent, now: number, closeQty: number): void {
    const isLong = this.isLong;
    const avgPxOpen = parseFloat(this._core.avgPxOpen);
    const avgPxClose = parseFloat(fill.lastPx);

    // Calculate realized PnL
    const points = isLong ? avgPxClose - avgPxOpen : avgPxOpen - avgPxClose;
    const realizedPnl = (closeQty * points).toString();
    const realizedReturn = avgPxOpen > 0 ? points / avgPxOpen : 0;

    this._core.quantity = '0';
    this._core.signedQty = 0;
    this._core.avgPxClose = fill.lastPx;
    this._core.realizedPnl = realizedPnl;
    this._core.realizedReturn = realizedReturn;
    this._core.status = PositionStatus.CLOSED;
    this._core.closedAt = now;
    this._core.lastUpdatedAt = now;

    if (fill.commission) {
      this._core.commissions[fill.tradeId] = fill.commission;
    }

    const event: PositionEvent = {
      type: PositionEventType.CLOSED,
      positionId: this._core.id,
      timestamp: now,
      fill,
      realizedPnl,
    };
    this._events.push(event);
  }

  private _sideFromOrder(side: OrderSide): PositionSide {
    return side === 'BUY' ? PositionSide.LONG : PositionSide.SHORT;
  }
}
