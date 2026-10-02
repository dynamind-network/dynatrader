import { describe, expect, it, vi } from 'vitest';
import { createMouseSequenceParser } from './mouse-input.js';

describe('createMouseSequenceParser', () => {
  it('filters complete mouse reports and preserves ordinary keyboard input', () => {
    const onMouse = vi.fn();
    const parser = createMouseSequenceParser(onMouse);
    expect(parser.push('hello\u001b[<0;12;4Mworld')).toBe('helloworld');
    expect(onMouse).toHaveBeenCalledWith(expect.objectContaining({ kind: 'press', button: 0, x: 12, y: 4 }));
  });

  it('parses reports split across input chunks', () => {
    const onMouse = vi.fn();
    const parser = createMouseSequenceParser(onMouse);
    expect(parser.push('a\u001b[')).toBe('a');
    expect(parser.push('<0;4;9M', true)).toBe('');
    expect(onMouse).toHaveBeenCalledWith(expect.objectContaining({ kind: 'press', x: 4, y: 9 }));
  });

  it('reports wheel direction and modifier bits', () => {
    const onMouse = vi.fn();
    const parser = createMouseSequenceParser(onMouse);
    parser.push('\u001b[<76;8;3M');
    expect(onMouse).toHaveBeenCalledWith(expect.objectContaining({ kind: 'wheel', direction: 'up', shift: true, alt: true }));
  });

  it('flushes an isolated Escape key instead of swallowing it', () => {
    const parser = createMouseSequenceParser(vi.fn());
    expect(parser.push('\u001b')).toBe('');
    expect(parser.push('', true)).toBe('\u001b');
  });

  it('preserves function-key reports for the TUI keyboard handler', () => {
    const onMouse = vi.fn();
    const parser = createMouseSequenceParser(onMouse);
    expect(parser.push('before\u001bOQafter')).toBe('before\u001bOQafter');
    expect(onMouse).not.toHaveBeenCalled();
  });

  it('reports terminal focus changes', () => {
    const onMouse = vi.fn();
    createMouseSequenceParser(onMouse).push('\u001b[O');
    expect(onMouse).toHaveBeenCalledWith(expect.objectContaining({ kind: 'focus', focused: false }));
  });
});
