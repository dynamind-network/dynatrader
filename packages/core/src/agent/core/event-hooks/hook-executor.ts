/**
 * Hook Executor for DynaMind Terminal
 *
 * Executes different hook types: command, prompt, http, agent.
 * Handles input/output parsing, timeout, and result processing.
 */
import { spawn, type ChildProcess } from 'child_process';
import type {
  HookCommand,
  CommandHook,
  HttpHook,
  PromptHook,
  AgentHook,
  HookResult,
  HookInput,
  HookJSONOutput,
  SyncHookJSONOutput,
  HookMetrics,
} from './hook-types.js';
import { isAsyncHookJSONOutput } from './hook-types.js';
import { getHookMetricsCollector } from './hook-metrics.js';
import { errorMessage as getErrorMessage } from '../../../utils/errors.js';

export type HookModelRunner = (model: string, systemPrompt: string, userMessage: string, signal?: AbortSignal) => Promise<string>;

const ALLOWED_HOOK_COMMANDS = new Set([
  'git',
  'bun',
  'npm',
  'node',
  'npx',
  'yarn',
  'pnpm',
  'curl',
  'wget',
  'echo',
  'cat',
  'ls',
  'mkdir',
  'touch',
  'grep',
  'find',
  'awk',
  'sed',
  'head',
  'tail',
  'wc',
  'jq',
  'python',
  'python3',
  'ruby',
  'go',
  'rustc',
  'cargo',
]);

const SAFE_ENV_VARS = new Set(['NODE_ENV', 'CI', 'TERM', 'LANG', 'PATH']);

function isCommandAllowed(command: string): boolean {
  const baseCommand = command.trim().split(/\s+/)[0].toLowerCase();
  return ALLOWED_HOOK_COMMANDS.has(baseCommand);
}

export interface ExecuteOptions {
  timeout?: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
  cwd?: string;
}

export interface ExecuteResult {
  stdout: string;
  stderr: string;
  output: string;
  status: number;
  exitCode: number;
  durationMs: number;
  aborted?: boolean;
  async?: boolean;
}

const DEFAULT_TIMEOUT_MS = 60 * 1000;

export class HookExecutor {
  private defaultTimeout: number;
  private defaultModel: string | null;
  private modelRunner?: HookModelRunner;

  constructor(defaultModel: string | null = null, defaultTimeoutMs = DEFAULT_TIMEOUT_MS, modelRunner?: HookModelRunner) {
    this.defaultModel = defaultModel?.trim() || null;
    this.defaultTimeout = defaultTimeoutMs;
    this.modelRunner = modelRunner;
  }

  async execute(
    hook: HookCommand,
    input: HookInput,
    options: ExecuteOptions = {}
  ): Promise<ExecuteResult> {
    const startTime = Date.now();
    const metrics = getHookMetricsCollector();

    const metric: HookMetrics = {
      hookId: `exec_${startTime}`,
      hookName: this.getHookName(hook),
      hookEvent: input.hook_event_name,
      startedAt: startTime,
      async: hook.type === 'command' && !!(hook as CommandHook).async,
    };

    try {
      let result: ExecuteResult;

      switch (hook.type) {
        case 'command':
          result = await this.executeCommand(hook, input, options);
          break;
        case 'prompt':
          result = await this.executePrompt(hook, input, options);
          break;
        case 'http':
          result = await this.executeHttp(hook, input, options);
          break;
        case 'agent':
          result = await this.executeAgent(hook, input, options);
          break;
        default:
          throw new Error(`Unknown hook type: ${(hook as HookCommand).type}`);
      }

      metric.finishedAt = Date.now();
      metric.durationMs = metric.finishedAt - metric.startedAt;
      metric.exitCode = result.exitCode;
      metric.outcome = result.exitCode === 0 ? 'success' : 'error';

      metrics.record(metric);

      return result;
    } catch (error) {
      metric.finishedAt = Date.now();
      metric.durationMs = metric.finishedAt - metric.startedAt;
      metric.outcome = 'error';
      metric.error = getErrorMessage(error);

      metrics.record(metric);

      throw error;
    }
  }

  private getHookName(hook: HookCommand): string {
    switch (hook.type) {
      case 'command':
        return `command:${(hook as CommandHook).command.substring(0, 30)}`;
      case 'prompt':
        return `prompt:${(hook as PromptHook).prompt.substring(0, 30)}`;
      case 'http':
        return `http:${(hook as HttpHook).url}`;
      case 'agent':
        return `agent:${(hook as AgentHook).prompt.substring(0, 30)}`;
      default:
        return 'unknown';
    }
  }

  private async executeCommand(
    hook: CommandHook,
    input: HookInput,
    options: ExecuteOptions
  ): Promise<ExecuteResult> {
    if (!isCommandAllowed(hook.command)) {
      return {
        exitCode: 1,
        status: 1,
        stdout: '',
        stderr: `Hook command not allowed: ${hook.command.split(/\s+/)[0]}. Allowed: ${[...ALLOWED_HOOK_COMMANDS].sort().join(', ')}`,
        output: '',
        durationMs: 0,
      };
    }

    const timeout = (hook.timeout ?? options.timeout ?? this.defaultTimeout) * 1000;
    const cwd = options.cwd || process.cwd();
    const env = { ...process.env, ...options.env };

    const shell = hook.shell === 'powershell' ? 'powershell' : 'bash';

    let child: ChildProcess;

    if (shell === 'powershell') {
      const psPath = await this.findPowerShell();
      const args = ['-NoProfile', '-NonInteractive', '-Command', hook.command];
      child = spawn(psPath, args, { env, cwd, windowsHide: true });
    } else {
      // SECURITY FIX: Parse command into args to prevent shell injection.
      // Never use shell: true — it passes the entire string to /bin/sh -c
      // which allows injection via shell metacharacters in hook configs.
      const parsedArgs = this.parseShellCommand(hook.command);
      const command = parsedArgs.shift()!;
      child = spawn(command, parsedArgs, {
        shell: false,
        env,
        cwd,
        windowsHide: true,
      });
    }

    const inputJson = JSON.stringify(input);

    const result = await this.runProcess(child, inputJson, timeout, hook.async, options.signal);

    return result;
  }

  private async findPowerShell(): Promise<string> {
    const { spawn: nodeSpawn } = await import('child_process');

    const pwshPaths = [
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
      'pwsh',
      'powershell',
    ];

    for (const psPath of pwshPaths) {
      try {
        await new Promise<void>((resolve, reject) => {
          const proc = nodeSpawn(psPath, ['-Version'], {
            windowsHide: true,
          });
          proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Exit code ${code}`));
          });
          proc.on('error', reject);
        });
        return psPath;
      } catch {
        continue;
      }
    }

    return 'powershell';
  }

  /**
   * Parse a shell command string into an executable and args array
   * without invoking a shell. Handles quoted strings.
   * SECURITY: Replaces shell: true to prevent hook injection.
   */
  private parseShellCommand(command: string): string[] {
    const args: string[] = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;
    let escaped = false;

    for (const ch of command) {
      if (escaped) {
        current += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === "'" && !inDouble) {
        inSingle = !inSingle;
        continue;
      }
      if (ch === '"' && !inSingle) {
        inDouble = !inDouble;
        continue;
      }
      if (ch === ' ' && !inSingle && !inDouble) {
        if (current) {
          args.push(current);
          current = '';
        }
        continue;
      }
      current += ch;
    }
    if (current) {
      args.push(current);
    }
    return args;
  }

  private async executePrompt(
    hook: PromptHook,
    input: HookInput,
    options: ExecuteOptions
  ): Promise<ExecuteResult> {
    const prompt = hook.prompt.replace('$ARGUMENTS', JSON.stringify(input));

    const model = hook.model || this.defaultModel;
    if (!model) {
      throw new Error('No default model available for prompt hooks.');
    }
    const timeout = (hook.timeout ?? options.timeout ?? this.defaultTimeout) * 1000;

    const systemPrompt = `You are a hook evaluation system. Given the following input, respond with a JSON object that indicates what action to take.

Available response fields:
- continue: boolean (whether to continue execution)
- suppressOutput: boolean (whether to suppress the output)
- stopReason: string (reason for stopping if applicable)
- decision: "approve" | "block" (permission decision)
- reason: string (explanation for the decision)
- systemMessage: string (message to add to the conversation)
- additionalContext: string (additional context to provide)

Return ONLY valid JSON, no other text.`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const content = await this.callLLM(model, systemPrompt, prompt, controller.signal);
      clearTimeout(timeoutId);

      return {
        stdout: content,
        stderr: '',
        output: content,
        status: 0,
        exitCode: 0,
        durationMs: 0,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      const errorMessage = getErrorMessage(error);
      throw new Error(`Prompt hook failed: ${errorMessage}`);
    }
  }

  private validateHookUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      if (/^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|localhost|169\.254\.)/.test(parsed.hostname)) {
        return false;
      }
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  private async executeHttp(
    hook: HttpHook,
    input: HookInput,
    options: ExecuteOptions
  ): Promise<ExecuteResult> {
    if (!this.validateHookUrl(hook.url)) {
      return {
        stdout: '',
        stderr: `Blocked: hook URL "${hook.url}" points to a private/local address`,
        output: '',
        status: 1,
        exitCode: 1,
        durationMs: 0,
      };
    }

    const timeout = (hook.timeout ?? options.timeout ?? this.defaultTimeout) * 1000;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...hook.headers,
    };

    if (hook.allowedEnvVars) {
      for (const varName of hook.allowedEnvVars) {
        if (!SAFE_ENV_VARS.has(varName)) continue;
        const value = process.env[varName];
        if (value !== undefined) {
          const headerKey = Object.keys(headers).find(
            (k) => k.includes(varName) || headers[k]?.includes(`$${varName}`)
          );
          if (headerKey) {
            headers[headerKey] = headers[headerKey].replace(
              new RegExp(`\\$${varName}|\\$\\{${varName}\\}`, 'g'),
              value
            );
          }
        }
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(hook.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const body = await response.text();

      if (!response.ok) {
        return {
          stdout: '',
          stderr: body,
          output: body,
          status: response.status,
          exitCode: response.status,
          durationMs: 0,
        };
      }

      return {
        stdout: body,
        stderr: '',
        output: body,
        status: 0,
        exitCode: 0,
        durationMs: 0,
      };
    } catch (error) {
      clearTimeout(timeoutId);

      const errorMessage = getErrorMessage(error);
      return {
        stdout: '',
        stderr: errorMessage,
        output: errorMessage,
        status: 1,
        exitCode: 1,
        durationMs: 0,
      };
    }
  }

  private async executeAgent(
    hook: AgentHook,
    input: HookInput,
    options: ExecuteOptions
  ): Promise<ExecuteResult> {
    const prompt = hook.prompt.replace('$ARGUMENTS', JSON.stringify(input));

    const model = hook.model || this.defaultModel;
    if (!model) {
      throw new Error('No default model available for agent hooks.');
    }
    const timeout = (hook.timeout ?? options.timeout ?? this.defaultTimeout) * 1000;

    const systemPrompt = `You are a verification agent. Your job is to verify whether a specific condition is met.

Respond with a JSON object that indicates the verification result:
- continue: boolean (whether to continue execution)
- decision: "approve" | "block" (verification result)
- reason: string (explanation)
- additionalContext: string (any additional context)

Return ONLY valid JSON, no other text.`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const content = await this.callLLM(model, systemPrompt, prompt, controller.signal);
      clearTimeout(timeoutId);

      return {
        stdout: content,
        stderr: '',
        output: content,
        status: 0,
        exitCode: 0,
        durationMs: 0,
      };
    } catch (error) {
      clearTimeout(timeoutId);

      const errorMessage = getErrorMessage(error);
      return {
        stdout: '',
        stderr: errorMessage,
        output: errorMessage,
        status: 1,
        exitCode: 1,
        durationMs: 0,
      };
    }
  }

  private async callLLM(
    model: string,
    systemPrompt: string,
    userMessage: string,
    signal?: AbortSignal
  ): Promise<string> {
    if (!this.modelRunner) throw new Error('Prompt and agent hooks require a Core model runner.');
    return this.modelRunner(model, systemPrompt, userMessage, signal);
  }

  private async runProcess(
    child: ChildProcess,
    input: string,
    timeoutMs: number,
    isAsync = false,
    signal?: AbortSignal
  ): Promise<ExecuteResult> {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let output = '';
      const startTime = Date.now();

      const timeoutHandle = setTimeout(() => {
        child.kill('SIGTERM');
        resolve({
          stdout,
          stderr: 'Timeout',
          output: 'Timeout',
          status: -1,
          exitCode: -1,
          durationMs: Date.now() - startTime,
          aborted: true,
        });
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timeoutHandle);
      };

      if (signal) {
        signal.addEventListener('abort', () => {
          child.kill('SIGTERM');
          cleanup();
        });
      }

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
        output += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
        output += data.toString();
      });

      child.on('close', (code) => {
        cleanup();
        resolve({
          stdout,
          stderr,
          output,
          status: code ?? 1,
          exitCode: code ?? 1,
          durationMs: Date.now() - startTime,
          async: isAsync,
        });
      });

      child.on('error', (error) => {
        cleanup();
        reject(error);
      });

      if (child.stdin) {
        child.stdin.write(input);
        child.stdin.end();
      }
    });
  }

  parseHookOutput(stdout: string): HookJSONOutput | null {
    const trimmed = stdout.trim();
    if (!trimmed.startsWith('{')) {
      return null;
    }

    try {
      const parsed: unknown = JSON.parse(trimmed);
      return parsed as HookJSONOutput;
    } catch {
      return null;
    }
  }

  processHookOutput(json: SyncHookJSONOutput, command?: string): Partial<HookResult> {
    const result: Partial<HookResult> = {
      outcome: 'success',
    };

    if (json.continue === false) {
      result.preventContinuation = true;
      if (json.stopReason) {
        result.stopReason = json.stopReason;
      }
    }

    if (json.decision) {
      switch (json.decision) {
        case 'approve':
          result.permissionBehavior = 'allow';
          break;
        case 'block':
          result.permissionBehavior = 'deny';
          result.blockingError = {
            blockingError: json.reason || 'Blocked by hook',
            command: command || '',
          };
          result.outcome = 'blocking';
          break;
      }
    }

    if (json.systemMessage) {
      result.systemMessage = json.systemMessage;
    }

    if (json.hookSpecificOutput) {
      const hs = json.hookSpecificOutput;

      if (hs.updatedInput) {
        result.updatedInput = hs.updatedInput;
      }

      if (hs.additionalContext) {
        result.additionalContext = hs.additionalContext;
      }

      if (hs.initialUserMessage) {
        result.initialUserMessage = hs.initialUserMessage;
      }

      if (hs.permissionDecision) {
        result.permissionBehavior = hs.permissionDecision as HookResult['permissionBehavior'];
      }

      if (hs.permissionDecisionReason) {
        result.hookPermissionDecisionReason = hs.permissionDecisionReason;
      }
    }

    return result;
  }
}

let defaultExecutor: HookExecutor | null = null;

export function getHookExecutor(modelRunner?: HookModelRunner, defaultModel: string | null = null): HookExecutor {
  if (!defaultExecutor) {
    defaultExecutor = new HookExecutor(defaultModel, DEFAULT_TIMEOUT_MS, modelRunner);
  }
  return defaultExecutor;
}

