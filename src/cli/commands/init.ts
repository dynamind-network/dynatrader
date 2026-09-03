/**
 * CLI Command: init
 *
 * Interactive setup wizard for DynaTrader. Walks the user through exchange
 * configuration, trading profile, model provider, and gateway options.
 *
 * Supports `--yes` flag for non-interactive mode (uses all defaults).
 */

import * as readline from 'readline';
import { mkdir, writeFile, readFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { bold, cyan, green, red, yellow, dim, printSeparator, printHeader } from '../utils';
import { getWorkspacePath, ensureWorkspace } from '../../workspace-init';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InitAnswers {
  exchange: string;
  tradingMode: string;
  apiKey: string;
  apiSecret: string;
  riskLevel: string;
  modelProvider: string;
  modelName: string;
  enableTelegram: boolean;
  enableDiscord: boolean;
}

type ValidationLevel = 'error' | 'warning';

interface InitValidationIssue {
  level: ValidationLevel;
  title: string;
  detail: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS: InitAnswers = {
  exchange: '',
  tradingMode: 'paper',
  apiKey: '',
  apiSecret: '',
  riskLevel: 'conservative',
  modelProvider: '',
  modelName: '',
  enableTelegram: false,
  enableDiscord: false,
};

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

function createPrompt(rl: readline.Interface): (question: string, defaultValue?: string) => Promise<string> {
  return (question: string, defaultValue?: string): Promise<string> => {
    return new Promise((resolve) => {
      rl.question(question, (answer) => {
        const trimmed = answer.trim();
        if (trimmed === '' && defaultValue !== undefined) {
          resolve(defaultValue);
        } else {
          resolve(trimmed);
        }
      });
    });
  };
}

function createConfirm(rl: readline.Interface): (question: string, defaultValue?: boolean) => Promise<boolean> {
  return (question: string, defaultValue?: boolean): Promise<boolean> => {
    return new Promise((resolve) => {
      rl.question(question, (answer) => {
        const trimmed = answer.trim().toLowerCase();
        if (trimmed === '') {
          resolve(defaultValue ?? false);
        } else {
          resolve(trimmed === 'y' || trimmed === 'yes');
        }
      });
    });
  };
}

// ---------------------------------------------------------------------------
// Non-interactive defaults
// ---------------------------------------------------------------------------

function getNonInteractiveDefaults(): InitAnswers {
  return { ...DEFAULTS };
}

export function validateInitAnswers(answers: InitAnswers): InitValidationIssue[] {
  const issues: InitValidationIssue[] = [];
  const mode = answers.tradingMode.trim().toLowerCase();
  const needsExchangeCredentials = mode === 'live' || mode === 'micro_live';

  if (!answers.modelProvider.trim()) {
    issues.push({
      level: 'warning',
      title: 'Model provider not selected',
      detail: 'Set a provider now or run `dynatrader config set models.provider <provider>` after init.',
    });
  }

  if (!answers.modelName.trim()) {
    issues.push({
      level: 'warning',
      title: 'Model name not selected',
      detail: 'Set `models.model` to an exact model name before starting the daemon.',
    });
  }

  if (needsExchangeCredentials) {
    if (!answers.exchange.trim()) {
      issues.push({
        level: 'error',
        title: 'Exchange is required for live execution',
        detail: 'Choose the exact exchange before enabling live or micro-live execution.',
      });
    }
    if (!answers.apiKey.trim() || !answers.apiSecret.trim()) {
      issues.push({
        level: 'error',
        title: 'Exchange credentials are required for live execution',
        detail: 'Set both API key and secret before using live or micro-live mode.',
      });
    }
  }

  if (mode === 'shadow' && !answers.exchange.trim()) {
    issues.push({
      level: 'warning',
      title: 'Shadow mode still needs a target exchange',
      detail: 'Shadow runs should still be tied to a concrete venue so the runtime can resolve market context.',
    });
  }

  if (answers.enableTelegram && !process.env['TELEGRAM_BOT_TOKEN']) {
    issues.push({
      level: 'warning',
      title: 'Telegram is enabled but TELEGRAM_BOT_TOKEN is missing',
      detail: 'Add the token to your environment before starting the daemon.',
    });
  }

  if (answers.enableDiscord && !process.env['DISCORD_BOT_TOKEN']) {
    issues.push({
      level: 'warning',
      title: 'Discord is enabled but DISCORD_BOT_TOKEN is missing',
      detail: 'Add the token to your environment before starting the daemon.',
    });
  }

  return issues;
}

function renderInitValidation(issues: InitValidationIssue[]): { hasErrors: boolean } {
  if (issues.length === 0) {
    console.log(green('  Workspace settings are ready.'));
    return { hasErrors: false };
  }

  console.log();
  console.log(bold(cyan('Validation results')));
  printSeparator();

  let hasErrors = false;
  for (const issue of issues) {
    const label = issue.level === 'error' ? red('[ERROR]') : yellow('[WARN]');
    if (issue.level === 'error') {
      hasErrors = true;
    }
    console.log(`  ${label} ${bold(issue.title)}`);
    console.log(`    ${issue.detail}`);
  }

  if (hasErrors) {
    console.log();
    console.log(red('Fix the errors above before trying to launch live execution.'));
  } else {
    console.log();
    console.log(yellow('Warnings can be resolved after bootstrap, but they should be cleared before going live.'));
  }

  return { hasErrors };
}

// ---------------------------------------------------------------------------
// Config writer
// ---------------------------------------------------------------------------

async function writeConfigYaml(workspacePath: string, answers: InitAnswers): Promise<void> {
  const configPath = join(workspacePath, 'config.yaml');

  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      const content = await readFile(configPath, 'utf-8');
      const { default: yaml } = await import('js-yaml');
      existing = yaml.load(content) as Record<string, unknown>;
    } catch {
      // Start fresh
    }
  }

  const config = {
    ...existing,
    version: '1.0',
    workspace: {
      ...((existing['workspace'] as Record<string, unknown>) ?? {}),
      name: 'default',
      description: 'DynaTrader financial market workspace',
      mode: answers.tradingMode,
    },
    runtime: {
      ...((existing['runtime'] as Record<string, unknown>) ?? {}),
      strictMode: false,
      requireRiskProfile: false,
      requireTradingPolicy: false,
      requireAuthConfig: false,
      liveTradingEnabled: answers.tradingMode === 'live',
      enableShadowMode: answers.tradingMode === 'shadow',
      enableMicroLiveMode: false,
    },
    exchange: {
      ...((existing['exchange'] as Record<string, unknown>) ?? {}),
      id: answers.exchange,
      sandbox: answers.tradingMode !== 'live',
      apiKey: answers.apiKey || '',
      secret: answers.apiSecret || '',
    },
    models: {
      ...((existing['models'] as Record<string, unknown>) ?? {}),
      provider: answers.modelProvider,
      model: answers.modelName,
    },
    gateway: {
      telegram: { enabled: answers.enableTelegram },
      discord: { enabled: answers.enableDiscord },
    },
    logging: {
      level: 'info',
      audit: true,
    },
    storage: {
      memoryPath: 'workspace',
      runsPath: 'workspace/runs',
    },
  };

  const { default: yaml } = await import('js-yaml');
  await writeFile(configPath, yaml.dump(config, {
    indent: 2,
    lineWidth: 100,
    noRefs: true,
    sortKeys: false,
  }), 'utf-8');
}

async function writeIdentityMd(workspacePath: string, answers: InitAnswers): Promise<void> {
  const filePath = join(workspacePath, 'IDENTITY.md');
  const quote = (value: string) => JSON.stringify(value);
  const content = `---
name: ""
role: Trading agent runtime
creator: ${quote("Operator")}
birthday: ${quote(new Date().toISOString().split('T')[0])}
exchange: ${quote(answers.exchange)}
trading_mode: ${quote(answers.tradingMode)}
model_provider: ${quote(answers.modelProvider)}
model_name: ${quote(answers.modelName)}
vibe: ${quote("Professional, data-driven, precise")}
---

# IDENTITY.md - Who Am I

Fill the frontmatter above. The runtime reads identity from this file, not from code.
`;
  await writeFile(filePath, content, 'utf-8');
}

async function writeUserMd(workspacePath: string, answers: InitAnswers): Promise<void> {
  const filePath = join(workspacePath, 'USER.md');
  const content = `# USER.md - About You

## Name
<YOUR_NAME>

## Role
Operator

## Expertise
- ${answers.riskLevel} risk profile
- Preferred venues: <polymarket|hyperliquid|cex|dex|mixed>
- Market selection policy: <describe how the agent should choose markets>

## Trading Goals
<DESCRIBE_YOUR_GOALS>

## Risk Tolerance
${answers.riskLevel}

## Launch Channels
- Telegram
- Discord
- Slack
- Signal

## Execution Policy
- Prefer paper or backtest first
- Use close-only unwind flows to reduce positions
- Let the agent choose symbols for new trades; keep timeframe internal unless backtesting

## Time Commitment
<full-time|part-time|passive>
`;
  await writeFile(filePath, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function cmdInit(options: { yes?: boolean }): Promise<void> {
  printHeader('DynaTrader Setup Wizard');
  console.log();

  // Ensure workspace exists
  const workspacePath = getWorkspacePath();
  await ensureWorkspace();
  console.log(bold('Workspace:'));
  console.log(`  Path: ${resolve(workspacePath)}`);
  console.log();

  let answers: InitAnswers;

  if (options.yes) {
    // Non-interactive: use all defaults
    console.log(dim('Running in non-interactive mode (--yes). Using defaults.'));
    console.log();
    answers = getNonInteractiveDefaults();
  } else {
    // Interactive mode
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const ask = createPrompt(rl);
    const confirm = createConfirm(rl);

    // Start with defaults; answers will be built up through the wizard
    answers = { ...DEFAULTS };

    try {
      console.log(bold(cyan('Step 1: Exchange Configuration')));
      console.log(dim('Configure your trading exchange connection.'));
      console.log();

      answers.exchange = await ask('  Exchange (leave blank until configured): ');
      answers.tradingMode = await ask(
        `  Trading mode (paper/shadow/live) [${DEFAULTS.tradingMode}]: `,
        DEFAULTS.tradingMode,
      );
      answers.apiKey = await ask(
        '  API Key (leave empty for paper mode): ',
        '',
      );
      answers.apiSecret = await ask(
        '  API Secret (leave empty for paper mode): ',
        '',
      );

      console.log();
      console.log(bold(cyan('Step 2: Trading Preferences')));
      console.log(dim('Set your market selection and execution preferences.'));
      console.log();

      answers.riskLevel = await ask(
        `  Risk level (conservative/moderate/aggressive) [${DEFAULTS.riskLevel}]: `,
        DEFAULTS.riskLevel,
      );

      console.log();
      console.log(bold(cyan('Step 3: Model Configuration')));
      console.log(dim('Choose your AI model provider.'));
      console.log();

      answers.modelProvider = await ask('  Primary model provider (openai/anthropic/openrouter/deepseek/google/ollama/lmstudio): ');
      answers.modelName = await ask('  Model name: ');

      console.log();
      console.log(bold(cyan('Step 4: Gateway (optional)')));
      console.log(dim('Enable messaging integrations.'));
      console.log();

      answers.enableTelegram = await confirm(
        `  Enable Telegram? (y/n) [${DEFAULTS.enableTelegram ? 'y' : 'n'}]: `,
        DEFAULTS.enableTelegram,
      );
      answers.enableDiscord = await confirm(
        `  Enable Discord? (y/n) [${DEFAULTS.enableDiscord ? 'y' : 'n'}]: `,
        DEFAULTS.enableDiscord,
      );

      console.log();
      console.log(bold(cyan('Step 5: Confirm')));
      console.log(dim('Review your configuration before writing.'));
      console.log();

      console.log(bold('  Summary:'));
      console.log(`    Exchange:       ${green(answers.exchange)}`);
      console.log(`    Trading Mode:   ${green(answers.tradingMode)}`);
      console.log(`    Risk Level:     ${green(answers.riskLevel)}`);
      console.log(`    Model:          ${green(answers.modelProvider)} / ${green(answers.modelName)}`);
      console.log(`    Telegram:       ${answers.enableTelegram ? green('enabled') : yellow('disabled')}`);
      console.log(`    Discord:        ${answers.enableDiscord ? green('enabled') : yellow('disabled')}`);
      console.log(`    Slack/Signal:   ${yellow('workspace policy / external gateway')}`);
      console.log(`    API Keys:       ${answers.apiKey ? green('configured') : yellow('not set (paper mode)')}`);
      console.log();

      const issues = validateInitAnswers(answers);
      const validation = renderInitValidation(issues);
      if (validation.hasErrors) {
        console.log(yellow('  Update the answers above and rerun init.'));
        return;
      }

      const proceed = await confirm('  Write configuration? (y/n) [y]: ', true);
      if (!proceed) {
        console.log(yellow('  Setup cancelled.'));
        return;
      }
    } finally {
      rl.close();
    }
  }

  // Write configuration files
  console.log();
  console.log(dim('Writing configuration...'));

  await writeConfigYaml(workspacePath, answers);
  console.log(`  ${green('[OK]')} config.yaml`);

  await writeIdentityMd(workspacePath, answers);
  console.log(`  ${green('[OK]')} IDENTITY.md`);

  await writeUserMd(workspacePath, answers);
  console.log(`  ${green('[OK]')} USER.md`);

  const validation = renderInitValidation(validateInitAnswers(answers));
  if (validation.hasErrors) {
    console.log();
    console.log(red('Workspace files were written, but launch validation failed.'));
    console.log(dim('Resolve the errors before starting a live or micro-live daemon.'));
    return;
  }

  const bootstrapPath = join(workspacePath, 'BOOTSTRAP.md');
  if (existsSync(bootstrapPath)) {
    await unlink(bootstrapPath).catch(() => {});
    console.log(`  ${green('[OK]')} BOOTSTRAP.md removed`);
  }

  // Create necessary directories if missing
  const dirs = ['memory', 'logs', 'runs', 'cron', 'skills'];
  for (const dir of dirs) {
    const dirPath = join(workspacePath, dir);
    if (!existsSync(dirPath)) {
      await mkdir(dirPath, { recursive: true });
      console.log(`  ${green('[OK]')} ${dir}/ directory`);
    }
  }

  console.log();
  printSeparator();
  console.log();
  console.log(green('Setup complete!'));
  console.log();
  console.log(bold('Next steps:'));
  console.log(`  1. Edit ${dim(resolve(join(workspacePath, 'USER.md')))} with your personal info`);
  if (answers.apiKey) {
    console.log(`  2. Set environment variables for API keys:`);
    console.log(`     ${dim(`${answers.exchange.toUpperCase()}_API_KEY=your_key`)}`);
    console.log(`     ${dim(`${answers.exchange.toUpperCase()}_SECRET=your_secret`)}`);
  } else {
    console.log(`  2. Configure your preferred markets in USER.md and workspace files.`);
  }
  if (answers.modelProvider === 'ollama') {
    console.log(`  3. Ensure Ollama is running: ${dim('ollama serve')}`);
  } else if (answers.modelProvider === 'openai') {
    console.log(`  3. Set environment variable: ${dim('OPENAI_API_KEY=your_key')}`);
  }
  console.log(`  4. Run diagnostics: ${dim('dynatrader doctor')}`);
  console.log();
}
