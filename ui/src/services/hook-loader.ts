/**
 * Hook configuration and execution service for Dynamind Terminal
 *
 * This module provides:
 * - Hook configuration interfaces
 * - Enhanced hook loader that executes all hook events
 * - Integration with registry, executor, and metrics
 * - Backward compatibility with existing preTool/postTool config
 */
import { getHomeDirectory, DYNAMIND_DIR, getDynamindPath } from '../utils/constants.js';
import { createHookRegistry } from './hook-registry.js';
import { getHookExecutor } from './hook-executor.js';
import { getHookMetricsCollector, createHookMetricsCollector } from './hook-metrics.js';
import type {
  HookCommand,
  HookEvent,
  HookInput,
  HookJSONOutput,
  SyncHookJSONOutput,
} from './hook-types.js';
import { hookEvents } from './hook-types.js';
import { parseJson } from '../utils/json.js';

export {
  createHookRegistry,
  getHookExecutor,
  getHookMetricsCollector,
  createHookMetricsCollector,
  hookEvents,
};

export type { HookCommand, HookEvent, HookInput, HookJSONOutput, SyncHookJSONOutput };

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

export class EnhancedHookLoader {
  private legacyLoader: LegacyHookLoader;
  private registry: ReturnType<typeof createHookRegistry>;
  private executor: ReturnType<typeof getHookExecutor>;

  constructor(config: DynamindConfig) {
    this.legacyLoader = new LegacyHookLoader(config);
    this.registry = createHookRegistry();
    this.executor = getHookExecutor();
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
        }
      } catch (error) {
        console.warn(`Stop hook failed: ${registeredHook.id}`, error);
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
          const result = parseJson(stdout);
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

let defaultEnhancedHookLoader: EnhancedHookLoader | null = null;

export function getEnhancedHookLoader(): EnhancedHookLoader {
  if (!defaultEnhancedHookLoader) {
    const config: DynamindConfig = {
      hooks: {
        preTool: {
          enabled: false,
          command: 'node packages/core/src/services/hook-scripts/pre-tool-hook.js',
        },
        postTool: {
          enabled: false,
          command: 'node packages/core/src/services/hook-scripts/post-tool-hook.js',
        },
      },
    };

    defaultEnhancedHookLoader = new EnhancedHookLoader(config);
  }

  return defaultEnhancedHookLoader;
}

export async function loadHookConfig(): Promise<DynamindConfig> {
  const configPaths = ['hooks.config.json', getDynamindPath('hooks.config.json')];

  for (const configPath of configPaths) {
    try {
      const { readFile } = await import('fs/promises');
      const content = await readFile(configPath, 'utf-8');
      const parsed = parseJson(content);
      if (parsed) {
        return parsed as DynamindConfig;
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
