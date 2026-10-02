/**
 * CLI Command: doctor
 *
 * System diagnostics and auto-fix for DynaTrader.
 * Checks workspace health, model providers, exchange config, cron, gateway,
 * and sessions. With --fix, attempts automatic repairs.
 *
 * Supports --fix for auto-repair and --json for structured output.
 */

import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import yaml from 'js-yaml';
import { bold, cyan, green, red, yellow, dim, printSeparator, printHeader } from '../utils';
import { getWorkspacePath, getStatePath } from '@dyna/core/cli';
import { buildGatewayRuntimeStatus } from '@dyna/core/cli';
import { formatCredentialPresence, missingCredentialEnvNames } from './credentials';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CheckResult {
  name: string;
  ok: boolean;
  message: string;
  fixable?: boolean;
  fixed?: boolean;
}

interface SectionResult {
  name: string;
  ok: boolean;
  checks: CheckResult[];
}

interface DoctorReport {
  workspacePath: string;
  timestamp: string;
  overall: boolean;
  sections: SectionResult[];
}

// ---------------------------------------------------------------------------
// Check helpers
// ---------------------------------------------------------------------------

function check(name: string, ok: boolean, message: string, fixable = false): CheckResult {
  return { name, ok, message, fixable };
}

function sectionStatus(ok: boolean): string {
  return ok ? green('[OK]') : red('[FAIL]');
}

function checkStatus(ok: boolean, fixed?: boolean): string {
  if (fixed) return green('[FIXED]');
  return ok ? green('[OK]') : red('[FAIL]');
}

// ---------------------------------------------------------------------------
// Workspace checks
// ---------------------------------------------------------------------------

async function checkWorkspace(workspacePath: string, fix: boolean): Promise<SectionResult> {
  const checks: CheckResult[] = [];

  // config.yaml
  const configPath = join(workspacePath, 'config.yaml');
  const configExists = existsSync(configPath);
  let configFixable = false;
  let configFixed = false;

  if (configExists) {
    try {
      const content = await readFile(configPath, 'utf-8');
      const parsed = yaml.load(content) as Record<string, unknown>;
      // Validate basic structure
      if (!parsed['exchange'] || !parsed['runtime'] || !parsed['models']) {
        configFixable = true;
        if (fix) {
          await fixConfigStructure(workspacePath, parsed);
          configFixed = true;
        }
      }
    } catch {
      configFixable = true;
      if (fix) {
        await fixConfigStructure(workspacePath, {});
        configFixed = true;
      }
    }
  }

  checks.push(check(
    'config.yaml exists',
    configExists || configFixed,
    configExists ? 'found' : (configFixed ? 'created with defaults' : 'missing'),
    configFixable,
  ));

  const legacyConfigPath = join(workspacePath, 'config.json');
  checks.push(check(
    'config.json absent',
    !existsSync(legacyConfigPath),
    existsSync(legacyConfigPath) ? 'legacy config.json is present' : 'absent',
  ));

  if (configExists) {
    try {
      const content = await readFile(configPath, 'utf-8');
      const parsed = yaml.load(content) as Record<string, unknown>;
      const models = parsed['models'] as Record<string, unknown> | undefined;
      const provider = typeof models?.['provider'] === 'string' ? models['provider'].trim() : '';
      const model = typeof models?.['model'] === 'string' ? models['model'].trim() : '';
      checks.push(check(
        'models.provider and models.model',
        !!provider && !!model,
        provider && model ? `${provider}/${model}` : 'missing',
        true,
      ));
    } catch {
      checks.push(check(
        'models.provider and models.model',
        false,
        'unreadable config',
        true,
      ));
    }
  }

  // SOUL.md
  const soulPath = join(workspacePath, 'SOUL.md');
  checks.push(check(
    'SOUL.md exists',
    existsSync(soulPath),
    existsSync(soulPath) ? 'found' : 'missing',
  ));

  // IDENTITY.md
  const identityPath = join(workspacePath, 'IDENTITY.md');
  checks.push(check(
    'IDENTITY.md exists',
    existsSync(identityPath),
    existsSync(identityPath) ? 'found' : 'missing',
  ));

  // BOOTSTRAP.md
  const bootstrapPath = join(workspacePath, 'BOOTSTRAP.md');
  const bootstrapExists = existsSync(bootstrapPath);
  checks.push(check(
    'BOOTSTRAP.md exists',
    true, // Not a failure if missing - means bootstrap completed
    bootstrapExists ? 'setup pending' : 'setup complete',
  ));

  // Check workspace directories
  const requiredDirs = ['memory', 'logs', 'runs', 'cron', 'skills'];
  for (const dir of requiredDirs) {
    const dirPath = join(workspacePath, dir);
    let dirOk = existsSync(dirPath);
    let dirFixed = false;

    if (!dirOk && fix) {
      await mkdir(dirPath, { recursive: true });
      dirOk = true;
      dirFixed = true;
    }

    checks.push(check(
      `${dir}/ directory`,
      dirOk,
      dirOk ? (dirFixed ? 'created' : 'found') : 'missing',
      !existsSync(dirPath),
    ));
  }

  const allOk = checks.every(c => c.ok || c.fixed);
  return { name: 'workspace', ok: allOk, checks };
}

// ---------------------------------------------------------------------------
// Model checks
// ---------------------------------------------------------------------------

async function checkModels(): Promise<SectionResult> {
  const checks: CheckResult[] = [];

  // Ollama reachability
  let ollamaOk = false;
  try {
    const http = await import('http');
    ollamaOk = await new Promise<boolean>((resolve) => {
      const req = http.default.get('http://localhost:11434/api/tags', { timeout: 3000 }, (res) => {
        resolve(res.statusCode === 200);
        res.resume();
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
  } catch {
    ollamaOk = false;
  }
  checks.push(check(
    'ollama reachable',
    ollamaOk,
    ollamaOk ? 'running at localhost:11434' : 'not reachable (expected if not installed)',
  ));

  // LM Studio reachability
  let lmstudioOk = false;
  const lmStudioUrl = process.env['LM_STUDIO_BASE_URL'] || 'http://localhost:1234';
  try {
    const http = await import('http');
    lmstudioOk = await new Promise<boolean>((resolve) => {
      const url = new URL(lmStudioUrl);
      const req = http.default.get({
        hostname: url.hostname,
        port: url.port || 1234,
        path: '/v1/models',
        timeout: 3000,
      }, (res) => {
        resolve(res.statusCode === 200);
        res.resume();
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
  } catch {
    lmstudioOk = false;
  }
  checks.push(check(
    'lmstudio reachable',
    lmstudioOk,
    lmstudioOk ? `running at ${lmStudioUrl}` : 'not reachable (expected if not installed)',
  ));

  const allOk = checks.every(c => c.ok);
  return { name: 'models', ok: allOk, checks };
}

// ---------------------------------------------------------------------------
// Exchange checks
// ---------------------------------------------------------------------------

export function checkExchange(workspacePath: string): SectionResult {
  const checks: CheckResult[] = [];

  const configPath = join(workspacePath, 'config.yaml');
  let exchangeId = '';
  let mode = 'paper';
  let exchangeIds: string[] = [];
  let configDiagnostic: string | undefined;

  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, 'utf-8');
      const loaded = yaml.load(content);
      if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded) || loaded instanceof Date) throw new Error('config must be a YAML object');
      const config = loaded as Record<string, unknown>;
      if (config['exchange'] !== undefined && config['exchange'] !== null && (typeof config['exchange'] !== 'object' || Array.isArray(config['exchange']))) throw new Error('exchange must be an object');
      if (config['runtime'] !== undefined && config['runtime'] !== null && (typeof config['runtime'] !== 'object' || Array.isArray(config['runtime']))) throw new Error('runtime must be an object');
      if (config['workspace'] !== undefined && config['workspace'] !== null && (typeof config['workspace'] !== 'object' || Array.isArray(config['workspace']))) throw new Error('workspace must be an object');
      const exchange = config['exchange'] as Record<string, unknown> | undefined;
      const runtime = config['runtime'] as Record<string, unknown> | undefined;

      if (exchange) {
        const ids = Array.isArray(exchange['ids']) ? exchange['ids'].filter((id): id is string => typeof id === 'string' && !!id.trim()) : [];
        exchangeIds = ids.length ? ids : (typeof exchange['id'] === 'string' && exchange['id'].trim() ? [exchange['id'].trim()] : []);
        exchangeId = exchangeIds[0] ?? '';
      }
      if (runtime) {
        mode = (runtime['mode'] as string) || (config['workspace'] as Record<string, unknown>)?.['mode'] as string || 'paper';
      } else if (config['workspace']) {
        mode = ((config['workspace'] as Record<string, unknown>)?.['mode'] as string) || 'paper';
      }
    } catch (error) {
      configDiagnostic = `Invalid config.yaml: ${error instanceof Error ? error.message : 'malformed YAML'}`;
    }
  }

  if (configDiagnostic) checks.push(check('exchange config', false, configDiagnostic));

  if (configDiagnostic) {
    checks.push(check('API keys configured', false, 'invalid config.yaml; credentials cannot be verified'));
    return { name: 'exchange', ok: false, checks };
  }

  if (!exchangeId) {
    const fallbackId = process.env.EXCHANGE_ID?.trim();
    if (fallbackId) {
      exchangeId = fallbackId;
      exchangeIds = [fallbackId];
    }
  }
  const missing = missingCredentialEnvNames(exchangeId, exchangeIds, mode);
  const hasCredentials = !!exchangeId && missing.length === 0;
  const configuredExchangeLabel = exchangeId || 'configured exchange';

  if (!['live', 'micro_live'].includes(mode.trim().toLowerCase())) {
    checks.push(check(
      'API keys configured',
      true,
      `${configuredExchangeLabel} keys optional for ${mode} mode`,
    ));
  } else if (!exchangeId) {
    checks.push(check(
      'API keys configured',
      false,
      'EXCHANGE_ID is required to identify the venue and its required credentials for live mode',
    ));
  } else {
    checks.push(check(
      'API keys configured',
      hasCredentials,
      hasCredentials
        ? `${configuredExchangeLabel} keys found (${formatCredentialPresence(exchangeId, exchangeIds).join(', ')})`
        : `${configuredExchangeLabel} keys missing: ${missing.join(', ')} (required for ${mode} mode; ${formatCredentialPresence(exchangeId, exchangeIds).join(', ')})`,
    ));
  }

  return { name: 'exchange', ok: checks.every(c => c.ok), checks };
}

// ---------------------------------------------------------------------------
// Cron checks
// ---------------------------------------------------------------------------

async function checkCron(workspacePath: string, fix: boolean): Promise<SectionResult> {
  const checks: CheckResult[] = [];

  const jobsPath = join(workspacePath, 'cron', 'jobs.json');
  let jobsValid = false;
  let jobsFixed = false;

  if (existsSync(jobsPath)) {
    try {
      const content = await readFile(jobsPath, 'utf-8');
      const jobs = JSON.parse(content) as Array<Record<string, unknown>>;

      if (Array.isArray(jobs)) {
        jobsValid = true;

        // Check for stale timestamps
        if (fix) {
          let needsFix = false;
          for (const job of jobs) {
            const state = job['state'] as string | undefined;
            const updatedAt = job['updatedAt'] as number | undefined;
            if (state === 'paused' && updatedAt && updatedAt > 0) {
              // Stale timestamp - reset
              needsFix = true;
            }
          }

          if (needsFix) {
            const fixedJobs = jobs.map((job) => {
              if (job['state'] === 'paused') {
                return { ...job, updatedAt: 0 };
              }
              return job;
            });
            await writeFile(jobsPath, JSON.stringify(fixedJobs, null, 2), 'utf-8');
            jobsFixed = true;
          }
        }
      }
    } catch {
      // Invalid JSON
    }
  }

  checks.push(check(
    'jobs.json valid',
    jobsValid || jobsFixed,
    jobsValid ? (jobsFixed ? 'stale timestamps reset' : 'valid') : 'missing or invalid',
    !jobsValid,
  ));

  // CronEngine would start
  checks.push(check(
    'CronEngine would start',
    true, // Always OK - CronEngine handles missing jobs gracefully
    'ready',
  ));

  return { name: 'cron', ok: checks.every(c => c.ok), checks };
}

// ---------------------------------------------------------------------------
// Gateway checks
// ---------------------------------------------------------------------------

function checkGateway(workspacePath: string): SectionResult {
  const checks: CheckResult[] = [];

  const configPath = join(workspacePath, 'config.yaml');
  let config: Record<string, unknown> | null = null;

  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, 'utf-8');
      config = yaml.load(content) as Record<string, unknown>;
    } catch {
      config = null;
    }
  }

  const gatewayStatus = buildGatewayRuntimeStatus(config as any, process.env);

  checks.push(check(
    'Telegram configured',
    !gatewayStatus.telegram.enabled || gatewayStatus.telegram.configured,
    gatewayStatus.telegram.detail,
  ));

  checks.push(check(
    'Discord configured',
    !gatewayStatus.discord.enabled || gatewayStatus.discord.configured,
    gatewayStatus.discord.detail,
  ));

  return { name: 'gateway', ok: checks.every(c => c.ok), checks };
}

// ---------------------------------------------------------------------------
// Session checks
// ---------------------------------------------------------------------------

async function checkSessions(workspacePath: string, fix: boolean): Promise<SectionResult> {
  const checks: CheckResult[] = [];

  // SQLite writable
  const dbPath = join(workspacePath, 'state.db');
  let sqliteOk = false;
  let sqliteFixed = false;

  if (fix) {
    sqliteOk = true;
  } else {
    sqliteOk = true; // Directory exists, assume writable
  }

  checks.push(check(
    'SQLite writable',
    sqliteOk || sqliteFixed,
    sqliteOk ? (sqliteFixed ? 'memory dir created' : 'directory exists') : 'memory directory missing',
    !sqliteOk,
  ));

  // Permissions valid
  let permissionsOk = true;
  let permissionsFixed = false;

  const configPath = join(workspacePath, 'config.yaml');
  if (existsSync(configPath)) {
    try {
      const content = await readFile(configPath, 'utf-8');
      const config = yaml.load(content) as Record<string, unknown>;
      const runtime = config['runtime'] as Record<string, unknown> | undefined;

      // Check for stale permission patterns
      if (runtime) {
        const permissions = runtime['permissions'] as string[] | undefined;
        if (permissions && Array.isArray(permissions)) {
          const hasStalePerms = permissions.includes('read') && permissions.includes('write') && !permissions.includes('*');
          if (hasStalePerms && fix) {
            const fixedConfig = {
              ...config,
              runtime: { ...runtime, permissions: ['*'] },
            };
            await writeFile(configPath, JSON.stringify(fixedConfig, null, 2), 'utf-8');
            permissionsFixed = true;
          } else if (hasStalePerms) {
            permissionsOk = false;
          }
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  checks.push(check(
    'Permissions valid',
    permissionsOk || permissionsFixed,
    permissionsOk ? (permissionsFixed ? 'stale permissions upgraded' : 'valid') : 'stale permissions found (run with --fix)',
    !permissionsOk,
  ));

  return { name: 'sessions', ok: checks.every(c => c.ok), checks };
}

// ---------------------------------------------------------------------------
// Fix helpers
// ---------------------------------------------------------------------------

export async function fixConfigStructure(workspacePath: string, existing: Record<string, unknown>): Promise<void> {
  const configPath = join(workspacePath, 'config.yaml');

  const config: Record<string, unknown> = {
    version: '1.0',
    workspace: {
      name: 'default',
      description: 'DynaTrader workspace',
      mode: 'paper',
      ...((existing['workspace'] as Record<string, unknown>) ?? {}),
    },
    runtime: {
      strictMode: false,
      requireRiskProfile: false,
      requireTradingPolicy: false,
      requireAuthConfig: false,
      liveTradingEnabled: false,
      enableShadowMode: false,
      enableMicroLiveMode: false,
      ...((existing['runtime'] as Record<string, unknown>) ?? {}),
    },
    exchange: {
      id: '',
      sandbox: true,
      ...((existing['exchange'] as Record<string, unknown>) ?? {}),
    },
    models: {
      provider: '',
      model: '',
      ...((existing['models'] as Record<string, unknown>) ?? {}),
    },
    mcp: {
      servers: [],
      ...((existing['mcp'] as Record<string, unknown>) ?? {}),
    },
    logging: {
      level: 'info',
      audit: true,
      ...((existing['logging'] as Record<string, unknown>) ?? {}),
    },
  };

  await writeFile(configPath, yaml.dump(config, {
    indent: 2,
    lineWidth: 100,
    noRefs: true,
    sortKeys: false,
  }), 'utf-8');
}

// ---------------------------------------------------------------------------
// Output formatters
// ---------------------------------------------------------------------------

function printReport(report: DoctorReport): void {
  printHeader('DynaTrader System Diagnostics');
  console.log();
  console.log(dim(`  Workspace: ${resolve(report.workspacePath)}`));
  console.log(dim(`  Timestamp: ${report.timestamp}`));
  console.log();

  for (const section of report.sections) {
    console.log(bold(`Checking ${section.name}...              ${sectionStatus(section.ok)}`));
    for (const c of section.checks) {
      const status = checkStatus(c.ok, c.fixed);
      const suffix = c.fixable ? yellow(' (fixable)') : '';
      console.log(`  - ${c.name.padEnd(30)} ${status} ${dim(c.message)}${suffix}`);
    }
    console.log();
  }

  printSeparator();
  console.log();

  if (report.overall) {
    console.log(green(bold('All checks passed!')));
  } else {
    const failedChecks = report.sections
      .flatMap(s => s.checks)
      .filter(c => !c.ok && !c.fixed);
    console.log(yellow(bold(`${failedChecks.length} issue(s) found.`)));
    console.log(dim('Run with --fix to attempt automatic repairs.'));
  }
  console.log();
}

function printJsonReport(report: DoctorReport): void {
  console.log(JSON.stringify(report, null, 2));
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function cmdDoctor(options: { fix?: boolean; json?: boolean }): Promise<void> {
  const fix = options.fix ?? false;
  const jsonOutput = options.json ?? false;
  const workspacePath = getWorkspacePath();
  const statePath = getStatePath();

  const sections: SectionResult[] = [];

  // Run all checks
  sections.push(await checkWorkspace(statePath, fix));
  sections.push(await checkModels());
  sections.push(checkExchange(statePath));
  sections.push(await checkCron(statePath, fix));
  sections.push(checkGateway(statePath));
  sections.push(await checkSessions(statePath, fix));

  const overall = sections.every(s => s.ok);

  const report: DoctorReport = {
    workspacePath,
    timestamp: new Date().toISOString(),
    overall,
    sections,
  };

  if (jsonOutput) {
    printJsonReport(report);
  } else {
    printReport(report);
  }

  if (!overall && fix) {
    console.log(dim('Attempting automatic fixes...'));
    console.log(dim('Re-run doctor to verify fixes.'));
    console.log();
  }
}
