import { builtinModules } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const uiBuild = await build({
  entryPoints: [join(repoRoot, 'ui', 'src', 'cli.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  tsconfig: join(repoRoot, 'ui', 'tsconfig.json'),
  write: false,
  metafile: true,
  logLevel: 'silent',
});
const nodeBuiltins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const uiRuntimeImports = [...new Set(
  Object.values(uiBuild.metafile.outputs)
    .flatMap(({ imports }) => imports)
    .filter(({ external }) => external)
    .map(({ path }) => path),
)];
const packageNames = [...new Set(
  uiRuntimeImports
    .filter((specifier) => !nodeBuiltins.has(specifier))
    .map((specifier) => specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : specifier.split('/')[0]),
)];
const rootManifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
const missingDependencies = packageNames.filter(
  (name) => name !== rootManifest.name && !rootManifest.dependencies?.[name],
);
if (missingDependencies.length > 0) {
  throw new Error(`UI runtime imports are not declared in root dependencies: ${missingDependencies.join(', ')}`);
}

const workDir = await mkdtemp(join(tmpdir(), 'dynatrader-package-smoke-'));
const packDir = join(workDir, 'pack');
const consumerDir = join(workDir, 'consumer');
const npmCli = process.platform === 'win32'
  ? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  : undefined;
if (npmCli && !existsSync(npmCli)) {
  throw new Error(`npm CLI not found beside Node executable: ${npmCli}`);
}
const npmCommand = process.platform === 'win32' ? process.execPath : 'npm';
const npmPrefixArgs = npmCli ? [npmCli] : [];

const env = {
  PATH: process.env.PATH ?? process.env.Path ?? '',
  HOME: workDir,
  USERPROFILE: workDir,
  APPDATA: join(workDir, 'AppData', 'Roaming'),
  LOCALAPPDATA: join(workDir, 'AppData', 'Local'),
  TMP: workDir,
  TEMP: workDir,
  TMPDIR: workDir,
  CI: '1',
  NO_COLOR: '1',
  TERM: 'dumb',
  NPM_CONFIG_CACHE: join(workDir, 'npm-cache'),
  NPM_CONFIG_USERCONFIG: join(workDir, '.npmrc'),
};

for (const name of ['SystemRoot', 'ComSpec', 'PATHEXT']) {
  if (process.env[name]) env[name] = process.env[name];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env,
    encoding: 'utf8',
    timeout: options.timeout ?? 600_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const details = [result.stdout, result.stderr, result.error?.message]
      .filter(Boolean)
      .join('\n');
    throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? 'no exit code'}):\n${details}`);
  }
  return result.stdout;
}

try {
  await mkdir(packDir, { recursive: true });
  await mkdir(consumerDir, { recursive: true });
  await writeFile(env.NPM_CONFIG_USERCONFIG, '', 'utf8');

  const packed = JSON.parse(run(npmCommand, [...npmPrefixArgs, 'pack', '--json', '--pack-destination', packDir]));
  const artifact = packed[0];
  if (!artifact?.filename || !Array.isArray(artifact.files)) {
    throw new Error('npm pack returned an unexpected JSON result');
  }

  const packagedFiles = new Set(artifact.files.map(({ path }) => path));
  const requiredFiles = [
    'dist/entry/cli.js',
    'dist/ui/cli.js',
    'dist/ui/ui/App.js',
    'dist/ui/core/providers/index.js',
  ];
  const missing = requiredFiles.filter((path) => !packagedFiles.has(path));
  if (missing.length > 0) {
    throw new Error(`Packed artifact is missing required CLI files: ${missing.join(', ')}`);
  }

  const tarball = join(packDir, artifact.filename);
  run(npmCommand, [...npmPrefixArgs, 'install', '--prefix', consumerDir, '--no-audit', '--no-fund', '--no-progress', tarball]);

  const installedPackage = join(consumerDir, 'node_modules', 'dynatrader');
  const cli = join(installedPackage, 'dist', 'entry', 'cli.js');
  const runtimeImportProbe = join(consumerDir, 'resolve-ui-runtime-imports.mjs');
  const probeSource = `for (const specifier of ${JSON.stringify(uiRuntimeImports)}) {\n  import.meta.resolve(specifier);\n}\n`;
  await writeFile(runtimeImportProbe, probeSource, 'utf8');

  run(process.execPath, [runtimeImportProbe], { cwd: consumerDir, timeout: 30_000 });
  run(process.execPath, [cli, '--version'], { cwd: consumerDir, timeout: 30_000 });
  run(process.execPath, [cli, '--help'], { cwd: consumerDir, timeout: 30_000 });

  console.log(`Package smoke passed: ${artifact.filename} (${artifact.files.length} files); UI runtime imports resolve and CLI version/help run in a clean consumer.`);
} finally {
  await rm(workDir, { recursive: true, force: true });
}
