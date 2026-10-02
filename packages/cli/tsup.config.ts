import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const coreManifest = JSON.parse(readFileSync(new URL('../core/package.json', import.meta.url), 'utf8'));
const external = Object.keys(coreManifest.dependencies);

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    kernel: 'src/kernel.ts',
    cli: 'src/cli.ts',
    daemon: 'src/daemon.ts',
    'entry/stdio': 'src/entry/stdio.ts',
    'entry/cli': 'src/entry/cli.ts',
  },
  format: 'esm',
  target: 'es2022',
  outDir: 'dist',
  clean: true,
  dts: false,
  sourcemap: false,
  // Keep each executable entry's import graph isolated. Shared chunks across
  // the CLI, daemon, and stdio runtime eagerly loaded daemon-only integrations
  // (Discord, browser automation, etc.) before the interactive agent started.
  splitting: false,
  tsconfig: '../../tsconfig.json',
  bundle: true,
  external,
});
