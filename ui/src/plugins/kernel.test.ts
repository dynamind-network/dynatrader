import { describe, it, expect, vi } from 'vitest';
import {
  PluginKernel,
  PluginDependencyError,
  type KernelPluginDefinition,
} from './kernel.js';

describe('PluginKernel', () => {
  it('mounts plugins and exposes provided services', async () => {
    const kernel = new PluginKernel();
    kernel.register({
      name: 'config',
      provides: [{ service: 'config', value: { theme: 'dark' } }],
    });
    await kernel.mount('config');

    expect(kernel.hasService('config')).toBe(true);
    expect(kernel.getService<{ theme: string }>('config')).toEqual({
      theme: 'dark',
    });
  });

  it('mounts plugins in topological order by dependency service', async () => {
    const kernel = new PluginKernel();
    const order: string[] = [];

    kernel.register({
      name: 'database',
      setup: async () => {
        order.push('database');
      },
      provides: [{ service: 'db', value: {} }],
    });
    kernel.register({
      name: 'repository',
      dependencies: [{ service: 'db' }],
      setup: async () => {
        order.push('repository');
      },
    });
    kernel.register({
      name: 'service',
      dependencies: [{ service: 'db' }],
      setup: async () => {
        order.push('service');
      },
    });

    await kernel.mount('service');
    expect(order).toEqual(['database', 'service']);
  });

  it('runs setup for every plugin via mountAll', async () => {
    const kernel = new PluginKernel();
    const setup = vi.fn();
    kernel.register({ name: 'a', setup });
    kernel.register({ name: 'b', setup });

    await kernel.mountAll();
    expect(setup).toHaveBeenCalledTimes(2);
  });

  it('provides services to dependents through the context', async () => {
    const kernel = new PluginKernel();
    let seen: unknown;

    kernel.register({
      name: 'provider',
      setup: async (ctx) => {
        ctx.provide('greeting', 'hello');
      },
    });
    kernel.register({
      name: 'consumer',
      dependencies: [{ service: 'greeting' }],
      setup: async (ctx) => {
        seen = ctx.getService('greeting');
      },
    });

    await kernel.mountAll();
    expect(seen).toBe('hello');
  });

  it('emits events to subscribers and detaches listeners', async () => {
    const kernel = new PluginKernel();
    const a = vi.fn();
    const b = vi.fn();
    const off = kernel.on('loaded', a);
    kernel.on('loaded', b);

    kernel.emit('loaded', { id: 1 });
    expect(a).toHaveBeenCalledWith({ id: 1 }, 'loaded');
    expect(b).toHaveBeenCalledWith({ id: 1 }, 'loaded');

    off();
    kernel.emit('loaded', { id: 2 });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('throws PluginDependencyError when a required service is missing', async () => {
    const kernel = new PluginKernel();
    kernel.register({
      name: 'orphan',
      dependencies: [{ service: 'missing' }],
    });

    await expect(kernel.mount('orphan')).rejects.toBeInstanceOf(
      PluginDependencyError,
    );
  });

  it('honors failPolicy warn and still mounts', async () => {
    const kernel = new PluginKernel();
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    kernel.register({
      name: 'opt',
      failPolicy: 'warn',
      dependencies: [{ service: 'missing' }],
      setup: async (ctx) => {
        ctx.provide('opt-ready', true);
      },
    });

    await kernel.mount('opt');
    expect(kernel.getService('opt-ready')).toBe(true);
    spy.mockRestore();
  });

  it('unmounts plugins and removes their services', async () => {
    const kernel = new PluginKernel();
    const teardown = vi.fn();
    kernel.register({
      name: 'p',
      provides: [{ service: 'p.svc', value: 42 }],
      teardown,
    });

    await kernel.mount('p');
    expect(kernel.hasService('p.svc')).toBe(true);

    await kernel.unmount('p');
    expect(kernel.hasService('p.svc')).toBe(false);
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it('mounts dependencies exposed via provides[] value automatically', async () => {
    const kernel = new PluginKernel();
    let db: unknown;
    kernel.register({
      name: 'db',
      provides: [{ service: 'db', value: { connected: true } }],
    });
    kernel.register({
      name: 'repo',
      dependencies: [{ service: 'db' }],
      setup: async (ctx) => {
        db = ctx.getService('db');
      },
    });

    await kernel.mount('repo');
    expect(db).toEqual({ connected: true });
  });

  it('exposes a live kernel to plugins through the context', async () => {
    const kernel = new PluginKernel();
    kernel.register({
      name: 'a',
      provides: [{ service: 'a.svc', value: 1 }],
    });
    let got: boolean | undefined;
    kernel.register({
      name: 'b',
      dependencies: [{ service: 'a.svc' }],
      setup: async (ctx) => {
        got = ctx.kernel.hasService('a.svc');
      },
    });

    await kernel.mount('b');
    expect(got).toBe(true);
  });
});
