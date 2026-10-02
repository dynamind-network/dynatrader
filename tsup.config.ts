import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'packages/core/src/index.ts',
    kernel: 'packages/core/src/kernel/index.ts',
    cli: 'packages/core/src/cli.ts',
    daemon: 'packages/core/src/daemon.ts',
    'entry/stdio': 'packages/core/src/entry/stdio.ts',
    'entry/cli': 'packages/core/src/entry/cli.ts',
  },
  format: 'esm',
  target: 'es2022',
  outDir: 'dist',
  clean: true,
  dts: true,
  sourcemap: true,
  splitting: false,
  tsconfig: './tsconfig.json',
  bundle: true,
});
