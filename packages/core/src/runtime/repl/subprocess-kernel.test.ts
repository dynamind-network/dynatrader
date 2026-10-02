import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import type { DynaSdkMethod } from "../sdk/dynatrader-sdk";
import { SubprocessReplKernelFactory } from "./subprocess-kernel";
import type { LocalSdkBridge } from "./session-runtime";

const pythonAvailable = spawnSync("python", ["--version"], { stdio: "ignore" }).status === 0;
const bridge: LocalSdkBridge = {
  methods: ["market.price"],
  async call<T>(method: DynaSdkMethod, params: Record<string, unknown>): Promise<T> {
    if (method !== "market.price") throw new Error("denied");
    return { method, params } as T;
  },
};

describe("SubprocessReplKernelFactory", () => {
  it("runs persistent Node code and relays SDK requests to the host", async () => {
    const kernel = await new SubprocessReplKernelFactory().create({ language: "node", sessionId: "node-test", sdk: bridge });
    try {
      await expect(kernel.execute("globalThis.counter = 40; console.log('ready', counter)", bridge, new AbortController().signal))
        .resolves.toMatchObject({ stdout: "ready 40" });
      await expect(kernel.execute("counter += 2; counter", bridge, new AbortController().signal))
        .resolves.toMatchObject({ value: 42 });
      await expect(kernel.execute("await sdk.call('market.price', {symbol:'BTC/USD'})", bridge, new AbortController().signal))
        .resolves.toMatchObject({ value: { method: "market.price", params: { symbol: "BTC/USD" } } });
    } finally {
      await kernel.dispose();
    }
    await expect(kernel.execute("1", bridge, new AbortController().signal)).rejects.toThrow(/closed/);
  }, 15_000);

  it.skipIf(!pythonAvailable)("runs persistent Python code and relays kwargs through sdk.call", async () => {
    const kernel = await new SubprocessReplKernelFactory().create({ language: "python", sessionId: "python-test", sdk: bridge });
    try {
      await expect(kernel.execute("counter = 40\nprint('ready', counter)", bridge, new AbortController().signal))
        .resolves.toMatchObject({ stdout: "ready 40\n" });
      await expect(kernel.execute("counter += 2\ncounter", bridge, new AbortController().signal))
        .resolves.toMatchObject({ value: 42 });
      await expect(kernel.execute("sdk.call('market.price', symbol='BTC/USD')", bridge, new AbortController().signal))
        .resolves.toMatchObject({ value: { method: "market.price", params: { symbol: "BTC/USD" } } });
    } finally {
      await kernel.dispose();
    }
  }, 15_000);

  it("kills a running worker when its execution signal aborts", async () => {
    const kernel = await new SubprocessReplKernelFactory().create({ language: "node", sessionId: "abort-test", sdk: bridge });
    const controller = new AbortController();
    const execution = kernel.execute("while (true) {}", bridge, controller.signal);
    setTimeout(() => controller.abort(), 25);
    await expect(execution).rejects.toThrow(/cancelled|disposed/i);
    await kernel.dispose();
  }, 10_000);
});
