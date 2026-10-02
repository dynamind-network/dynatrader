import { describe, expect, it, vi } from "vitest";
import { HooksManager } from "./hooks";
import { LifecycleHooks } from "./lifecycle-hooks";

describe("LifecycleHooks", () => {
  it("runs programmatic pre-tool hooks before configured hooks and applies modifications", async () => {
    const order: string[] = [];
    const programmatic = new HooksManager();
    programmatic.register({
      id: "programmatic",
      event: "pre-tool-call",
      handler: async () => {
        order.push("programmatic");
        return { continue: true, modify: { fromProgrammatic: true } };
      },
    });
    const configured = {
      executePreToolHook: vi.fn(async (_name, _args) => {
        order.push("configured");
        return { shouldBlock: false, updatedInput: { fromConfigured: true } };
      }),
    };
    const hooks = new LifecycleHooks({ programmatic, configured: configured as any });
    const call = { tool: "read", args: { original: true } } as any;

    await expect(hooks.preTool(call, { sessionId: "s1" })).resolves.toBe(true);
    expect(order).toEqual(["programmatic", "configured"]);
    expect(configured.executePreToolHook).toHaveBeenCalledWith("read", { fromProgrammatic: true }, { sessionId: "s1" });
    expect(call.args).toEqual({ fromConfigured: true });
  });

  it("stops configured dispatch when a programmatic pre-tool hook blocks", async () => {
    const programmatic = new HooksManager();
    programmatic.register({
      id: "blocker",
      event: "pre-tool-call",
      handler: async () => ({ continue: false }),
    });
    const executePreToolHook = vi.fn();
    const hooks = new LifecycleHooks({ programmatic, configured: { executePreToolHook } as any });

    await expect(hooks.preTool({ tool: "exec", args: {} } as any, {})).resolves.toBe(false);
    expect(executePreToolHook).not.toHaveBeenCalled();
  });

  it("dispatches durable post-turn work once through its adapter", () => {
    const postTurn = vi.fn(async () => {});
    const hooks = new LifecycleHooks({ programmatic: new HooksManager(), postTurn });
    const deps = { sessionId: "s1", userMessage: "hello" } as any;

    hooks.postTurn(deps);
    expect(postTurn).toHaveBeenCalledTimes(1);
    expect(postTurn).toHaveBeenCalledWith(deps);
  });
});
