/**
 * Hook configuration and execution service for Dynamind Terminal
 *
 * This module provides:
 * - Hook configuration interfaces
 * - Enhanced hook loader that executes all hook events
 * - Integration with registry, executor, and metrics
 * - Backward compatibility with existing preTool/postTool config
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { errorMessage as getErrorMessage } from '../../../utils/errors.js';
import { HookExecutor } from './hook-executor.js';
import { createHookMetricsCollector, getHookMetricsCollector } from './hook-metrics.js';
import { createHookRegistry } from './hook-registry.js';
import type {
  HookCommand,
  HookEvent,
  HookInput,
  HookJSONOutput,
  HooksSettings,
  SyncHookJSONOutput,
} from './hook-types.js';
import { hookEvents } from './hook-types.js';


export type { HookCommand, HookEvent, HookInput, HookJSONOutput, SyncHookJSONOutput };
export {
  createHookMetricsCollector,
  createHookRegistry,
  getHookMetricsCollector,
  hookEvents,
};
export { getHookExecutor } from './hook-executor.js';

export interface HookConfig {
  enabled: boolean;
  command: string;
}

export interface HooksConfig {
  preTool?: HookConfig;
  postTool?: HookConfig;
}

export interface HookPayload {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResult?: Record<string, unknown>;
  timestamp?: string;
}

export interface LegacyHookResult {
  modifiedInput?: Record<string, unknown>;
  shouldBlock: boolean;
  message?: string;
}

export interface DataStorageConfig {
  location: 'disk' | 'memory';
  path: string;
  format: 'markdown' | 'json';
}

export interface DynamindConfig {
  hooks?: HooksConfig;
  eventHooks?: HooksSettings;
  dataStorage?: DataStorageConfig;
}

export interface ExtendedHookResult extends LegacyHookResult {
  outcome?: 'success' | 'blocking' | 'non_blocking_error' | 'cancelled';
  systemMessage?: string;
  additionalContext?: string;
  updatedInput?: Record<string, unknown>;
  preventContinuation?: boolean;
  blockingError?: { blockingError: string; command: string };
}

export interface HookExecutorPort {
  execute(hook: HookCommand, input: HookInput): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  parseHookOutput(stdout: string): HookJSONOutput | null;
  processHookOutput(output: SyncHookJSONOutput, command?: string): Partial<import('./hook-types.js').HookResult>;
}

export class EnhancedHookLoader {
  private legacyLoader: LegacyHookLoader;
  private registry: ReturnType<typeof createHookRegistry>;
  private executor: HookExecutorPort;

  constructor(config: DynamindConfig, modelRunner?: import('./hook-executor.js').HookModelRunner, executor?: HookExecutorPort) {
    this.legacyLoader = new LegacyHookLoader(config);
    const configured = config.eventHooks ?? (isEventHookSettings(config.hooks) ? config.hooks : undefined);
    this.registry = createHookRegistry(configured);
    this.executor = executor ?? new HookExecutor(null, undefined, modelRunner);
  }

  async executePreToolHook(
    toolName: string,
    toolInput: Record<string, unknown>,
    sessionContext?: {
      sessionId?: string;
      transcriptPath?: string;
      cwd?: string;
      permissionMode?: string;
    }
  ): Promise<ExtendedHookResult> {
    const preToolResult = await this.legacyLoader.executePreToolHook(toolName, toolInput);

    if (preToolResult.shouldBlock) {
      return preToolResult;
    }

    if (preToolResult.modifiedInput) {
      return {
        ...preToolResult,
        updatedInput: preToolResult.modifiedInput,
      };
    }

    const matchResult = this.registry.matchHooks('PreToolUse', toolName, toolInput);

    if (matchResult.totalCount === 0) {
      return {
        shouldBlock: false,
        outcome: 'success',
      };
    }

    const input: HookInput = {
      hook_event_name: 'PreToolUse',
      session_id: sessionContext?.sessionId || 'default',
      transcript_path: sessionContext?.transcriptPath || '',
      cwd: sessionContext?.cwd || process.cwd(),
      permission_mode: sessionContext?.permissionMode,
      tool_name: toolName,
      tool_input: toolInput,
    };

    let finalResult: ExtendedHookResult = {
      shouldBlock: false,
      outcome: 'success',
    };

    for (const registeredHook of matchResult.hooks) {
      try {
        const result = await this.executor.execute(registeredHook.hook, input);
        const parsed = this.executor.parseHookOutput(result.stdout);
        if (parsed) {
          const processed = this.executor.processHookOutput(
            parsed as SyncHookJSONOutput,
            registeredHook.hook.type === 'command'
              ? (registeredHook.hook as { command?: string }).command
              : undefined
          );

          if (processed.blockingError) {
            finalResult = {
              shouldBlock: true,
              outcome: 'blocking',
              systemMessage: processed.systemMessage,
              blockingError: processed.blockingError,
            };
            break;
          }

          if (processed.updatedInput) {
            finalResult = {
              ...finalResult,
              updatedInput: processed.updatedInput,
            };
          }

          if (processed.systemMessage) {
            finalResult = {
              ...finalResult,
              systemMessage: processed.systemMessage,
            };
          }
        }
      } catch (error) {
        console.warn(`PreToolUse hook failed: ${registeredHook.id}`, error);
      }
    }

    return finalResult;
  }

  async executePostToolHook(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolResult: Record<string, unknown>,
    sessionContext?: {
      sessionId?: string;
      transcriptPath?: string;
      cwd?: string;
    }
  ): Promise<void> {
    await this.legacyLoader.executePostToolHook(toolName, toolInput, toolResult);

    const matchResult = this.registry.matchHooks('PostToolUse', toolName, toolInput);

    if (matchResult.totalCount === 0) {
      return;
    }

    const input: HookInput = {
      hook_event_name: 'PostToolUse',
      session_id: sessionContext?.sessionId || 'default',
      transcript_path: sessionContext?.transcriptPath || '',
      cwd: sessionContext?.cwd || process.cwd(),
      tool_name: toolName,
      tool_input: toolInput,
      tool_result: toolResult,
    };

    for (const registeredHook of matchResult.hooks) {
      try {
        await this.executor.execute(registeredHook.hook, input);
      } catch (error) {
        console.warn(`PostToolUse hook failed: ${registeredHook.id}`, error);
      }
    }
  }

  async executePostToolFailureHook(toolName: string, toolInput: Record<string, unknown>, toolResult: Record<string, unknown>, sessionContext?: { sessionId?: string; transcriptPath?: string; cwd?: string }): Promise<void> {
    const matches = this.registry.matchHooks('PostToolUseFailure', toolName, toolInput);
    const input: HookInput = {
      hook_event_name: 'PostToolUseFailure',
      session_id: sessionContext?.sessionId || 'default',
      transcript_path: sessionContext?.transcriptPath || '',
      cwd: sessionContext?.cwd || process.cwd(),
      tool_name: toolName,
      tool_input: toolInput,
      tool_result: toolResult,
    };
    for (const entry of matches.hooks) {
      try { await this.executor.execute(entry.hook, input); }
      catch (error) { console.warn(`PostToolUseFailure hook failed: ${entry.id}`, error); }
    }
  }

  async executeStopHooks(sessionContext?: {
    sessionId?: string;
    transcriptPath?: string;
    cwd?: string;
    permissionMode?: string;
  }): Promise<ExtendedHookResult[]> {
    const matchResult = this.registry.matchHooks('Stop');

    if (matchResult.totalCount === 0) {
      return [];
    }

    const input: HookInput = {
      hook_event_name: 'Stop',
      session_id: sessionContext?.sessionId || 'default',
      transcript_path: sessionContext?.transcriptPath || '',
      cwd: sessionContext?.cwd || process.cwd(),
      permission_mode: sessionContext?.permissionMode,
    };

    const results: ExtendedHookResult[] = [];

    for (const registeredHook of matchResult.hooks) {
      try {
        const result = await this.executor.execute(registeredHook.hook, input);
        if (result.exitCode !== 0) {
          results.push({ shouldBlock: false, outcome: 'non_blocking_error', systemMessage: result.stderr || `Hook exited ${result.exitCode}` });
          continue;
        }

        const parsed = this.executor.parseHookOutput(result.stdout);
        if (parsed) {
          const processed = this.executor.processHookOutput(
            parsed as SyncHookJSONOutput,
            registeredHook.hook.type === 'command'
              ? (registeredHook.hook as { command?: string }).command
              : undefined
          );

          results.push({
            shouldBlock: processed.preventContinuation || false,
            outcome: processed.outcome || 'success',
            systemMessage: processed.systemMessage,
            additionalContext: processed.additionalContext,
          });
        } else {
          results.push({ shouldBlock: false, outcome: 'success' });
        }
      } catch (error) {
        console.warn(`Stop hook failed: ${registeredHook.id}`, error);
        results.push({ shouldBlock: false, outcome: 'non_blocking_error', systemMessage: getErrorMessage(error) });
      }
    }

    return results;
  }

  async executeSessionStartHooks(sessionContext?: {
    sessionId?: string;
    transcriptPath?: string;
    cwd?: string;
  }): Promise<void> {
    const matchResult = this.registry.matchHooks('SessionStart');

    if (matchResult.totalCount === 0) {
      return;
    }

    const input: HookInput = {
      hook_event_name: 'SessionStart',
      session_id: sessionContext?.sessionId || 'default',
      transcript_path: sessionContext?.transcriptPath || '',
      cwd: sessionContext?.cwd || process.cwd(),
    };

    for (const registeredHook of matchResult.hooks) {
      try {
        await this.executor.execute(registeredHook.hook, input);
      } catch (error) {
        console.warn(`SessionStart hook failed: ${registeredHook.id}`, error);
      }
    }
  }

  async executeSessionEndHooks(sessionContext?: {
    sessionId?: string;
    transcriptPath?: string;
    cwd?: string;
  }): Promise<void> {
    const matchResult = this.registry.matchHooks('SessionEnd');

    if (matchResult.totalCount === 0) {
      return;
    }

    const input: HookInput = {
      hook_event_name: 'SessionEnd',
      session_id: sessionContext?.sessionId || 'default',
      transcript_path: sessionContext?.transcriptPath || '',
      cwd: sessionContext?.cwd || process.cwd(),
    };

    for (const registeredHook of matchResult.hooks) {
      try {
        await this.executor.execute(registeredHook.hook, input);
      } catch (error) {
        console.warn(`SessionEnd hook failed: ${registeredHook.id}`, error);
      }
    }
  }

  registerHook(event: HookEvent, matcher: string, hook: HookCommand): string {
    const id = `hook_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    this.registry.registerHook({
      id,
      event,
      matcher,
      hook,
      enabled: true,
      priority: 0,
    });

    return id;
  }

  unregisterHook(hookId: string): boolean {
    return this.registry.unregisterHook(hookId);
  }

  listHooks() {
    return this.registry.listHooks();
  }

  getMetrics() {
    const collector = getHookMetricsCollector();
    return collector.aggregate();
  }

  isEnabled(): boolean {
    return this.registry.isEnabled() || this.legacyLoader.isEnabled();
  }

  setEnabled(enabled: boolean): void {
    this.registry.setEnabled(enabled);
  }
}

class LegacyHookLoader {
  private hooksConfig: HooksConfig;

  constructor(config: DynamindConfig) {
    this.hooksConfig = config.hooks || {};
  }

  async executePreToolHook(
    toolName: string,
    toolInput: Record<string, unknown>
  ): Promise<LegacyHookResult> {
    const hookConfig = this.hooksConfig.preTool;

    if (!hookConfig || !hookConfig.enabled) {
      return { shouldBlock: false };
    }

    try {
      const payload: HookPayload = {
        toolName,
        toolInput,
        timestamp: new Date().toISOString(),
      };

      const result = await this.runHook(hookConfig.command, payload);

      if (result.shouldBlock) {
        return result;
      }

      if (result.modifiedInput) {
        return { modifiedInput: result.modifiedInput, shouldBlock: false };
      }

      return { shouldBlock: false };
    } catch (error) {
      console.warn(`Pre-tool hook failed: ${error}`);
      return { shouldBlock: false };
    }
  }

  async executePostToolHook(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolResult: Record<string, unknown>
  ): Promise<void> {
    const hookConfig = this.hooksConfig.postTool;

    if (!hookConfig || !hookConfig.enabled) {
      return;
    }

    try {
      const payload: HookPayload = {
        toolName,
        toolInput,
        toolResult,
        timestamp: new Date().toISOString(),
      };

      await this.runHook(hookConfig.command, payload);
    } catch (error) {
      console.warn(`Post-tool hook failed: ${error}`);
    }
  }

  private async runHook(command: string, payload: HookPayload): Promise<LegacyHookResult> {
    const { spawn } = await import('child_process');

    return new Promise((resolve, reject) => {
      const hookProcess = spawn(command, {
        stdio: ['pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      hookProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      hookProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      hookProcess.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Hook exited with code ${code}: ${stderr}`));
          return;
        }

        try {
          const result: unknown = JSON.parse(stdout);
          resolve(result as LegacyHookResult);
        } catch {
          resolve({ shouldBlock: false });
        }
      });
    });
  }

  isEnabled(): boolean {
    return !!(this.hooksConfig.preTool?.enabled || this.hooksConfig.postTool?.enabled);
  }
}

export async function loadHookConfig(): Promise<DynamindConfig> {
  const workspacePath = process.env['DYNA_WORKSPACE'] || join(homedir(), '.dynatrader', 'workspace');
  const statePath = process.env['DYNA_STATE_DIR'] || join(homedir(), '.dynatrader');
  const projectPath = process.cwd();
  const configPaths = [
    join(projectPath, 'hooks.config.json'),
    join(projectPath, '.dynamind', 'hooks.config.json'),
    join(workspacePath, 'hooks.config.json'),
    join(workspacePath, '.dynamind', 'hooks.config.json'),
    join(statePath, 'hooks.config.json'),
    join(homedir(), '.dynamind', 'hooks.config.json'),
  ];

  for (const configPath of new Set(configPaths)) {
    try {
      const { readFile } = await import('fs/promises');
      const content = await readFile(configPath, 'utf-8');
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object') {
        const config = parsed as Record<string, unknown>;
        if (isEventHookSettings(config.hooks)) {
          return { eventHooks: config.hooks as HooksSettings };
        }
        return config as DynamindConfig;
      }
    } catch {
      continue;
    }
  }

  return {
    hooks: {
      preTool: { enabled: false, command: '' },
      postTool: { enabled: false, command: '' },
    },
  };
}

function isEventHookSettings(value: unknown): value is HooksSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).some(([key, entries]) =>
    hookEvents.includes(key as HookEvent) && Array.isArray(entries)
  );
}

