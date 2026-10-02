import { describe, expect, it } from "vitest";
import { DYNA_SDK_METHODS } from "../sdk/dynatrader-sdk";
import type { DynaSdkCallContext, DynaSdkInvoker, DynaSdkMethod } from "../sdk/dynatrader-sdk";
import { NodeReplService, PythonReplService, SessionReplRuntime } from "./session-runtime";
import type {
  LocalSdkBridge,
  ReplKernel,
  ReplKernelFactory,
} from "./session-runtime";

const sdk: DynaSdkInvoker = {
  async invoke<T>(method: DynaSdkMethod, _params: Record<string, unknown>, context: DynaSdkCallContext): Promise<T> {
    if (context.signal?.aborted) throw new Error("aborted");
    return { method, sessionId: context.sessionId } as T;
  },
};

class FakeKernel implements ReplKernel {
  disposed = false;
  calls = 0;
  constructor(private readonly executeFn?: ReplKernel["execute"]) {}
  execute(source: string, bridge: LocalSdkBridge, signal: AbortSignal) {
    this.calls++;
    return this.executeFn
      ? this.executeFn(source, bridge, signal)
      : Promise.resolve({ stdout: source });
  }
  async dispose() { this.disposed = true; }
}

function factoryFor(make: (language: string, sessionId: string) => FakeKernel) {
  const made: FakeKernel[] = [];
  const factory: ReplKernelFactory = {
    async create({ language, sessionId }) {
      const kernel = make(language, sessionId);
      made.push(kernel);
      return kernel;
    },
  };
  return { factory, made };
}

describe("SessionReplRuntime", () => {
  it("keeps persistent kernels separate by language and conversation", async () => {
    const { factory, made } = factoryFor(() => new FakeKernel());
    const runtime = new SessionReplRuntime(factory, sdk);
    await runtime.execute("node", "conversation-a", "one");
    await runtime.execute("node", "conversation-a", "two");
    await runtime.execute("python", "conversation-a", "three");
    await runtime.execute("node", "conversation-b", "four");
    expect(made).toHaveLength(3);
    expect(made[0]!.calls).toBe(2);
  });

  it("offers explicit Node and Python services over the shared manager", async () => {
    const { factory, made } = factoryFor(() => new FakeKernel());
    const runtime = new SessionReplRuntime(factory, sdk);
    const node = new NodeReplService(runtime);
    const python = new PythonReplService(runtime);
    await node.execute("s", "node code");
    await python.execute("s", "python code");
    expect(made).toHaveLength(2);
  });

  it("bounds combined output and reports truncation", async () => {
    const { factory } = factoryFor(() => new FakeKernel(async () => ({ stdout: "12345", stderr: "67890" })));
    const runtime = new SessionReplRuntime(factory, sdk, { maxOutputChars: 7 });
    const output = await runtime.execute("node", "s", "x");
    expect(output.stdout).toBe("12345");
    expect(output.stderr).toBe("67");
    expect(output.truncated).toBe(true);
  });

  it("routes order methods through the host SDK callback and exposes only its allowlist", async () => {
    let bridge!: LocalSdkBridge;
    const routed: Array<{ method: DynaSdkMethod; sessionId: string; hasSignal: boolean }> = [];
    const invoker: DynaSdkInvoker = {
      async invoke<T>(method: DynaSdkMethod, _params: Record<string, unknown>, context: DynaSdkCallContext): Promise<T> {
        routed.push({ method, sessionId: context.sessionId, hasSignal: context.signal !== undefined });
        return { acceptedByHost: method } as T;
      },
    };
    const { factory } = factoryFor(() => new FakeKernel(async (_source, sdkBridge) => {
      bridge = sdkBridge;
      await expect(sdkBridge.call("trading.proposeOrder", { symbol: "BTC/USD", side: "buy" })).resolves.toEqual({ acceptedByHost: "trading.proposeOrder" });
      await expect(sdkBridge.call("trading.executeOrder", { proposalId: "p-1" })).resolves.toEqual({ acceptedByHost: "trading.executeOrder" });
      return { stdout: "ok" };
    }));
    const runtime = new SessionReplRuntime(factory, invoker);
    await runtime.execute("node", "s", "read only");
    expect(bridge.methods).toEqual(DYNA_SDK_METHODS);
    expect(routed).toEqual([
      { method: "trading.proposeOrder", sessionId: "s", hasSignal: true },
      { method: "trading.executeOrder", sessionId: "s", hasSignal: true },
    ]);
    expect([...bridge.methods]).not.toContain("orders.execute");
  });

  it("times out, terminates the kernel and rejects promptly", async () => {
    let kernel!: FakeKernel;
    const { factory } = factoryFor(() => {
      kernel = new FakeKernel(() => new Promise(() => {}));
      return kernel;
    });
    const runtime = new SessionReplRuntime(factory, sdk, { timeoutMs: 10 });
    await expect(runtime.execute("python", "s", "while true")).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(kernel.disposed).toBe(true);
  });

  it("cancels active execution and tears down its session kernel", async () => {
    let kernel!: FakeKernel;
    const { factory } = factoryFor(() => {
      kernel = new FakeKernel(() => new Promise(() => {}));
      return kernel;
    });
    const runtime = new SessionReplRuntime(factory, sdk, { timeoutMs: 10_000 });
    const execution = runtime.execute("node", "s", "long task");
    await new Promise((resolve) => setImmediate(resolve));
    await runtime.cancel("node", "s");
    await expect(execution).rejects.toMatchObject({ code: "CANCELLED" });
    expect(kernel.disposed).toBe(true);
  });

  it("serializes calls within a session and closes it", async () => {
    const order: string[] = [];
    const { factory, made } = factoryFor(() => new FakeKernel(async (source) => {
      order.push(`start:${source}`);
      await new Promise((resolve) => setTimeout(resolve, source === "a" ? 8 : 0));
      order.push(`end:${source}`);
      return { stdout: source };
    }));
    const runtime = new SessionReplRuntime(factory, sdk);
    await Promise.all([
      runtime.execute("node", "s", "a"),
      runtime.execute("node", "s", "b"),
    ]);
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
    expect(await runtime.close("node", "s")).toBe(true);
    expect(made[0]!.disposed).toBe(true);
    await expect(runtime.execute("node", "s", "closed")).rejects.toMatchObject({ code: "CLOSED" });
    runtime.open("node", "s");
    await expect(runtime.execute("node", "s", "reopened")).resolves.toMatchObject({ stdout: "reopened" });
  });
});
