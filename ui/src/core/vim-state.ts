export type VimMode = 'normal' | 'insert' | 'visual' | 'command';

export interface VimState {
  mode: VimMode;
  cursor: number;
  selectionStart?: number;
  buffer: string;
  register: string;
  lastCommand: string;
  commandBuffer: string;
  lineNumber: boolean;
}

export function createVimState(buffer: string = ''): VimState {
  return {
    mode: 'normal',
    cursor: 0,
    buffer,
    register: '',
    lastCommand: '',
    commandBuffer: '',
    lineNumber: false,
  };
}

export interface VimAction {
  type:
    | 'move'
    | 'delete'
    | 'change'
    | 'yank'
    | 'paste'
    | 'insert'
    | 'mode'
    | 'command'
    | 'undo'
    | 'redo'
    | 'search'
    | 'cursor'
    | 'noop';
  cursorDelta?: number;
  newCursor?: number;
  text?: string;
  mode?: VimMode;
}

export function processVimInput(
  state: VimState,
  input: string,
  key: any
): { state: VimState; action: VimAction; commandText?: string } {
  if (state.mode === 'insert') {
    return handleInsertMode(state, input, key);
  }
  if (state.mode === 'normal') {
    return handleNormalMode(state, input, key);
  }
  if (state.mode === 'visual') {
    return handleVisualMode(state, input, key);
  }
  if (state.mode === 'command') {
    return handleCommandMode(state, input, key);
  }
  return { state, action: { type: 'noop' } };
}

function handleInsertMode(state: VimState, input: string, key: any): { state: VimState; action: VimAction } {
  if (key.escape) {
    return {
      state: { ...state, mode: 'normal', cursor: Math.max(0, state.cursor - 1) },
      action: { type: 'mode', mode: 'normal' },
    };
  }
  if (key.return) {
    return {
      state: { ...state, cursor: state.cursor + 1 },
      action: { type: 'insert', text: '\n' },
    };
  }
  if (key.backspace) {
    return {
      state: { ...state, cursor: Math.max(0, state.cursor - 1) },
      action: { type: 'delete', cursorDelta: -1 },
    };
  }
  if (input && input.length === 1) {
    return {
      state: { ...state, cursor: state.cursor + 1 },
      action: { type: 'insert', text: input },
    };
  }
  return { state, action: { type: 'noop' } };
}

function handleNormalMode(state: VimState, input: string, key: any): { state: VimState; action: VimAction } {
  // Enter insert mode
  if (input === 'i') return { state: { ...state, mode: 'insert' }, action: { type: 'mode', mode: 'insert' } };
  if (input === 'a') return { state: { ...state, mode: 'insert', cursor: state.cursor + 1 }, action: { type: 'mode', mode: 'insert' } };
  if (input === 'A') return { state: { ...state, mode: 'insert', cursor: state.buffer.length }, action: { type: 'mode', mode: 'insert' } };
  if (input === 'o') {
    const lineEnd = state.buffer.indexOf('\n', state.cursor);
    const insertAt = lineEnd === -1 ? state.buffer.length : lineEnd;
    return { state: { ...state, mode: 'insert', cursor: insertAt + 1 }, action: { type: 'insert', text: '\n' } };
  }

  // Enter visual mode
  if (input === 'v') return { state: { ...state, mode: 'visual', selectionStart: state.cursor }, action: { type: 'mode', mode: 'visual' } };

  // Enter command mode
  if (input === ':') return { state: { ...state, mode: 'command', commandBuffer: '' }, action: { type: 'mode', mode: 'command' } };

  // Movement
  if (input === 'h') return { state: { ...state, cursor: Math.max(0, state.cursor - 1) }, action: { type: 'cursor', newCursor: Math.max(0, state.cursor - 1) } };
  if (input === 'l') return { state: { ...state, cursor: Math.min(state.buffer.length, state.cursor + 1) }, action: { type: 'cursor', newCursor: Math.min(state.buffer.length, state.cursor + 1) } };
  if (input === 'w') {
    const nextWord = findNextWord(state.buffer, state.cursor);
    return { state: { ...state, cursor: nextWord }, action: { type: 'cursor', newCursor: nextWord } };
  }
  if (input === 'b') {
    const prevWord = findPrevWord(state.buffer, state.cursor);
    return { state: { ...state, cursor: prevWord }, action: { type: 'cursor', newCursor: prevWord } };
  }
  if (input === '0') return { state: { ...state, cursor: findLineStart(state.buffer, state.cursor) }, action: { type: 'cursor', newCursor: findLineStart(state.buffer, state.cursor) } };
  if (input === '$') return { state: { ...state, cursor: findLineEnd(state.buffer, state.cursor) }, action: { type: 'cursor', newCursor: findLineEnd(state.buffer, state.cursor) } };
  if (input === 'g' && state.lastCommand === 'g') {
    return { state: { ...state, cursor: 0, lastCommand: '' }, action: { type: 'cursor', newCursor: 0 } };
  }
  if (input === 'G') {
    return { state: { ...state, cursor: state.buffer.length, lastCommand: '' }, action: { type: 'cursor', newCursor: state.buffer.length } };
  }

  // Delete
  if (input === 'x') {
    return {
      state: { ...state, register: state.buffer[state.cursor] ?? '' },
      action: { type: 'delete', text: state.buffer[state.cursor] ?? '' },
    };
  }
  if (input === 'd') {
    if (state.lastCommand === 'd') {
      const lineStart = findLineStart(state.buffer, state.cursor);
      const lineEnd = findLineEnd(state.buffer, state.cursor);
      const deleted = state.buffer.slice(lineStart, lineEnd + 1);
      return {
        state: { ...state, cursor: lineStart, register: deleted, lastCommand: '' },
        action: { type: 'delete', text: deleted },
      };
    }
    return { state: { ...state, lastCommand: 'd' }, action: { type: 'noop' } };
  }

  // Change
  if (input === 'c') {
    if (state.lastCommand === 'c') {
      return {
        state: { ...state, mode: 'insert', lastCommand: '' },
        action: { type: 'change' },
      };
    }
    return { state: { ...state, lastCommand: 'c' }, action: { type: 'noop' } };
  }

  // Yank
  if (input === 'y') {
    if (state.lastCommand === 'y') {
      const lineStart = findLineStart(state.buffer, state.cursor);
      const lineEnd = findLineEnd(state.buffer, state.cursor);
      const yanked = state.buffer.slice(lineStart, lineEnd + 1);
      return { state: { ...state, register: yanked, lastCommand: '' }, action: { type: 'yank', text: yanked } };
    }
    return { state: { ...state, lastCommand: 'y' }, action: { type: 'noop' } };
  }

  // Paste
  if (input === 'p' && state.register) {
    return { state: { ...state, cursor: state.cursor + state.register.length }, action: { type: 'paste', text: state.register } };
  }

  // Undo
  if (input === 'u') return { state, action: { type: 'undo' } };
  if (key.ctrl && input === 'r') return { state, action: { type: 'redo' } };

  // Search
  if (input === '/') return { state: { ...state, mode: 'command', commandBuffer: '/' }, action: { type: 'mode', mode: 'command' } };

  return { state: { ...state, lastCommand: input }, action: { type: 'noop' } };
}

function handleVisualMode(state: VimState, input: string, key: any): { state: VimState; action: VimAction } {
  if (key.escape) {
    return {
      state: { ...state, mode: 'normal', selectionStart: undefined },
      action: { type: 'mode', mode: 'normal' },
    };
  }
  if (input === 'h') return { state: { ...state, cursor: Math.max(0, state.cursor - 1) }, action: { type: 'cursor', newCursor: Math.max(0, state.cursor - 1) } };
  if (input === 'l') return { state: { ...state, cursor: Math.min(state.buffer.length, state.cursor + 1) }, action: { type: 'cursor', newCursor: Math.min(state.buffer.length, state.cursor + 1) } };
  if (input === 'd' || input === 'x') {
    const start = Math.min(state.selectionStart ?? state.cursor, state.cursor);
    const end = Math.max(state.selectionStart ?? state.cursor, state.cursor);
    const deleted = state.buffer.slice(start, end);
    return {
      state: { ...state, mode: 'normal', cursor: start, register: deleted, selectionStart: undefined },
      action: { type: 'delete', text: deleted },
    };
  }
  if (input === 'y') {
    const start = Math.min(state.selectionStart ?? state.cursor, state.cursor);
    const end = Math.max(state.selectionStart ?? state.cursor, state.cursor);
    const yanked = state.buffer.slice(start, end);
    return {
      state: { ...state, mode: 'normal', register: yanked, selectionStart: undefined },
      action: { type: 'yank', text: yanked },
    };
  }
  return { state, action: { type: 'noop' } };
}

function handleCommandMode(state: VimState, input: string, key: any): { state: VimState; action: VimAction; commandText?: string } {
  if (key.escape) {
    return { state: { ...state, mode: 'normal', commandBuffer: '' }, action: { type: 'mode', mode: 'normal' } };
  }
  if (key.return) {
    const cmd = state.commandBuffer;
    return { state: { ...state, mode: 'normal', commandBuffer: '' }, action: { type: 'command' }, commandText: cmd };
  }
  if (key.backspace) {
    return {
      state: { ...state, commandBuffer: state.commandBuffer.slice(0, -1) },
      action: { type: 'noop' },
    };
  }
  return {
    state: { ...state, commandBuffer: state.commandBuffer + input },
    action: { type: 'noop' },
  };
}

function findNextWord(text: string, pos: number): number {
  const match = text.slice(pos).match(/\W\w/);
  return match ? pos + (match.index ?? 0) + 1 : text.length;
}

function findPrevWord(text: string, pos: number): number {
  const before = text.slice(0, pos);
  const match = before.match(/\w\W\s*$/);
  return match ? (match.index ?? 0) : 0;
}

function findLineStart(text: string, pos: number): number {
  const nl = text.lastIndexOf('\n', pos - 1);
  return nl + 1;
}

function findLineEnd(text: string, pos: number): number {
  const nl = text.indexOf('\n', pos);
  return nl === -1 ? text.length - 1 : nl - 1;
}
