import { Position } from './position';
import { PositionSide, PositionStatus, PositionEventType } from './types';
import type { PositionId, PositionCore, PositionFilter, PositionEvent } from './types';
import type { OrderFilledEvent } from '../order/types';

// ---------------------------------------------------------------------------
// Position Manager (CRUD + event sourcing for positions)
// ---------------------------------------------------------------------------

export class PositionManager {
  private _positions = new Map<PositionId, Position>();
  private _indexBySymbol = new Map<string, Set<PositionId>>();
  private _indexByStatus = new Map<PositionStatus, Set<PositionId>>();
  private _listeners: Array<(event: PositionEvent) => void> = [];

  constructor() {
    this._indexByStatus.set(PositionStatus.OPEN, new Set());
    this._indexByStatus.set(PositionStatus.CLOSED, new Set());
  }

  // -- CRUD Operations --

  get(id: PositionId): Position | undefined {
    return this._positions.get(id);
  }

  list(filter?: PositionFilter): Position[] {
    let results = Array.from(this._positions.values());

    if (filter) {
      if (filter.status) {
        const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
        results = results.filter(p => statuses.includes(p.status));
      }
      if (filter.side) {
        results = results.filter(p => p.side === filter.side);
      }
      if (filter.symbol) {
        results = results.filter(p => p.symbol === filter.symbol);
      }
      if (filter.chainId !== undefined) {
        results = results.filter(p => p.chainId === filter.chainId);
      }
    }

    return results;
  }

  openPositions(filter?: Omit<PositionFilter, 'status'>): Position[] {
    return this.list({ ...filter, status: PositionStatus.OPEN });
  }

  closedPositions(filter?: Omit<PositionFilter, 'status'>): Position[] {
    return this.list({ ...filter, status: PositionStatus.CLOSED });
  }

  // -- Position Lifecycle --

  onFill(fill: OrderFilledEvent, symbol: string, chainId: number, instrumentId: string): Position {
    const existing = this._findOpenPosition(symbol, chainId, instrumentId);

    if (existing) {
      existing.applyFill(fill);
      if (existing.isClosed) {
        this._updateIndex(existing, PositionStatus.OPEN, PositionStatus.CLOSED);
      }
      this._emit(fill.type === 'OrderFilled'
        ? {
            type: PositionEventType.CHANGED,
            positionId: existing.id,
            timestamp: fill.timestamp,
            fill,
            previousQty: existing.quantity,
            newQty: existing.quantity,
          }
        : {
            type: PositionEventType.CLOSED,
            positionId: existing.id,
            timestamp: fill.timestamp,
            fill,
            realizedPnl: existing.realizedPnl || '0',
          }
      );
      return existing;
    }

    const position = this._createPosition(fill, symbol, chainId, instrumentId);
    return position;
  }

  // -- Query Helpers --

  netPosition(symbol: string, chainId: number): number {
    const positions = this.openPositions({ symbol, chainId });
    let net = 0;
    for (const pos of positions) {
      net += pos.signedQty;
    }
    return net;
  }

  isNetLong(symbol: string, chainId: number): boolean {
    return this.netPosition(symbol, chainId) > 0;
  }

  isNetShort(symbol: string, chainId: number): boolean {
    return this.netPosition(symbol, chainId) < 0;
  }

  isNetFlat(symbol: string, chainId: number): boolean {
    return this.netPosition(symbol, chainId) === 0;
  }

  totalExposure(): number {
    let total = 0;
    for (const pos of this.openPositions()) {
      total += parseFloat(pos.quantity);
    }
    return total;
  }

  // -- Serialization --

  toSnapshots(): Array<{
    id: PositionId;
    symbol: string;
    chainId: number;
    side: PositionSide;
    quantity: string;
    avgPxOpen: string;
    status: PositionStatus;
    openedAt: number;
    closedAt?: number;
  }> {
    return Array.from(this._positions.values()).map(p => ({
      id: p.id,
      symbol: p.symbol,
      chainId: p.chainId,
      side: p.side,
      quantity: p.quantity,
      avgPxOpen: p.avgPxOpen,
      status: p.status,
      openedAt: p.openedAt,
      closedAt: p.closedAt,
    }));
  }

  // -- Event Listeners --

  onEvent(listener: (event: PositionEvent) => void): () => void {
    this._listeners.push(listener);
    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx >= 0) this._listeners.splice(idx, 1);
    };
  }

  // -- Internal Helpers --

  private _findOpenPosition(symbol: string, chainId: number, instrumentId: string): Position | undefined {
    for (const pos of this.openPositions()) {
      if (pos.symbol === symbol && pos.chainId === chainId && pos.instrumentId === instrumentId) {
        return pos;
      }
    }
    return undefined;
  }

  private _createPosition(
    fill: OrderFilledEvent,
    symbol: string,
    chainId: number,
    instrumentId: string,
  ): Position {
    const id = `pos-${symbol}-${chainId}-${fill.timestamp}` as PositionId;

    const core: PositionCore = {
      id,
      symbol,
      chainId,
      instrumentId,
      side: PositionSide.FLAT,
      status: PositionStatus.OPEN,
      quantity: '0',
      signedQty: 0,
      peakQty: '0',
      avgPxOpen: '0',
      buyQty: '0',
      sellQty: '0',
      commissions: {},
      openedAt: fill.timestamp,
      lastUpdatedAt: fill.timestamp,
    };

    const position = new Position(core);
    position.applyFill(fill);

    this._positions.set(id, position);
    this._indexBySymbol.get(symbol)?.add(id) || this._indexBySymbol.set(symbol, new Set([id]));
    this._indexByStatus.get(PositionStatus.OPEN)?.add(id);

    this._emit({
      type: PositionEventType.OPENED,
      positionId: id,
      timestamp: fill.timestamp,
      fill,
    });

    return position;
  }

  private _updateIndex(position: Position, from: PositionStatus, to: PositionStatus): void {
    this._indexByStatus.get(from)?.delete(position.id);
    this._indexByStatus.get(to)?.add(position.id);
  }

  private _emit(event: PositionEvent): void {
    for (const listener of this._listeners) {
      try {
        listener(event);
      } catch {
        // Listener errors should not break position management
      }
    }
  }
}
