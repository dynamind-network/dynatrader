/**
 * Kernel hot-reload lifecycle tests
 *
 * Exercises the existing PluginKernel across hot reload, unmount and stop,
 * dependency-failure policy, listener failure policies, and the lifecycle
 * traceability events published on the kernel bus (plugin.mounted /
 * plugin.unmounted / plugin.reload / plugin.stopped).
 */

import { describe, it, expect, vi } from "vitest";

import { KernelPluginKernel } from "./PluginKernel";
import {
  PluginDependencyError,
  PluginInitError,
  ServiceNotFoundError,
} from "./errors";
import type { KernelEvent, KernelPluginContext } from "./types";

describe("KernelPluginKernel hot-reload lifecycle", () => {
  it("reload re-mounts a plugin and publishes an updated service version", async () => {
    const kernel = new KernelPluginKernel();
    let version = 1;

    kernel.register({
      id: "svc",
      version: "1.0.0",
      init: (ctx) => {
        ctx.registerService("token", { version });
      },
      stop: () => {},
    });

    await kernel.mount("svc");
    expect(kernel.getService<{ version: number }>("token").version).toBe(1);

    version = 2;
    await kernel.reload("svc");

    expect(kernel.getService<{ version: number }>("token").version).toBe(2);
    expect(kernel.getMountedPlugins().map((p) => p.definition.id)).toEqual(["svc"]);
  });

  it("reload is idempotent: no duplicate services or listeners accumulate", async () => {
    const kernel = new KernelPluginKernel();
    let mountCount = 0;
    const listener = vi.fn();

    kernel.register({
      id: "p",
      version: "1.0.0",
      init: (ctx) => {
        mountCount += 1;
        ctx.registerService(`svc:${mountCount}`, { ok: true });
        ctx.on("ping", listener);
      },
      stop: () => {},
    });

    await kernel.mount("p");
    await kernel.reload("p");
    await kernel.reload("p");

    expect(mountCount).toBe(3);
    expect(kernel.getMountedPlugins()).toHaveLength(1);
    expect(kernel.hasService("svc:1")).toBe(false);
    expect(kernel.hasService("svc:2")).toBe(false);
    expect(kernel.hasService("svc:3")).toBe(true);

    await kernel.emit("ping");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("unmount removes services and runs the stop hook", async () => {
    const kernel = new KernelPluginKernel();
    const stop = vi.fn((ctx: KernelPluginContext) => {
      expect(ctx.id).toBe("u");
    });

    kernel.register({
      id: "u",
      version: "1.0.0",
      services: { legacy: { value: "x" } },
      init: (ctx) => {
        ctx.registerService("runtime", { value: "y" });
      },
      stop,
    });

    await kernel.mount("u");
    expect(kernel.hasService("legacy")).toBe(true);
    expect(kernel.hasService("runtime")).toBe(true);

    await kernel.unmount("u");

    expect(stop).toHaveBeenCalledTimes(1);
    expect(kernel.hasService("legacy")).toBe(false);
    expect(kernel.hasService("runtime")).toBe(false);
    expect(() => kernel.getService("legacy")).toThrow(ServiceNotFoundError);
    expect(kernel.getMountedPlugins()).toHaveLength(0);
  });

  it("stop runs every onStop hook in reverse mount order and closes processes", async () => {
    const kernel = new KernelPluginKernel();
    const stopped: string[] = [];
    const processClosed = vi.fn();

    kernel.register({
      id: "a",
      version: "1.0.0",
      services: { svcA: {} },
      init: () => {},
      stop: (ctx) => {
        stopped.push(ctx.id);
      },
    });
    kernel.register({
      id: "b",
      version: "1.0.0",
      dependencies: [{ service: "svcA" }],
      init: () => {},
      stop: (ctx) => {
        stopped.push(ctx.id);
        processClosed();
      },
    });

    await kernel.mountAll();
    await kernel.stop();

    expect(stopped).toEqual(["b", "a"]);
    expect(processClosed).toHaveBeenCalledTimes(1);
    expect(kernel.getMountedPlugins()).toHaveLength(0);
    expect(kernel.hasService("svcA")).toBe(false);
  });

  it("fails closed when a required dependency is missing", async () => {
    const kernel = new KernelPluginKernel();
    kernel.register({
      id: "orphan",
      version: "1.0.0",
      dependencies: [{ service: "missing" }],
      init: () => {},
    });

    await expect(kernel.mount("orphan")).rejects.toThrow(PluginDependencyError);
    await expect(kernel.mount("orphan")).rejects.toThrow(/missing/);
    expect(kernel.getMountedPlugins()).toHaveLength(0);
  });

  it("warns and continues when an optional dependency is missing", async () => {
    const kernel = new KernelPluginKernel();
    const init = vi.fn();

    kernel.register({
      id: "flex",
      version: "1.0.0",
      dependencies: [{ service: "maybe", optional: true }],
      init,
    });

    await kernel.mount("flex");
    expect(init).toHaveBeenCalledTimes(1);
    expect(kernel.getMountedPlugins().map((p) => p.definition.id)).toEqual(["flex"]);
  });

  it("propagates fail_closed listener failures and logs warn_only ones", async () => {
    const kernel = new KernelPluginKernel();
    const downstream = vi.fn();

    kernel.on(
      "topic",
      () => {
        throw new Error("strict boom");
      },
      { failurePolicy: "fail_closed" },
    );
    kernel.on(
      "topic",
      () => {
        throw new Error("warning boom");
      },
      { failurePolicy: "warn_only" },
    );
    kernel.on("topic", downstream);

    await expect(kernel.emit("topic")).rejects.toThrow("strict boom");
    expect(downstream).not.toHaveBeenCalled();

    const kernelWarn = new KernelPluginKernel();
    const warnDownstream = vi.fn();
    kernelWarn.on(
      "topic",
      () => {
        throw new Error("warning boom");
      },
      { failurePolicy: "warn_only" },
    );
    kernelWarn.on("topic", warnDownstream);

    await expect(kernelWarn.emit("topic")).resolves.toBeUndefined();
    expect(warnDownstream).toHaveBeenCalledTimes(1);
  });

  it("emits lifecycle events for mount, reload, unmount and stop", async () => {
    const kernel = new KernelPluginKernel();
    const events: string[] = [];
    const mountedPayloads: unknown[] = [];
    const unmountedPayloads: unknown[] = [];
    const reloadPayloads: unknown[] = [];
    const stoppedPayloads: unknown[] = [];

    kernel.on("plugin.mounted", (event: KernelEvent) => {
      events.push(event.type);
      mountedPayloads.push(event.payload);
    });
    kernel.on("plugin.unmounted", (event: KernelEvent) => {
      events.push(event.type);
      unmountedPayloads.push(event.payload);
    });
    kernel.on("plugin.reload", (event: KernelEvent) => {
      events.push(event.type);
      reloadPayloads.push(event.payload);
    });
    kernel.on("plugin.stopped", (event: KernelEvent) => {
      events.push(event.type);
      stoppedPayloads.push(event.payload);
    });

    kernel.register({
      id: "life",
      version: "2.3.4",
      init: () => {},
      stop: () => {},
    });

    await kernel.mount("life");
    await kernel.reload("life");
    await kernel.unmount("life");
    await kernel.mount("life");
    await kernel.stop();

    expect(events).toEqual([
      "plugin.mounted",
      "plugin.reload",
      "plugin.unmounted",
      "plugin.mounted",
      "plugin.unmounted",
      "plugin.mounted",
      "plugin.unmounted",
      "plugin.stopped",
    ]);
    expect(mountedPayloads).toEqual([
      { id: "life", version: "2.3.4" },
      { id: "life", version: "2.3.4" },
      { id: "life", version: "2.3.4" },
    ]);
    expect(unmountedPayloads).toEqual([
      { id: "life" },
      { id: "life" },
      { id: "life" },
    ]);
    expect(reloadPayloads).toEqual([{ id: "life" }]);
    expect(stoppedPayloads).toEqual([{ plugins: ["life"] }]);
  });

  it("keeps lifecycle events informational when a listener rethrows", async () => {
    const kernel = new KernelPluginKernel({ strict: false });
    kernel.on(
      "plugin.mounted",
      () => {
        throw new Error("observer broken");
      },
      { failurePolicy: "fail_open" },
    );

    kernel.register({ id: "ok", version: "1.0.0", init: () => {}, stop: () => {} });
    await expect(kernel.mount("ok")).resolves.toBeUndefined();
    expect(kernel.getMountedPlugins()).toHaveLength(1);
  });

  it("init failure rolls back services and reload after fix succeeds", async () => {
    const kernel = new KernelPluginKernel();
    let shouldFail = true;

    kernel.register({
      id: "flaky",
      version: "1.0.0",
      services: { flakySvc: { ready: true } },
      init: () => {
        if (shouldFail) {
          throw new Error("flaky init");
        }
      },
      stop: () => {},
    });

    await expect(kernel.mount("flaky")).rejects.toThrow(PluginInitError);
    expect(kernel.hasService("flakySvc")).toBe(false);

    shouldFail = false;
    await kernel.reload("flaky");

    expect(kernel.getMountedPlugins().map((p) => p.definition.id)).toEqual(["flaky"]);
    expect(kernel.hasService("flakySvc")).toBe(true);
  });
});