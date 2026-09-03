/**
 * PythonStrategyBridge tests
 *
 * Unit coverage with an in-process FakeChild: frame construction, response
 * matching, JSON-RPC error surfacing, timeouts, notifications, and process
 * close handling. One guarded end-to-end test spawns the real Python server
 * and verifies the cross-language wire protocol end to end.
 */

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { PythonStrategyBridge, PythonBridgeError } from "./strategy-bridge";
import type { ChildProcessLike, ChildStdin } from "./strategy-bridge";

// ---------------------------------------------------------------------------
// In-process fake child
// ---------------------------------------------------------------------------

class FakeChild extends EventEmitter implements ChildProcessLike {
  readonly pid = 4242;
  killed = false;
  written = "";

  stdin: ChildStdin = {
    writable: true,
    write: (chunk: string): boolean => {
      this.written += chunk;
      return true;
    },
    end: (): ChildStdin => this.stdin,
  };

  private readonly stdout_ = new EventEmitter();
  private readonly stderr_ = new EventEmitter();

  get stdout(): EventEmitter {
    return this.stdout_;
  }

  get stderr(): EventEmitter {
    return this.stderr_;
  }

  emitData(line: string): void {
    this.stdout_.emit("data", Buffer.from(line + "\n"));
  }

  emitStderr(text: string): void {
    this.stderr_.emit("data", Buffer.from(text));
  }

  emitClose(code: number | null): void {
    this.emit("close", code, null);
  }

  emitError(err: Error): void {
    this.emit("error", err);
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function makeBridge(
  child: FakeChild,
  timeoutMs = 5000,
): { bridge: PythonStrategyBridge; child: FakeChild } {
  const bridge = new PythonStrategyBridge({
    spawnFn: () => child,
    timeoutMs,
  });
  return { bridge, child };
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe("PythonStrategyBridge", () => {
  it("writes a JSON-RPC 2.0 frame and resolves the matching result", async () => {
    const { bridge, child } = makeBridge(new FakeChild());

    const pending = bridge.health();

    await new Promise((r) => setImmediate(r));
    expect(JSON.parse(child.written.trimEnd())).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "health",
      params: {},
    });

    child.emitData(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          status: "ok",
          name: "momentum-sma-crossover",
          pid: 4242,
          uptime_s: 0.04,
        },
      }),
    );

    await expect(pending).resolves.toMatchObject({
      status: "ok",
      name: "momentum-sma-crossover",
    });
  });

  it("increments request ids and routes responses to the right request", async () => {
    const { bridge, child } = makeBridge(new FakeChild());

    const first = bridge.health();
    const second = bridge.info();

    await new Promise((r) => setImmediate(r));
    expect(JSON.parse(child.written.split("\n")[0]!).id).toBe(1);
    expect(JSON.parse(child.written.split("\n")[1]!).id).toBe(2);

    child.emitData(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { name: "info", methods: [] } }));
    child.emitData(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { status: "ok" } }));

    await expect(first).resolves.toMatchObject({ status: "ok" });
    await expect(second).resolves.toMatchObject({ name: "info" });
  });

  it("surfaces JSON-RPC errors as PythonBridgeError with the error code", async () => {
    const { bridge, child } = makeBridge(new FakeChild());

    const pending = bridge.request("strategy.generate_signals", {
      symbols: ["BTCUSDT"],
    });

    await new Promise((r) => setImmediate(r));
    child.emitData(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32601, message: "method not found: nope" },
      }),
    );

    await expect(pending).rejects.toBeInstanceOf(PythonBridgeError);
    await expect(pending).rejects.toMatchObject({ code: -32601 });
  });

  it("rejects a pending request when the process exits", async () => {
    const { bridge, child } = makeBridge(new FakeChild());

    const pending = bridge.health();
    await new Promise((r) => setImmediate(r));
    child.emitClose(1);

    await expect(pending).rejects.toThrow(/exited with code 1/);
    expect(bridge.isRunning()).toBe(false);
  });

  it("rejects pending requests on process error", async () => {
    const { bridge, child } = makeBridge(new FakeChild());

    const pending = bridge.health();
    await new Promise((r) => setImmediate(r));
    child.emitError(new Error("ENOENT"));

    await expect(pending).rejects.toMatchObject({ code: -32000 });
  });

  it("times out a request that never gets a response", async () => {
    const { bridge } = makeBridge(new FakeChild(), 20);

    const pending = bridge.health();
    await expect(pending).rejects.toThrow(/timed out after 20ms/);
  });

  it("emits notifications (no id) as events", async () => {
    const { bridge, child } = makeBridge(new FakeChild());

    const received: Array<{ method: unknown; params: unknown }> = [];
    bridge.on("notification", (notification) => {
      received.push(notification);
    });

    void bridge.request("health", {});
    await new Promise((r) => setImmediate(r));

    child.emitData(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "strategy.signal",
        params: { symbol: "BTCUSDT", action: "buy", confidence: 0.8 },
      }),
    );

    expect(received).toHaveLength(1);
    expect(received[0]!.method).toBe("strategy.signal");
    expect((received[0]!.params as Record<string, unknown>)["action"]).toBe("buy");
  });

  it("ignores non-JSON stdout lines (startup banners)", async () => {
    const { bridge, child } = makeBridge(new FakeChild());

    const pending = bridge.health();
    await new Promise((r) => setImmediate(r));

    child.emitStderr("python boot noise\n");
    child.emitData("not json at all");
    child.emitData(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { status: "ok" } }),
    );

    await expect(pending).resolves.toMatchObject({ status: "ok" });
  });

  it("stop() kills the child and rejects nothing further", async () => {
    const { bridge, child } = makeBridge(new FakeChild());

    const pending = bridge.health();
    await new Promise((r) => setImmediate(r));
    await bridge.stop();

    expect(child.killed).toBe(true);
    await expect(pending).rejects.toMatchObject({ code: -32000 });
  });
});

// ---------------------------------------------------------------------------
// End-to-end test against the real Python server
// ---------------------------------------------------------------------------

function pythonCommand(): string {
  return process.env["DYNAMIND_PYTHON_CMD"] ?? "python";
}

function pythonPackageDir(): string {
  return fileURLToPath(
    new URL("../../../../dynamind-sdks/dynamind-python", import.meta.url),
  );
}

function pythonEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
  };
}

function isPythonServerAvailable(): boolean {
  try {
    const res = spawnSync(
      pythonCommand(),
      ["-c", "import dynamind.server"],
      {
        cwd: pythonPackageDir(),
        env: pythonEnv(),
        timeout: 30000,
      },
    );
    return res.status === 0;
  } catch {
    return false;
  }
}

const available = isPythonServerAvailable();

describe.skipIf(!available)("PythonStrategyBridge (e2e, real process)", () => {
  const packageDir = pythonPackageDir();

  it("spawns the real server, reports health ok and exposes plugin.info", async () => {
    const bridge = new PythonStrategyBridge({
      cwd: packageDir,
      env: pythonEnv(),
      timeoutMs: 30000,
    });

    try {
      const health = await bridge.health();
      expect(health.status).toBe("ok");
      expect(health.name).toBe("momentum-sma-crossover");

      const info = await bridge.info();
      expect(info.name).toBe("momentum-sma-crossover");
      expect(info.methods).toContain("strategy.on_market");
      expect(info.methods).toContain("strategy.risk_check");
    } finally {
      await bridge.stop();
    }
  }, 60000);

  it("computes real backtest metrics across the wire", async () => {
    const bridge = new PythonStrategyBridge({
      cwd: packageDir,
      env: pythonEnv(),
      timeoutMs: 30000,
    });

    try {
      const metrics = await bridge.validateBacktest({
        trades: [
          { pnl: 10 },
          { pnl: -4 },
          { entry_price: 100, exit_price: 110 },
        ],
      });

      expect(metrics.empty).toBe(false);
      expect(metrics.total_trades).toBe(3);
      expect(metrics.win_rate).toBeCloseTo(2 / 3, 4);
      expect(metrics.profit_factor).toBeCloseTo(5.0, 4);
      expect(metrics.net_pnl).toBeCloseTo(16.0, 4);
    } finally {
      await bridge.stop();
    }
  }, 60000);

  it("applies the real risk gate", async () => {
    const bridge = new PythonStrategyBridge({
      cwd: packageDir,
      env: pythonEnv(),
      timeoutMs: 30000,
    });

    try {
      const approved = await bridge.riskCheck(
        { symbol: "BTCUSDT", action: "buy", confidence: 0.8, reasoning: "" },
        0.5,
        1.0,
      );
      expect(approved.approved).toBe(true);
      expect(approved.suggested_size).toBe(0.5);

      const rejected = await bridge.riskCheck(
        { symbol: "BTCUSDT", action: "hold", confidence: 0.9, reasoning: "" },
        0.5,
        1.0,
      );
      expect(rejected.approved).toBe(false);
    } finally {
      await bridge.stop();
    }
  }, 60000);

  it("surfaces a real method-not-found error", async () => {
    const bridge = new PythonStrategyBridge({
      cwd: packageDir,
      env: pythonEnv(),
      timeoutMs: 30000,
    });

    try {
      await expect(
        bridge.request("strategy.no_such_method", {}),
      ).rejects.toMatchObject({ code: -32601 });
    } finally {
      await bridge.stop();
    }
  }, 60000);
});