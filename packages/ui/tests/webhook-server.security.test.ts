import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebhookServer } from '../src/async/webhook-server.js';
import type { TaskQueue } from '../src/async/task-queue.js';
import type { WorkerPool } from '../src/async/worker-pool.js';

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', (error?: Error) => error ? reject(error) : resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not read temporary server port');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function dependencies() {
  const enqueue = vi.fn(() => ({ id: 'task-test', status: 'queued' }));
  const queue = { enqueue, getStats: () => ({}), clear: vi.fn() } as unknown as TaskQueue;
  const workers = { getPoolStats: () => ({ workers: [], completedTasks: 0, failedTasks: 0, uptime: 1 }) } as unknown as WorkerPool;
  return { enqueue, queue, workers };
}

describe('WebhookServer security', () => {
  const servers: WebhookServer[] = [];

  afterEach(async () => {
    delete process.env['ADMIN_RESET_KEY'];
    await Promise.all(servers.splice(0).map((server) => server.stop()));
  });

  it('refuses a non-loopback bind without an API key', async () => {
    const { queue, workers } = dependencies();
    const server = new WebhookServer(queue, workers, { host: '0.0.0.0', port: await unusedPort() });
    await expect(server.start()).rejects.toThrow(/requires an API key/i);
  });

  it('does not enqueue work when its callback URL is private', async () => {
    const { enqueue, queue, workers } = dependencies();
    const server = new WebhookServer(queue, workers, { host: '127.0.0.1', port: await unusedPort() });
    servers.push(server);
    const baseUrl = await server.start();

    const response = await fetch(`${baseUrl}/tasks/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'analysis', payload: {}, webhookUrl: 'http://[::1]/callback' }),
    });

    expect(response.status).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
  }, 15_000);

  it('does not accept the former hard-coded admin reset key', async () => {
    const { queue, workers } = dependencies();
    const server = new WebhookServer(queue, workers, { host: '127.0.0.1', port: await unusedPort() });
    servers.push(server);
    const baseUrl = await server.start();

    const response = await fetch(`${baseUrl}/reset`, {
      method: 'POST',
      headers: { 'x-admin-key': 'admin-reset-key' },
    });

    expect(response.status).toBe(503);
  });
});
