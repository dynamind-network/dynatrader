import { describe, expect, it, vi } from 'vitest';
import { EnhancedHookLoader } from './hook-loader';
import type { HookExecutorPort } from './hook-loader';
import type { HookCommand, HookInput } from './hook-types';

describe('Core event hook runtime', () => {
  it('loads Claude-style event settings and blocks a matching tool before execution', async () => {
    const execute = vi.fn(async (_hook: HookCommand, _input: HookInput) => ({ stdout: JSON.stringify({ decision: 'block', reason: 'policy' }), stderr: '', exitCode: 0 }));
    const executor: HookExecutorPort = {
      execute,
      parseHookOutput: (stdout) => JSON.parse(stdout),
      processHookOutput: (output) => ({
        outcome: 'blocking',
        preventContinuation: output.decision === 'block',
        systemMessage: output.reason,
        blockingError: output.reason ? { blockingError: output.reason, command: 'hook' } : undefined,
      }),
    };
    const runtime = new EnhancedHookLoader({
      eventHooks: {
        PreToolUse: [{ matcher: 'exec', hooks: [{ type: 'command', command: 'node -e hook' }] }],
      },
    }, undefined, executor);

    const result = await runtime.executePreToolHook('exec', { command: 'echo hello' }, { sessionId: 's1', cwd: 'C:/repo' });

    expect(result.shouldBlock).toBe(true);
    expect(result.systemMessage).toBe('policy');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][1]).toMatchObject({
      hook_event_name: 'PreToolUse',
      session_id: 's1',
      cwd: 'C:/repo',
      tool_name: 'exec',
    });
  });

  it('does not run a matcher for another tool', async () => {
    const execute = vi.fn(async (_hook: HookCommand, _input: HookInput) => ({ stdout: '', stderr: '', exitCode: 0 }));
    const executor: HookExecutorPort = {
      execute,
      parseHookOutput: () => null,
      processHookOutput: () => ({}),
    };
    const runtime = new EnhancedHookLoader({
      eventHooks: {
        PreToolUse: [{ matcher: 'write', hooks: [{ type: 'command', command: 'node -e hook' }] }],
      },
    }, undefined, executor);

    const result = await runtime.executePreToolHook('read', {}, { sessionId: 's1' });

    expect(result.shouldBlock).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
});
