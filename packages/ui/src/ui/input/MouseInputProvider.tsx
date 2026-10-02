import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Box, measureElement, type DOMElement, useInput } from '@dynatrader/ink/terminal';
import type { MouseInputBus, MouseInputEvent } from './mouse-input.js';
import { clearTerminalSelection, finishTerminalSelection, selectTerminalLine, selectTerminalWord, startTerminalSelection, updateTerminalSelection } from '@dynatrader/ink/terminal';
import { spawn } from 'node:child_process';
import { createSelectionRedrawScheduler } from './selection-redraw.js';

type RegionHandlers = {
  onClick?: (event: MouseInputEvent) => void;
  onWheel?: (direction: 'up' | 'down' | 'left' | 'right', event: MouseInputEvent) => void;
};
type Region = { node: DOMElement; handlers: RegionHandlers; order: number };
type MouseContextValue = { bus: MouseInputBus; regions: Map<string, Region>; nextOrder: { value: number } };
const MouseContext = createContext<MouseContextValue | null>(null);

function getRect(node: DOMElement) {
  let left = 0;
  let top = 0;
  let current: DOMElement | undefined = node;
  while (current) {
    left += current.yogaNode?.getComputedLeft() ?? 0;
    top += current.yogaNode?.getComputedTop() ?? 0;
    current = current.parentNode;
  }
  const { width, height } = measureElement(node);
  return { left, top, right: left + width, bottom: top + height };
}

export function MouseInputProvider({ bus, children }: { bus: MouseInputBus; children?: React.ReactNode }) {
  const regions = useRef(new Map<string, Region>());
  const order = useRef({ value: 0 });
  const [, redrawSelection] = useState(0);
  const pointer = useRef<{ x: number; y: number; dragged: boolean; clickCount: number } | null>(null);
  const lastClick = useRef<{ x: number; y: number; at: number; count: number } | null>(null);
  const selectionRedraw = useMemo(
    () => createSelectionRedrawScheduler(() => redrawSelection((n) => n + 1)),
    [],
  );
  const value = useMemo(() => ({ bus, regions: regions.current, nextOrder: order.current }), [bus]);

  useInput((_input, key) => {
    if (key.escape) {
      pointer.current = null;
      selectionRedraw.cancel();
      clearTerminalSelection();
      redrawSelection((n) => n + 1);
    }
  });

  useEffect(() => {
    process.stdout.write('\u001b[?1002h\u001b[?1006h\u001b[?1004h');
    return () => {
      selectionRedraw.cancel();
      pointer.current = null;
      clearTerminalSelection();
      process.stdout.write('\u001b[?1002l\u001b[?1006l\u001b[?1004l');
    };
  }, [bus, selectionRedraw]);

  useEffect(() => {
    const route = (event: MouseInputEvent) => {
      if (event.kind === 'focus') {
        if (event.focused) process.stdout.write('\u001b[?1002h\u001b[?1006h\u001b[?1004h');
        else if (pointer.current) {
          finishTerminalSelection();
          pointer.current = null;
          clearTerminalSelection();
          selectionRedraw.flush(true);
        }
        return;
      }
      if (event.kind === 'press' && event.button === 0) {
        const now = Date.now();
        const previous = lastClick.current;
        const count = previous && previous.x === event.x && previous.y === event.y && now - previous.at < 450 ? previous.count % 3 + 1 : 1;
        lastClick.current = { x: event.x, y: event.y, at: now, count };
        pointer.current = { x: event.x, y: event.y, dragged: false, clickCount: count };
        const point = { x: Math.max(0, event.x - 1), y: Math.max(0, event.y - 1) };
        if (count === 2) selectTerminalWord(point);
        else if (count === 3) selectTerminalLine(point);
        else startTerminalSelection(point);
        redrawSelection((n) => n + 1);
        return;
      }
      if (event.kind === 'move' && pointer.current) {
        const moved = pointer.current.x !== event.x || pointer.current.y !== event.y;
        if (!moved) return;
        pointer.current.x = event.x;
        pointer.current.y = event.y;
        pointer.current.dragged ||= moved;
        if (pointer.current.dragged) {
          updateTerminalSelection({ x: Math.max(0, event.x - 1), y: Math.max(0, event.y - 1) });
          selectionRedraw.schedule();
        }
        return;
      }
      if (event.kind === 'release' && event.button === 0 && pointer.current) {
        const wasDrag = pointer.current.dragged;
        const clickCount = pointer.current.clickCount;
        const releaseMoved = pointer.current.x !== event.x || pointer.current.y !== event.y;
        if (wasDrag) {
          updateTerminalSelection({ x: Math.max(0, event.x - 1), y: Math.max(0, event.y - 1) });
        }
        const text = finishTerminalSelection();
        pointer.current = null;
        selectionRedraw.flush(wasDrag && releaseMoved);
        if ((wasDrag || clickCount > 1) && text) copySelection(text);
        if (!wasDrag && clickCount === 1) routeClick(event);
        return;
      }
      if (event.kind !== 'wheel' && event.kind !== 'press') return;
      if (event.kind === 'press') routeClick(event);
      else routeWheel(event);
    };
    const routeToRegion = (event: MouseInputEvent, kind: 'click' | 'wheel') => {
      const hits = [...regions.current.values()]
        .filter(({ node }) => {
          const rect = getRect(node);
          return event.x >= rect.left + 1 && event.x <= rect.right && event.y >= rect.top + 1 && event.y <= rect.bottom;
        })
        .sort((a, b) => b.order - a.order);
      const target = hits[0];
      if (!target) return;
      if (kind === 'wheel' && event.direction) target.handlers.onWheel?.(event.direction, event);
      else if (kind === 'click') target.handlers.onClick?.(event);
    };
    const routeClick = (event: MouseInputEvent) => routeToRegion(event, 'click');
    const routeWheel = (event: MouseInputEvent) => routeToRegion(event, 'wheel');
    bus.on('mouse', route);
    return () => {
      bus.off('mouse', route);
      selectionRedraw.cancel();
      if (pointer.current) {
        pointer.current = null;
        clearTerminalSelection();
      }
    };
  }, [bus, selectionRedraw]);

  return <MouseContext.Provider value={value}>{children}</MouseContext.Provider>;
}

function copySelection(text: string): void {
  const platform = process.platform;
  const candidates = platform === 'win32' ? [['clip.exe', []]] : platform === 'darwin' ? [['pbcopy', []]] : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  const tryNext = (index: number) => {
    const candidate = candidates[index];
    if (!candidate) {
      // OSC 52 is supported by common SSH terminals and is harmless when ignored.
      process.stdout.write(`\u001b]52;c;${Buffer.from(text).toString('base64')}\u0007`);
      return;
    }
    const child = spawn(candidate[0] as string, candidate[1] as string[], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    let settled = false;
    const fallback = () => { if (!settled) { settled = true; tryNext(index + 1); } };
    child.once('error', fallback);
    child.stdin.on('error', fallback);
    child.once('close', (code) => { if (code !== 0) fallback(); else settled = true; });
    child.stdin.end(text);
  };
  tryNext(0);
}

export function MouseRegion({
  children,
  onClick,
  onWheel,
  flexDirection = 'column',
  flexGrow,
  width,
  height,
}: RegionHandlers & {
  children: React.ReactNode;
  flexDirection?: 'row' | 'column';
  flexGrow?: number;
  width?: number;
  height?: number;
}) {
  const ref = useMouseRegion({ onClick, onWheel });
  return <Box ref={ref} flexDirection={flexDirection} flexGrow={flexGrow} width={width} height={height}>{children}</Box>;
}

export function useMouseRegion(handlers: RegionHandlers) {
  const context = useContext(MouseContext);
  const nodeRef = useRef<DOMElement | null>(null);
  const idRef = useRef(Symbol('mouse-region'));
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useLayoutEffect(() => {
    if (!context || !nodeRef.current) return;
    const id = String(idRef.current);
    const region: Region = {
      node: nodeRef.current,
      handlers: {
        onClick: (event) => handlersRef.current.onClick?.(event),
        onWheel: (direction, event) => handlersRef.current.onWheel?.(direction, event),
      },
      order: ++context.nextOrder.value,
    };
    context.regions.set(id, region);
    return () => { context.regions.delete(id); };
  }, [context]);

  return nodeRef;
}

export function useMouseBus() {
  return useContext(MouseContext)?.bus;
}
