/**
 * Tests for HealthServer
 *
 * Verifies health check endpoint returns proper status and distinguishes
 * between healthy and degraded component states.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HealthServer } from './health-server';
import http from 'node:http';

/**
 * Helper to make an HTTP GET request and return status code + parsed body.
 */
function fetchHealth(port: number, path = '/health'): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:${port}${path}`, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: data });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
  });
}

describe('HealthServer', () => {
  let server: HealthServer;
  let port: number;

  beforeEach(() => {
    port = 0; // let OS assign
  });

  afterEach(async () => {
    if (server) {
      await server.stop().catch(() => {});
    }
  });

  it('should return 200 with default status on /health', async () => {
    server = new HealthServer({ port: 0 });
    await server.start();

    // Get the actual port from the server
    const addr = (server as any).server?.address();
    port = addr?.port ?? 9090;

    const res = await fetchHealth(port);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('should return 200 on / as well', async () => {
    server = new HealthServer({ port: 0 });
    await server.start();

    const addr = (server as any).server?.address();
    port = addr?.port ?? 9090;

    const res = await fetchHealth(port, '/');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('should return 404 for unknown routes', async () => {
    server = new HealthServer({ port: 0 });
    await server.start();

    const addr = (server as any).server?.address();
    port = addr?.port ?? 9090;

    const res = await fetchHealth(port, '/unknown');
    expect(res.status).toBe(404);
  });

  it('should include uptime in response', async () => {
    server = new HealthServer({ port: 0 });
    await server.start();

    const addr = (server as any).server?.address();
    port = addr?.port ?? 9090;

    const res = await fetchHealth(port);
    expect(res.body.uptime).toBeTypeOf('number');
    expect(res.body.uptime).toBeGreaterThanOrEqual(0);
  });

  it('should include custom health info from getHealthInfo callback', async () => {
    server = new HealthServer({
      port: 0,
      getHealthInfo: () => ({
        status: 'ok',
        mode: 'paper',
        components: 5,
      }),
    });
    await server.start();

    const addr = (server as any).server?.address();
    port = addr?.port ?? 9090;

    const res = await fetchHealth(port);
    expect(res.body.mode).toBe('paper');
    expect(res.body.components).toBe(5);
  });

  it('should return HTTP 503 when getHealthInfo returns degraded status', async () => {
    server = new HealthServer({
      port: 0,
      getHealthInfo: () => ({
        status: 'degraded',
        mode: 'paper',
        components: 3,
      }),
    });
    await server.start();

    const addr = (server as any).server?.address();
    port = addr?.port ?? 9090;

    const res = await fetchHealth(port);
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
  });

  it('should include model readiness info in health response', async () => {
    server = new HealthServer({
      port: 0,
      getHealthInfo: () => ({
        status: 'ok',
        mode: 'paper',
        components: 5,
        startedAt: new Date('2025-01-01'),
        model: { status: 'ready', provider: 'openai', configuredModel: 'gpt-4', resolvedModel: 'gpt-4' },
      }),
    });
    await server.start();

    const addr = (server as any).server?.address();
    port = addr?.port ?? 9090;

    const res = await fetchHealth(port);
    expect(res.body.model.status).toBe('ready');
    expect(res.body.model.provider).toBe('openai');
  });

  it('should return HTTP 503 with degraded model state', async () => {
    server = new HealthServer({
      port: 0,
      getHealthInfo: () => ({
        status: 'degraded',
        mode: 'paper',
        components: 3,
        startedAt: new Date('2025-01-01'),
        model: { status: 'degraded', provider: 'openai', configuredModel: 'gpt-4', error: 'API timeout' },
      }),
    });
    await server.start();

    const addr = (server as any).server?.address();
    port = addr?.port ?? 9090;

    const res = await fetchHealth(port);
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.model.status).toBe('degraded');
    expect(res.body.model.error).toBe('API timeout');
  });
});
