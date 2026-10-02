/**
 * PluginKernel Tests
 *
 * Covers: registration, topological mounting, dependency injection, error
 * handling, the event bus (emit/on + failure policies), unmount/stop, reload,
 * and service lookup.
 */

import { describe, it, expect, vi } from "vitest";

import { KernelPluginKernel } from "./PluginKernel";
import {
  PluginDependencyError,
  PluginInitError,
  DuplicatePluginError,
  ServiceNotFoundError,
} from "./errors";
import type {
  KernelEvent,
  KernelPluginContext,
  PluginDefinition,
  MountResult,
} from "./types";

describe("KernelPluginKernel", () => {
  describe("register", () => {
    it("registers a plugin with a registered status", () => {
      const kernel = new KernelPluginKernel();
      kernel.register({ id: "p", version: "1.0.0", init: () => {} });
      expect(kernel.getPlugin("p")).toBeDefined();
      expect(kernel.getPlugin("p")?.status).toBe("registered");
      expect(kernel.getMountedPlugins()).toHaveLength(0);
    });

    it("returns undefined for unknown plugins", () => {
      const kernel = new KernelPluginKernel();
      expect(kernel.getPlugin("nope")).toBeUndefined();
    });

    it("throws DuplicatePluginError when an id is registered twice", () => {
      const kernel = new KernelPluginKernel();
      const definition: PluginDefinition = { id: "dup", version: "1.0.0", init: () => {} };
      kernel.register(definition);
      expect(() => kernel.register(definition)).toThrow(DuplicatePluginError);
      expect(() => kernel.register(definition)).toThrow(/dup/);
    });
  });

  describe("mountAll / topological ordering", () => {
    it("mounts plugins in topological dependency order", async () => {
      const order: string[] = [];
      const kernel = new KernelPluginKernel();

      kernel.register({
        id: "db",
        version: "1.0.0",
        services: { dbClient: { connected: true } },
        init: () => {
          order.push("db");
        },
      });
      kernel.register({
        id: "repo",
        version: "1.0.0",
        dependencies: [{ service: "dbClient" }],
        init: (ctx) => {
          order.push("repo");
          void ctx.getService("dbClient");
        },
      });
      kernel.register({
        id: "api",
        version: "1.0.0",
        dependencies: [{ service: "dbClient" }],
        init: () => {
          order.push("api");
        },
      });

      const results = await kernel.mountAll();

      expect(results.map((result: MountResult) => result.ok).every(Boolean)).toBe(true);
      expect(order.indexOf("db")).toBeLessThan(order.indexOf("repo"));
      expect(order.indexOf("db")).toBeLessThan(order.indexOf("api"));
      expect(kernel.getMountedPlugins().map((p) => p.definition.id).sort()).toEqual([
        "api",
        "db",
        "repo",
      ]);
    });

    it("resolves transitive dependencies", async () => {
      const order: string[] = [];
      const kernel = new KernelPluginKernel();

      kernel.register({
        id: "a",
        version: "1.0.0",
        services: { sa: {} },
        init: () => {
          order.push("a");
        },
      });
      kernel.register({
        id: "b",
        version: "1.0.0",
        services: { sb: {} },
        dependencies: [{ service: "sa" }],
        init: () => {
          order.push("b");
        },
      });
      kernel.register({
        id: "c",
        version: "1.0.0",
        dependencies: [{ service: "sb" }],
        init: () => {
          order.push("c");
        },
      });

      await kernel.mountAll();
      expect(order).toEqual(["a", "b", "c"]);
    });
  });

  describe("dependency injection", () => {
    it("exposes services of one plugin to a dependent plugin", async () => {
      const kernel = new KernelPluginKernel();

      kernel.register({
        id: "provider",
        version: "1.0.0",
        services: { cache: { get: (key: string) => `value:${key}` } },
        init: () => {},
      });

      let seen: unknown;
      kernel.register({
        id: "consumer",
        version: "1.0.0",
        dependencies: [{ service: "cache" }],
        init: (ctx) => {
          seen = ctx.getService<{ get: (key: string) => string }>("cache");
        },
      });

      await kernel.mountAll();

      expect(seen).toEqual({ get: expect.any(Function) });
      const cache = kernel.getService<{ get: (key: string) => string }>("cache");
      expect(cache.get("k")).toBe("value:k");
    });

    it("throws PluginDependencyError when a required service is missing", async () => {
      const kernel = new KernelPluginKernel();
      kernel.register({
        id: "orphan",
        version: "1.0.0",
        dependencies: [{ service: "missing-service" }],
        init: () => {},
      });

      await expect(kernel.mount("orphan")).rejects.toThrow(PluginDependencyError);
      await expect(kernel.mount("orphan")).rejects.toThrow(/missing-service/);
    });

    it("does not throw when an optional dependency is missing", async () => {
      const kernel = new KernelPluginKernel();
      let seen: unknown;
      kernel.register({
        id: "flexible",
        version: "1.0.0",
        dependencies: [{ service: "maybe", optional: true }],
        init: (ctx) => {
          seen = ctx.services["maybe"];
        },
      });

      await kernel.mount("flexible");
      expect(seen).toBeUndefined();
    });

    it("detects dependency cycles", async () => {
      const kernel = new KernelPluginKernel();
      kernel.register({
        id: "x",
        version: "1.0.0",
        services: { sa: {} },
        dependencies: [{ service: "sb" }],
        init: () => {},
      });
      kernel.register({
        id: "y",
        version: "1.0.0",
        services: { sb: {} },
        dependencies: [{ service: "sa" }],
        init: () => {},
      });

      await expect(kernel.mount("x")).rejects.toThrow(/cycle/i);
    });
  });

  describe("event bus", () => {
    it("round-trips an event to an on() listener", async () => {
      const kernel = new KernelPluginKernel();
      let received: KernelEvent | undefined;
      kernel.on("my.event", (event) => {
        received = event;
      });

      await kernel.emit("my.event", { a: 1 });

      expect(received?.type).toBe("my.event");
      expect(received?.payload).toEqual({ a: 1 });
      expect(received?.timestamp).toBeInstanceOf(Date);
    });

    it("unsubscribe stops delivery", async () => {
      const kernel = new KernelPluginKernel();
      let seen = 0;
      const unsubscribe = kernel.on("my.event", () => {
        seen += 1;
      });

      await kernel.emit("my.event", { n: 1 });
      unsubscribe();
      await kernel.emit("my.event", { n: 2 });

      expect(seen).toBe(1);
    });

    it("does not propagate fail_open failures and keeps the bus running", async () => {
      const kernel = new KernelPluginKernel();
      const downstream = vi.fn();
      kernel.on(
        "noisy",
        () => {
          throw new Error("handler boom");
        },
        { failurePolicy: "fail_open" },
      );
      kernel.on("noisy", downstream);

      await expect(kernel.emit("noisy")).resolves.toBeUndefined();
      expect(downstream).toHaveBeenCalledTimes(1);
    });

    it("does not propagate warn_only failures", async () => {
      const kernel = new KernelPluginKernel();
      const downstream = vi.fn();
      kernel.on(
        "warny",
        () => {
          throw new Error("warning boom");
        },
        { failurePolicy: "warn_only" },
      );
      kernel.on("warny", downstream);

      await expect(kernel.emit("warny")).resolves.toBeUndefined();
      expect(downstream).toHaveBeenCalledTimes(1);
    });

    it("propagates fail_closed failures", async () => {
      const kernel = new KernelPluginKernel();
      kernel.on(
        "strict",
        () => {
          throw new Error("strict boom");
        },
        { failurePolicy: "fail_closed" },
      );

      await expect(kernel.emit("strict")).rejects.toThrow("strict boom");
    });
  });

  describe("lifecycle", () => {
    it("unmount calls stop and removes contributed services", async () => {
      const kernel = new KernelPluginKernel();
      const stop = vi.fn();

      kernel.register({
        id: "provider",
        version: "1.0.0",
        services: { token: { value: 1 } },
        init: () => {},
        stop,
      });

      await kernel.mount("provider");
      expect(kernel.hasService("token")).toBe(true);

      await kernel.unmount("provider");

      expect(stop).toHaveBeenCalledTimes(1);
      expect(kernel.hasService("token")).toBe(false);
      expect(() => kernel.getService("token")).toThrow(ServiceNotFoundError);
      expect(kernel.getMountedPlugins()).toHaveLength(0);
    });

    it("unmount unsubscribes listeners registered through the plugin context", async () => {
      const kernel = new KernelPluginKernel();
      let calls = 0;

      kernel.register({
        id: "listener-plugin",
        version: "1.0.0",
        init: (ctx) => {
          ctx.on("ping", () => {
            calls += 1;
          });
        },
      });

      await kernel.mount("listener-plugin");
      await kernel.emit("ping");
      await kernel.unmount("listener-plugin");
      await kernel.emit("ping");

      expect(calls).toBe(1);
    });

    it("reload re-runs init with a fresh context", async () => {
      const kernel = new KernelPluginKernel();
      const contexts: KernelPluginContext[] = [];
      let token = 0;

      kernel.register({
        id: "reloadable",
        version: "1.0.0",
        services: { marker: { value: 1 } },
        init: (ctx) => {
          token += 1;
          contexts.push(ctx);
          ctx.registerService("extra", { value: 2 });
        },
        stop: () => {},
      });

      await kernel.mount("reloadable");
      expect(token).toBe(1);
      expect(kernel.hasService("extra")).toBe(true);

      await kernel.reload("reloadable");

      expect(token).toBe(2);
      expect(contexts[1]).not.toBe(contexts[0]);
      expect(kernel.hasService("marker")).toBe(true);
      expect(kernel.hasService("extra")).toBe(true);
    });

    it("stop unmounts all mounted plugins in reverse mount order", async () => {
      const kernel = new KernelPluginKernel();
      const unmounted: string[] = [];

      kernel.register({
        id: "a",
        version: "1.0.0",
        services: { svcA: {} },
        init: () => {},
        stop: (ctx) => {
          unmounted.push(ctx.id);
        },
      });
      kernel.register({
        id: "b",
        version: "1.0.0",
        dependencies: [{ service: "svcA" }],
        init: () => {},
        stop: (ctx) => {
          unmounted.push(ctx.id);
        },
      });

      await kernel.mountAll();
      expect(kernel.getMountedPlugins()).toHaveLength(2);

      await kernel.stop();

      expect(unmounted).toEqual(["b", "a"]);
      expect(kernel.getMountedPlugins()).toHaveLength(0);
      expect(kernel.hasService("svcA")).toBe(false);
    });
  });

  describe("service lookup", () => {
    it("throws ServiceNotFoundError for unknown services", () => {
      const kernel = new KernelPluginKernel();
      expect(kernel.hasService("nope")).toBe(false);
      expect(() => kernel.getService("nope")).toThrow(ServiceNotFoundError);
    });
  });

  describe("mount failures", () => {
    it("throws PluginInitError when init throws and rolls back contributed services", async () => {
      const kernel = new KernelPluginKernel();
      kernel.register({
        id: "bomb",
        version: "1.0.0",
        services: { partial: { value: 1 } },
        init: (ctx) => {
          ctx.registerService("duringInit", { value: 2 });
          throw new Error("init boom");
        },
      });

      await expect(kernel.mount("bomb")).rejects.toThrow(PluginInitError);
      await expect(kernel.mount("bomb")).rejects.toThrow(/init boom/);
      expect(kernel.hasService("partial")).toBe(false);
      expect(kernel.hasService("duringInit")).toBe(false);
      expect(kernel.getMountedPlugins()).toHaveLength(0);
    });

    it("mountAll continues past failures in non-strict mode", async () => {
      const kernel = new KernelPluginKernel({ strict: false });
      kernel.register({
        id: "good",
        version: "1.0.0",
        init: () => {},
      });
      kernel.register({
        id: "bad",
        version: "1.0.0",
        init: () => {
          throw new Error("no way");
        },
      });

      const results = await kernel.mountAll();

      const bad = results.find((r) => r.id === "bad");
      expect(bad?.ok).toBe(false);
      expect(bad?.error).toContain("no way");
      expect(kernel.getMountedPlugins().map((p) => p.definition.id)).toEqual(["good"]);
    });

    it("mountAll rethrows the first failure in strict mode (default)", async () => {
      const kernel = new KernelPluginKernel();
      kernel.register({ id: "a", version: "1.0.0", init: () => {} });
      kernel.register({
        id: "fails",
        version: "1.0.0",
        init: () => {
          throw new Error("strict halt");
        },
      });

      await expect(kernel.mountAll()).rejects.toThrow(/strict halt/);
    });
  });
});