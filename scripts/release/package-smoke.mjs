import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const packageDirs = ['packages/core', 'packages/ink', 'packages/dynamind-api-plugin', 'packages/cli', 'packages/ui'];
const workDir = await mkdtemp(join(tmpdir(), 'dynatrader-release-smoke-'));
const packDir = join(workDir, 'pack');
const consumerDir = join(workDir, 'consumer');
const npmCli = process.platform === 'win32'
  ? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  : undefined;
if (npmCli && !existsSync(npmCli)) throw new Error(`npm CLI not found beside Node executable: ${npmCli}`);
const npmCommand = process.platform === 'win32' ? process.execPath : 'npm';
const npmPrefixArgs = npmCli ? [npmCli] : [];
const env = {
  ...process.env,
  CI: '1',
  NO_COLOR: '1',
  NPM_CONFIG_USERCONFIG: join(workDir, '.npmrc'),
  NPM_CONFIG_FETCH_RETRIES: '5',
  NPM_CONFIG_FETCH_RETRY_MINTIMEOUT: '1000',
  NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT: '60000',
};
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...env, ...options.env },
    input: options.input,
    encoding: 'utf8',
    timeout: options.timeout ?? 600_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? 'no exit code'}):\n${[result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n')}`);
  return result.stdout;
}
try {
  await mkdir(packDir, { recursive: true });
  await mkdir(consumerDir, { recursive: true });
  await writeFile(env.NPM_CONFIG_USERCONFIG, '', 'utf8');
  const artifacts = [];
  for (const packageDir of packageDirs) {
    const manifest = JSON.parse(await readFile(join(repoRoot, packageDir, 'package.json'), 'utf8'));
    const packed = JSON.parse(run(npmCommand, [...npmPrefixArgs, 'pack', '--json', '--pack-destination', packDir], { cwd: join(repoRoot, packageDir) }))[0];
    if (!packed?.filename || !Array.isArray(packed.files)) throw new Error(`npm pack failed for ${manifest.name}`);
    const files = new Set(packed.files.map(({ path }) => path));
    const required = packageDir.endsWith('/core')
      ? ['dist/index.js', 'dist/index.d.ts', 'dist/cli.js', 'dist/cli.d.ts', 'dist/kernel/index.js']
      : packageDir.endsWith('/ink')
        ? ['dist/index.js', 'dist/index.d.ts', 'dist/terminal.js', 'dist/terminal-selection.js', 'dist/terminal-selection.d.ts']
      : packageDir.endsWith('/dynamind-api-plugin')
        ? ['dist/index.js', 'plugin.json']
        : packageDir.endsWith('/cli')
          ? ['dist/entry/cli.js', 'dist/cli.js', 'index.d.ts']
          : ['dist/index.js', 'dist/cli.js'];
    const missing = required.filter((file) => !files.has(file));
    if (missing.length) throw new Error(`${manifest.name} tarball missing: ${missing.join(', ')}`);
    if (packageDir.endsWith('/ui')) {
      const uiChunks = packed.files.map(({ path }) => path).filter((path) => path.startsWith('dist/chunks/'));
      if (!uiChunks.some((path) => /\/App-[^/]+\.js$/.test(path))) {
        throw new Error('Terminal UI tarball is missing the eagerly loaded app bundle');
      }
      if (uiChunks.some((path) => /\/(?:Help|Markets|Chart|Portfolio|Trades|Alerts|Analysis|News|Watchlist|Search|AutoHedge|Settings|OrderBook|Models)Screen-[^/]+\.js$/.test(path))) {
        throw new Error('Terminal UI tarball unexpectedly splits a screen into a navigation-time chunk');
      }
    }
    artifacts.push({ name: manifest.name, path: join(packDir, packed.filename) });
  }
  run(npmCommand, [...npmPrefixArgs, 'install', '--prefix', consumerDir, '--no-audit', '--no-fund', '--no-progress', ...artifacts.map(({ path }) => path)]);
  const probe = join(consumerDir, 'release-probe.mjs');
  await writeFile(probe, `
    import { selectTerminalLine, selectTerminalWord } from '@dynatrader/ink';
    import { DynaTraderRuntime, MarketDataTool, MemoryStoreImpl } from '@dyna/core/cli';
    import { createMarketDataProvider, createNewsProvider } from '@dyna/plugin-dynamind-api';
    import { render as terminalRender } from '@dynatrader/ink/terminal';
    if (typeof selectTerminalLine !== 'function' || typeof selectTerminalWord !== 'function') throw new Error('Ink selection exports are unavailable');
    if (typeof terminalRender !== 'function') throw new Error('Bundled Ink terminal renderer is unavailable');
    if (typeof DynaTraderRuntime !== 'function' || typeof MarketDataTool !== 'function' || typeof MemoryStoreImpl !== 'function') throw new Error('Core CLI integration exports are unavailable');
    if (typeof createMarketDataProvider !== 'function' || typeof createNewsProvider !== 'function') throw new Error('Bundled DynaMind provider exports are unavailable');
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      const body = url.includes('/api/v1/pairs')
        ? { data: ['BTCUSDT'] }
        : url.includes('/api/v1/price/')
          ? { data: { price: 65000, volume24h: 123 } }
          : url.includes('/api/v1/ohlcv/')
            ? { data: [{ timestamp: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }] }
            : url.includes('/api/v1/orderbook/')
              ? { data: { bids: [[64999, 2]], asks: [[65001, 3]], timestamp: 1000 } }
              : url.includes('/api/v1/news')
                ? { news: [{ title: 'Probe headline', url: 'https://example.test/story', source: 'Probe', published_at: '2026-10-01T00:00:00.000Z' }] }
                : null;
      if (body === null) throw new Error('Unexpected DynaMind provider request: ' + url);
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
      const config = { baseUrl: 'https://provider.test', timeoutMs: 1000 };
      const market = createMarketDataProvider(config);
      const news = createNewsProvider(config);
      if ((await market.fetchUniverse()).join(',') !== 'BTCUSDT') throw new Error('DynaMind universe provider returned the wrong result');
      if (await market.getPrice('BTCUSDT') !== 65000) throw new Error('DynaMind price provider returned the wrong result');
      if ((await market.getOHLCV('BTCUSDT', '1h', 1))[0]?.close !== 1.5) throw new Error('DynaMind OHLCV provider returned the wrong result');
      if ((await market.getOrderBook('BTCUSDT')).asks[0]?.[0] !== 65001) throw new Error('DynaMind order book provider returned the wrong result');
      if ((await news.getNews({ limit: 1 }))[0]?.title !== 'Probe headline') throw new Error('DynaMind news provider returned the wrong result');
      if (requests.length !== 5) throw new Error('DynaMind providers did not call the expected API paths');
      for (const [status, expected] of [[401, 'key is missing or invalid'], [402, 'not included in your current plan'], [429, 'rate limit reached']]) {
        globalThis.fetch = async () => new Response(null, {
          status,
          statusText: 'Rejected',
          headers: status === 429 ? { 'Retry-After': '30' } : undefined,
        });
        try {
          await market.getPrice('BTCUSDT');
          throw new Error('Expected DynaMind API plan error for HTTP ' + status);
        } catch (error) {
          if (!String(error).includes(expected)) throw error;
          if (status === 429 && !String(error).includes('Retry after 30')) throw error;
        }
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
    for (const name of ['@dyna/core', '@dyna/core/cli', 'dynatrader', '@dyna/plugin-dynamind-api', '@dynatrader/ink', '@dynatrader/ui', '@dynatrader/ui/cli']) import.meta.resolve(name);
  `, 'utf8');
  run(process.execPath, [probe], { cwd: consumerDir, timeout: 120_000 });
  const cli = join(consumerDir, 'node_modules', 'dynatrader', 'dist', 'entry', 'cli.js');
  run(process.execPath, [cli, '--version'], { cwd: consumerDir, timeout: 120_000 });
  run(process.execPath, [cli, '--help'], { cwd: consumerDir, timeout: 120_000 });

  // Exercise the real dispatcher in a non-interactive consumer. Replace the
  // installed UI entry briefly with a probe so the smoke check can verify
  // package resolution, process spawning, and option forwarding without a TTY
  // or model credentials.
  const uiEntry = join(consumerDir, 'node_modules', '@dynatrader', 'ui', 'dist', 'cli.js');
  if (!existsSync(uiEntry)) throw new Error('Installed UI CLI entry is missing');
  const uiHelp = run(process.execPath, [uiEntry, '--help'], { cwd: consumerDir, timeout: 120_000 });
  if (!uiHelp.includes('DynaTrader Terminal') || !uiHelp.includes('Usage: dynatrader')) {
    throw new Error(`Installed UI CLI did not start correctly for --help:\n${uiHelp.slice(0, 2000)}`);
  }
  const originalUiEntry = await readFile(uiEntry, 'utf8');
  try {
    await writeFile(uiEntry, `console.log(JSON.stringify({ args: process.argv.slice(2), noDaemon: process.env.DYNATRADER_NO_DAEMON ?? null, model: process.env.DYNATRADER_MODEL ?? null }));\n`, 'utf8');

    const defaultDispatch = run(process.execPath, [cli], { cwd: consumerDir, timeout: 120_000 }).trim();
    if (defaultDispatch !== JSON.stringify({ args: [], noDaemon: null, model: null })) {
      throw new Error(`Default CLI dispatch did not launch the installed UI entry: ${defaultDispatch}`);
    }

    const optionDispatch = run(process.execPath, [cli, '--tui', '--no-daemon', '--model', 'probe-model', '--session', 'probe-session', '--prompt', 'probe-prompt'], { cwd: consumerDir, timeout: 120_000 }).trim();
    if (optionDispatch !== JSON.stringify({
      args: ['--no-daemon', '--model', 'probe-model', '--session', 'probe-session', '--prompt', 'probe-prompt'],
      noDaemon: 'true',
      model: 'probe-model',
    })) {
      throw new Error(`CLI TUI dispatch dropped launch options: ${optionDispatch}`);
    }

    const oneshotDispatch = run(process.execPath, [cli, '--oneshot', '--prompt', 'probe-prompt'], { cwd: consumerDir, timeout: 120_000 }).trim();
    if (oneshotDispatch !== JSON.stringify({ args: ['--no-tui', '--prompt', 'probe-prompt'], noDaemon: null, model: null })) {
      throw new Error(`CLI one-shot dispatch did not select non-interactive UI mode: ${oneshotDispatch}`);
    }
  } finally {
    await writeFile(uiEntry, originalUiEntry, 'utf8');
  }

  // Boot the actual stdio agent in an isolated state directory and inspect
  // its tool registry. This covers the production UI's agent runtime path,
  // which a typecheck or package import cannot prove is wired correctly.
  const runtimeState = join(workDir, 'runtime-state');
  const runtimeWorkspace = join(workDir, 'runtime-workspace');
  await mkdir(runtimeState, { recursive: true });
  await mkdir(runtimeWorkspace, { recursive: true });
  await writeFile(join(runtimeState, 'config.yaml'), 'runtime:\n  mode: paper\nexchange:\n  id: binance\n', 'utf8');
  const stdioProbe = join(workDir, 'stdio-tool-list-probe.mjs');
  await writeFile(stdioProbe, `
    import { spawn } from 'node:child_process';
    const child = spawn(process.execPath, [${JSON.stringify(cli)}, '--stdio'], {
      cwd: ${JSON.stringify(consumerDir)},
      env: { ...process.env, TELEGRAM_BOT_TOKEN: '', DISCORD_BOT_TOKEN: '', DYNA_STATE_DIR: ${JSON.stringify(runtimeState)}, DYNA_WORKSPACE: ${JSON.stringify(runtimeWorkspace)} },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let response;
    const timeout = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      for (const line of stdout.split(/\\r?\\n/)) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === 1 && !response) {
            response = parsed;
            child.stdin.end();
            // The stdio agent is a long-lived service and may keep runtime
            // resources alive after EOF. This smoke test only needs its tool
            // registry response, so terminate the isolated probe child now.
            child.kill();
          }
        } catch { /* Wait for a complete JSON-RPC frame. */ }
      }
    });
    child.on('error', (error) => { clearTimeout(timeout); console.error(error); process.exitCode = 1; });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (!response) {
        console.error('stdio agent returned no tool.list response:', stderr || stdout);
        process.exitCode = 1;
        return;
      }
      if (response.error) {
        console.error(JSON.stringify(response.error));
        process.exitCode = 1;
        return;
      }
      process.stdout.write(JSON.stringify(response.result));
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tool.list', params: {} }) + '\\n');
  `, 'utf8');
  const toolListOutput = run(process.execPath, [stdioProbe], { cwd: consumerDir, timeout: 150_000 });
  const toolListResponse = { result: JSON.parse(toolListOutput) };
  const registeredTools = new Set((toolListResponse?.result?.tools ?? []).map(({ name }) => name));
  const requiredStandaloneTools = [
    'market_data', 'indicators', 'scan_market', 'size_position', 'backtest',
    'sessions_list', 'sessions_history', 'session_search', 'memory_search', 'skills_list', 'skill_view',
  ];
  const missingStandaloneTools = requiredStandaloneTools.filter((name) => !registeredTools.has(name));
  if (toolListResponse?.error || missingStandaloneTools.length > 0) {
    throw new Error(`Standalone TUI runtime is missing required tools: ${missingStandaloneTools.join(', ') || JSON.stringify(toolListResponse?.error)}`);
  }
  console.log(`Release package smoke passed for ${artifacts.map(({ name }) => name).join(', ')} in a clean npm consumer.`);
} finally {
  await rm(workDir, { recursive: true, force: true });
}
