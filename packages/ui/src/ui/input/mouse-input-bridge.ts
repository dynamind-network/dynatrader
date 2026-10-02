import { PassThrough } from 'node:stream';
import type { MouseInputBus } from './mouse-input.js';
import { createMouseSequenceParser } from './mouse-input.js';

type InkInput = PassThrough & {
  isTTY: boolean;
  columns?: number;
  rows?: number;
  setRawMode: (enabled: boolean) => void;
  ref: () => void;
  unref: () => void;
};

export function createMouseInputBridge(source: NodeJS.ReadStream, bus: MouseInputBus) {
  const input = new PassThrough() as InkInput;
  const parser = createMouseSequenceParser((event) => bus.publish(event));
  let escapeTimer: NodeJS.Timeout | undefined;

  Object.defineProperties(input, {
    isTTY: { configurable: true, value: Boolean(source.isTTY) },
    columns: { configurable: true, get: () => process.stdout.columns },
    rows: { configurable: true, get: () => process.stdout.rows },
  });
  input.setRawMode = (enabled) => source.setRawMode?.(enabled);
  input.ref = () => source.ref();
  input.unref = () => source.unref();

  input.on('pipe', () => {});
  source.on('data', onData);

  function onData(chunk: Buffer | string) {
    if (escapeTimer) clearTimeout(escapeTimer);
    const visible = parser.push(chunk.toString());
    if (visible) input.write(visible);
    escapeTimer = setTimeout(() => {
      const remainder = parser.push('', true);
      if (remainder) input.write(remainder);
    }, 45);
    escapeTimer.unref();
  }

  return {
    stdin: input,
    dispose() {
      if (escapeTimer) clearTimeout(escapeTimer);
      const remainder = parser.push('', true);
      if (remainder) input.write(remainder);
      source.removeListener('data', onData);
      input.end();
    },
  };
}
