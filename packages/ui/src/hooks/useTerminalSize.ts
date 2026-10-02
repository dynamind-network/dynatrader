import { useState, useEffect, useCallback } from 'react';
import { useStdout } from '@dynatrader/ink/terminal';

export interface TerminalSize {
  width: number;
  height: number;
}

export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>({
    width: stdout.columns,
    height: stdout.rows,
  });

  useEffect(() => {
    const updateSize = () => {
      setSize((prev) =>
        prev.width === stdout.columns && prev.height === stdout.rows
          ? prev
          : { width: stdout.columns, height: stdout.rows },
      );
    };

    stdout.on('resize', updateSize);
    updateSize();

    return () => {
      stdout.off('resize', updateSize);
    };
  }, [stdout]);

  return size;
}

export function useTerminalWidth(): number {
  const { width } = useTerminalSize();
  return width;
}

export function useTerminalHeight(): number {
  const { height } = useTerminalSize();
  return height;
}

export function useOnResize(callback: (size: TerminalSize) => void): void {
  const { stdout } = useStdout();

  useEffect(() => {
    const handler = () => {
      callback({ width: stdout.columns, height: stdout.rows });
    };

    stdout.on('resize', handler);
    return () => {
      stdout.off('resize', handler);
    };
  }, [stdout, callback]);
}

