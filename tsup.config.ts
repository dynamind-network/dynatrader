import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    kernel: 'src/kernel/index.ts',
    cli: 'src/cli.ts',
    daemon: 'src/daemon.ts',
    'entry/stdio': 'src/entry/stdio.ts',
    'entry/cli': 'src/entry/cli.ts',
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
