import { EventEmitter } from 'node:events';

export type MouseInputEvent = {
  kind: 'press' | 'release' | 'move' | 'wheel' | 'focus';
  button: number;
  x: number;
  y: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  direction?: 'up' | 'down' | 'left' | 'right';
  focused?: boolean;
};

export class MouseInputBus extends EventEmitter {
  publish(event: MouseInputEvent): void {
    this.emit('mouse', event);
  }

}

export type MouseSequenceParser = {
  push: (chunk: string, flush?: boolean) => string;
};

export function createMouseSequenceParser(
  onMouse: (event: MouseInputEvent) => void,
): MouseSequenceParser {
  let pending = '';
  const prefix = '\u001b[<';

  return {
    push(chunk, flush = false) {
      let input = pending + chunk;
      pending = '';
      let output = '';
      let index = 0;

      while (index < input.length) {
        const rest = input.slice(index);
        if (rest === '\u001b' || rest === '\u001b[') {
          if (!flush) { pending = rest; break; }
        }
        if (rest.startsWith('\u001b[') && rest.length < 3 && !flush) {
          pending = rest;
          break;
        }
        if (rest.startsWith('\u001b[I') || rest.startsWith('\u001b[O')) {
          onMouse({ kind: 'focus', button: -1, x: 0, y: 0, shift: false, alt: false, ctrl: false, focused: rest[2] === 'I' });
          index += 3;
          continue;
        }
        if (input[index] !== '\u001b') {
          output += input[index++];
          continue;
        }

        if (prefix.startsWith(rest) && !flush) {
          pending = rest;
          break;
        }
        if (!rest.startsWith(prefix)) {
          output += input[index++];
          continue;
        }

        const match = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])/.exec(rest);
        if (!match) {
          const isIncomplete = !flush && /^\u001b\[<[0-9;]*$/.test(rest);
          if (isIncomplete) {
            pending = rest;
            break;
          }
          output += input[index++];
          continue;
        }

        const code = Number(match[1]);
        const wheel = (code & 64) !== 0;
        const release = match[4] === 'm' || (code & 3) === 3;
        const buttonCode = code & 3;
        const event: MouseInputEvent = {
          kind: wheel ? 'wheel' : release ? 'release' : (code & 32) !== 0 ? 'move' : 'press',
          button: wheel ? code & 3 : buttonCode,
          x: Number(match[2]),
          y: Number(match[3]),
          shift: (code & 4) !== 0,
          alt: (code & 8) !== 0,
          ctrl: (code & 16) !== 0,
        };
        if (wheel) {
          event.direction = event.button === 0 ? 'up' : event.button === 1 ? 'down' : event.button === 2 ? 'left' : 'right';
        }
        onMouse(event);
        index += match[0].length;
      }

      return output;
    },
  };
}
