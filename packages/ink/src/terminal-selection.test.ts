import {afterEach, describe, expect, it} from 'vitest';
import {styledCharsToString} from '@alcalzone/ansi-tokenize';
import {applyTerminalSelection, finishTerminalSelection, setTerminalScreen, selectTerminalLine, selectTerminalWord, startTerminalSelection, updateTerminalSelection} from './terminal-selection.js';

function cells(value: string) {
  return value.split('\n').map((line) => [...line].map((character) => ({type: 'char' as const, value: character, fullWidth: false, styles: [] as Array<{type:'ansi';code:string;endCode:string}>})));
}

describe('terminal selection', () => {
  afterEach(() => setTerminalScreen([]));

  it('extracts selected rows and trims line-end padding', () => {
    setTerminalScreen(cells('hello  \nworld '));
    startTerminalSelection({x: 1, y: 0});
    updateTerminalSelection({x: 3, y: 1});
    expect(finishTerminalSelection()).toBe('ello\nworl');
  });

  it('highlights each cell in the selection', () => {
    const screen = cells('abcd');
    startTerminalSelection({x: 1, y: 0});
    updateTerminalSelection({x: 2, y: 0});
    applyTerminalSelection(screen);
    expect(screen[0]?.map((cell) => cell.styles.some((style) => style.code === '\x1B[7m'))).toEqual([false, true, true, false]);
    expect(styledCharsToString(screen[0] ?? [])).toBe(`a\x1B[7mbc\x1B[27md`);
  });

  it('selects a word or a full rendered line from a click point', () => {
    setTerminalScreen(cells('buy AAPL today'));
    selectTerminalWord({x: 5, y: 0});
    expect(finishTerminalSelection()).toBe('AAPL');
    selectTerminalLine({x: 5, y: 0});
    expect(finishTerminalSelection()).toBe('buy AAPL today');
  });
});
