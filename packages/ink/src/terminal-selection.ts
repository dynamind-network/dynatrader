import type { StyledChar } from '@alcalzone/ansi-tokenize';

export type TerminalPoint = { x: number; y: number };
export type TerminalSelection = { anchor: TerminalPoint | null; focus: TerminalPoint | null; dragging: boolean };

let state: TerminalSelection = { anchor: null, focus: null, dragging: false };
let screen: StyledChar[][] = [];

export function setTerminalScreen(next: StyledChar[][]): void {
  screen = next;
}

export function getTerminalSelection(): TerminalSelection {
  return state;
}

export function startTerminalSelection(point: TerminalPoint): void {
  state = { anchor: point, focus: point, dragging: true };
}

export function updateTerminalSelection(point: TerminalPoint): void {
  if (!state.dragging) return;
  state = { ...state, focus: point };
}

export function finishTerminalSelection(): string {
  if (!state.anchor || !state.focus) return '';
  state = { ...state, dragging: false };
  return getSelectedTerminalText();
}

export function clearTerminalSelection(): void {
  state = { anchor: null, focus: null, dragging: false };
}

export function selectTerminalWord(point: TerminalPoint): void {
  const row = screen[point.y] ?? [];
  if (!row.length) return;
  const cellText = (x: number) => row[x]?.value ?? ' ';
  let start = Math.min(Math.max(0, point.x), row.length - 1);
  let end = start;
  const isWord = (value: string) => /[\p{L}\p{N}_]/u.test(value);
  const word = isWord(cellText(start));
  while (start > 0 && isWord(cellText(start - 1)) === word && !/\s/u.test(cellText(start - 1))) start--;
  while (end + 1 < row.length && isWord(cellText(end + 1)) === word && !/\s/u.test(cellText(end + 1))) end++;
  state = { anchor: { x: start, y: point.y }, focus: { x: end, y: point.y }, dragging: false };
}

export function selectTerminalLine(point: TerminalPoint): void {
  const row = screen[point.y] ?? [];
  if (!row.length) return;
  state = { anchor: { x: 0, y: point.y }, focus: { x: row.length - 1, y: point.y }, dragging: false };
}

export function getSelectedTerminalText(): string {
  const bounds = selectionBounds();
  if (!bounds) return '';
  const lines: string[] = [];
  for (let y = bounds.start.y; y <= bounds.end.y; y++) {
    const row = screen[y] ?? [];
    const from = y === bounds.start.y ? bounds.start.x : 0;
    const to = y === bounds.end.y ? bounds.end.x : row.length - 1;
    lines.push(row.slice(from, to + 1).map((cell) => cell?.value ?? ' ').join('').replace(/\s+$/, ''));
  }
  return lines.join('\n');
}

export function applyTerminalSelection(rows: StyledChar[][]): void {
  const bounds = selectionBounds();
  if (!bounds) return;
  const inverse = { type: 'ansi', code: '\x1B[7m', endCode: '\x1B[27m' } as const;
  for (let y = bounds.start.y; y <= bounds.end.y; y++) {
    const row = rows[y];
    if (!row) continue;
    const from = y === bounds.start.y ? bounds.start.x : 0;
    const to = y === bounds.end.y ? bounds.end.x : row.length - 1;
    for (let x = Math.max(0, from); x <= Math.min(row.length - 1, to); x++) {
      const cell = row[x];
      if (cell && !cell.styles.some((style) => style.code === inverse.code)) {
        cell.styles = [...cell.styles, inverse];
      }
    }
  }
}

function selectionBounds(): { start: TerminalPoint; end: TerminalPoint } | null {
  if (!state.anchor || !state.focus || (state.anchor.x === state.focus.x && state.anchor.y === state.focus.y)) return null;
  const before = state.anchor.y < state.focus.y || (state.anchor.y === state.focus.y && state.anchor.x <= state.focus.x);
  return before ? { start: state.anchor, end: state.focus } : { start: state.focus, end: state.anchor };
}
