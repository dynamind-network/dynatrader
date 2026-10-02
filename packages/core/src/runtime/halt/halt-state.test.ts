import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { HaltState } from "./halt-state";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "halt-state-test-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("HaltState", () => {
  it("starts unhalted in a fresh directory", () => {
    const hs = new HaltState(stateDir);
    expect(hs.isHalted()).toBe(false);
    expect(hs.list()).toHaveLength(0);
  });

  it("halts globally with reason and source", () => {
    const hs = new HaltState(stateDir);
    const rec = hs.halt("runaway losses", "agent");
    expect(rec.reason).toBe("runaway losses");
    expect(rec.source).toBe("agent");
    expect(rec.scope).toBe("global");
    expect(hs.isHalted()).toBe(true);
    expect(hs.isHalted("BTC/USDT")).toBe(true);
  });

  it("persists across instances (survives restart)", () => {
    const hs1 = new HaltState(stateDir);
    hs1.halt("test persistence", "cli");

    const hs2 = new HaltState(stateDir);
    expect(hs2.isHalted()).toBe(true);
    expect(hs2.list()[0]!.reason).toBe("test persistence");
  });

  it("symbol-scoped halt only blocks that symbol", () => {
    const hs = new HaltState(stateDir);
    hs.halt("too volatile", "agent", { symbol: "BTC/USDT" });

    expect(hs.isHalted("BTC/USDT")).toBe(true);
    expect(hs.isHalted("ETH/USDT")).toBe(false);
  });

  it("resume lifts global halts", () => {
    const hs = new HaltState(stateDir);
    hs.halt("x", "telegram");
    expect(hs.resume()).toBe(1);
    expect(hs.isHalted()).toBe(false);
  });

  it("resume with symbol lifts only that symbol", () => {
    const hs = new HaltState(stateDir);
    hs.halt("a", "agent", { symbol: "BTC/USDT" });
    hs.halt("b", "agent", { symbol: "ETH/USDT" });

    expect(hs.resume({ symbol: "BTC/USDT" })).toBe(1);
    expect(hs.isHalted("BTC/USDT")).toBe(false);
    expect(hs.isHalted("ETH/USDT")).toBe(true);
  });

  it("is idempotent for identical halts", () => {
    const hs = new HaltState(stateDir);
    hs.halt("same reason", "agent");
    hs.halt("same reason", "agent");
    expect(hs.list()).toHaveLength(1);
  });

  it("writes halt file to disk", () => {
    const hs = new HaltState(stateDir);
    hs.halt("disk check", "system");
    const file = join(stateDir, "halt.json");
    expect(existsSync(file)).toBe(true);
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    expect(parsed.halted).toHaveLength(1);
    expect(parsed.halted[0].reason).toBe("disk check");
  });
});
