import { describe, expect, it } from 'vitest';
import { JsonRpcClient } from '../src/rpc/client.js';

describe('JsonRpcClient transport lifecycle', () => {
  it('rejects an in-flight request when the runtime exits instead of hanging', async () => {
    const client = new JsonRpcClient(process.execPath, [
      '-e',
      'process.stderr.write("bootstrap failed"); process.exit(7)',
    ]);
    const failures: Error[] = [];
    client.on('transport.error', (error) => failures.push(error as Error));

    await expect(client.call('prompt.submit')).rejects.toThrow('DynaTrader runtime exited');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toContain('bootstrap failed');
  });
});
