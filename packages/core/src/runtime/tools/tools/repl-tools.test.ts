import { describe, expect, it, vi } from 'vitest';
import type { ReplExecutionOutput, NodeReplService, PythonReplService } from '../../repl/session-runtime.js';
import { NodeReplTool, PythonReplTool } from './repl-tools.js';

function executor(output: ReplExecutionOutput = { stdout: 'ok', value: 42, durationMs: 3, truncated: false }) {
  return { execute: vi.fn(async (_sessionId: string, _source: string, _signal?: AbortSignal) => output) };
}

describe('REPL tools', () => {
  it('passes conversation session and abort signal to the Node REPL service', async () => {
    const service = executor();
    const tool = new NodeReplTool(service as Pick<NodeReplService, 'execute'>);
    const controller = new AbortController();

    const result = await tool.execute({ tool: 'node_repl', args: { code: '1 + 1' } }, { sessionId: 'session-a', signal: controller.signal });

    expect(service.execute).toHaveBeenCalledWith('session-a', '1 + 1', controller.signal);
    expect(result).toMatchObject({ success: true, data: { value: 42 }, stdout: 'ok', truncated: false });
  });

  it('passes conversation session and abort signal to the Python REPL service', async () => {
    const service = executor({ stderr: 'warning', value: { answer: 42 }, durationMs: 4, truncated: false });
    const tool = new PythonReplTool(service as Pick<PythonReplService, 'execute'>);
    const controller = new AbortController();

    const result = await tool.execute({ tool: 'python_repl', args: { code: 'print(42)' } }, { sessionId: 'session-b', signal: controller.signal });

    expect(service.execute).toHaveBeenCalledWith('session-b', 'print(42)', controller.signal);
    expect(result).toMatchObject({ success: true, data: { value: { answer: 42 } }, stderr: 'warning' });
  });

  it('rejects missing session ids and invalid code before calling the service', async () => {
    const service = executor();
    const tool = new NodeReplTool(service as Pick<NodeReplService, 'execute'>);

    const missingSession = await tool.execute({ tool: 'node_repl', args: { code: '1' } });
    const missingCode = await tool.execute({ tool: 'node_repl', args: {} }, { sessionId: 'session-a' });

    expect(missingSession).toMatchObject({ success: false, error: expect.stringContaining('sessionId') });
    expect(missingCode).toMatchObject({ success: false, error: expect.stringContaining('code') });
    expect(service.execute).not.toHaveBeenCalled();
  });

  it('bounds result fields and maps runtime failures into tool errors', async () => {
    const service = executor({ stdout: 's'.repeat(20_000), stderr: 'e'.repeat(20_000), value: 'v'.repeat(20_000), durationMs: 1, truncated: false });
    const tool = new PythonReplTool(service as Pick<PythonReplService, 'execute'>);
    const result = await tool.execute({ tool: 'python_repl', args: { code: 'large()' } }, { sessionId: 'session-a' });
    const serializedSize = (result.stdout?.length ?? 0) + (result.stderr?.length ?? 0) + JSON.stringify(result.data ?? '').length;

    expect(result.truncated).toBe(true);
    expect(serializedSize).toBeLessThanOrEqual(32_050);

    service.execute.mockRejectedValueOnce(new Error('kernel stopped'));
    await expect(tool.execute({ tool: 'python_repl', args: { code: '1' } }, { sessionId: 'session-a' }))
      .resolves.toMatchObject({ success: false, error: 'kernel stopped' });
  });

  it('marks general-purpose code execution as critical and permission gated', () => {
    const node = new NodeReplTool(executor() as Pick<NodeReplService, 'execute'>);
    const python = new PythonReplTool(executor() as Pick<PythonReplService, 'execute'>);

    expect(node.definition).toMatchObject({ riskLevel: 'critical', permissionsRequired: ['tool.node_repl'], sideEffects: ['code_execution'] });
    expect(python.definition).toMatchObject({ riskLevel: 'critical', permissionsRequired: ['tool.python_repl'], sideEffects: ['code_execution'] });
  });
});
