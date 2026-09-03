/**
 * Tests for Heartbeat — workspace health check
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Heartbeat } from "./heartbeat";
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return join(tmpdir(), `heartbeat-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Heartbeat", () => {
  let dir: string;
  let heartbeat: Heartbeat;

  beforeEach(() => {
    dir = tmpDir();
    mkdirSync(dir, { recursive: true });
    heartbeat = new Heartbeat({ workspacePath: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // No file
  // -----------------------------------------------------------------------

  describe("when no HEARTBEAT.md exists", () => {
    it("should return HEARTBEAT_OK with hasFile=false", () => {
      const result = heartbeat.check();
      expect(result.status).toBe("ok");
      expect(result.message).toBe("HEARTBEAT_OK");
      expect(result.hasFile).toBe(false);
      expect(result.tasksCount).toBe(0);
      expect(result.completedCount).toBe(0);
      expect(result.pendingCount).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // All tasks completed
  // -----------------------------------------------------------------------

  describe("when all tasks are completed", () => {
    it("should return HEARTBEAT_OK", () => {
      writeFileSync(
        join(dir, "HEARTBEAT.md"),
        "# HEARTBEAT\n\n- [x] Task 1\n- [x] Task 2\n",
      );
      const result = heartbeat.check();
      expect(result.status).toBe("ok");
      expect(result.message).toBe("HEARTBEAT_OK");
      expect(result.hasFile).toBe(true);
      expect(result.tasksCount).toBe(2);
      expect(result.completedCount).toBe(2);
      expect(result.pendingCount).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Pending tasks
  // -----------------------------------------------------------------------

  describe("when tasks are pending", () => {
    it("should return attention with pending task list", () => {
      writeFileSync(
        join(dir, "HEARTBEAT.md"),
        "# HEARTBEAT\n\n- [x] Done\n- [ ] Not done\n",
      );
      const result = heartbeat.check();
      expect(result.status).toBe("attention");
      expect(result.message).toContain("need attention");
      expect(result.message).toContain("Not done");
      expect(result.pendingCount).toBe(1);
      expect(result.completedCount).toBe(1);
      expect(result.tasksCount).toBe(2);
    });

    it("should report multiple pending tasks", () => {
      writeFileSync(
        join(dir, "HEARTBEAT.md"),
        "# HEARTBEAT\n\n- [ ] Task A\n- [ ] Task B\n- [ ] Task C\n",
      );
      const result = heartbeat.check();
      expect(result.status).toBe("attention");
      expect(result.pendingCount).toBe(3);
      expect(result.completedCount).toBe(0);
      expect(result.message).toContain("3 task(s) need attention");
    });

    it("should include completion ratio in report", () => {
      writeFileSync(
        join(dir, "HEARTBEAT.md"),
        "# HEARTBEAT\n\n- [x] One\n- [x] Two\n- [ ] Three\n",
      );
      const result = heartbeat.check();
      expect(result.message).toContain("Completed: 2/3");
    });
  });

  // -----------------------------------------------------------------------
  // Bullet points without checkboxes
  // -----------------------------------------------------------------------

  describe("bullet points without checkboxes", () => {
    it("should treat dash bullets as pending", () => {
      writeFileSync(
        join(dir, "HEARTBEAT.md"),
        "# HEARTBEAT\n\n- Task without checkbox\n",
      );
      const result = heartbeat.check();
      expect(result.status).toBe("attention");
      expect(result.pendingCount).toBe(1);
      expect(result.tasksCount).toBe(1);
    });

    it("should treat asterisk bullets as pending", () => {
      writeFileSync(
        join(dir, "HEARTBEAT.md"),
        "# HEARTBEAT\n\n* Asterisk task\n",
      );
      const result = heartbeat.check();
      expect(result.status).toBe("attention");
      expect(result.pendingCount).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Disabled heartbeat
  // -----------------------------------------------------------------------

  describe("when disabled", () => {
    it("should return HEARTBEAT_OK even with pending tasks", () => {
      heartbeat.setEnabled(false);
      writeFileSync(
        join(dir, "HEARTBEAT.md"),
        "# HEARTBEAT\n\n- [ ] Pending\n",
      );
      const result = heartbeat.check();
      expect(result.status).toBe("ok");
      expect(result.message).toBe("HEARTBEAT_OK");
      expect(result.hasFile).toBe(false);
    });

    it("should report isEnabled as false", () => {
      heartbeat.setEnabled(false);
      expect(heartbeat.isEnabled()).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // ensureFile
  // -----------------------------------------------------------------------

  describe("ensureFile()", () => {
    it("should create default HEARTBEAT.md if it doesn't exist", () => {
      heartbeat.ensureFile();
      expect(existsSync(join(dir, "HEARTBEAT.md"))).toBe(true);
    });

    it("should not overwrite existing HEARTBEAT.md", () => {
      const content = "# Custom\n\n- [x] My task\n";
      writeFileSync(join(dir, "HEARTBEAT.md"), content);
      heartbeat.ensureFile();
      expect(readFileSync(join(dir, "HEARTBEAT.md"), "utf-8")).toBe(content);
    });

    it("should create a file with default pending tasks", () => {
      heartbeat.ensureFile();
      const result = heartbeat.check();
      expect(result.status).toBe("attention");
      expect(result.tasksCount).toBeGreaterThan(0);
      expect(result.pendingCount).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  describe("error handling", () => {
    it("should return error when HEARTBEAT.md is a directory", () => {
      mkdirSync(join(dir, "HEARTBEAT.md"), { recursive: true });
      const result = heartbeat.check();
      expect(result.status).toBe("error");
      expect(result.message).toContain("Failed to read");
      expect(result.hasFile).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Mixed content
  // -----------------------------------------------------------------------

  describe("mixed content", () => {
    it("should ignore header lines and only count tasks", () => {
      writeFileSync(
        join(dir, "HEARTBEAT.md"),
        [
          "# HEARTBEAT",
          "",
          "## Section 1",
          "- [x] Done task",
          "",
          "## Section 2",
          "- [ ] Pending task",
          "",
          "Some regular text",
        ].join("\n"),
      );
      const result = heartbeat.check();
      expect(result.tasksCount).toBe(2);
      expect(result.completedCount).toBe(1);
      expect(result.pendingCount).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Constructor options
  // -----------------------------------------------------------------------

  describe("constructor", () => {
    it("should default enabled to true", () => {
      const hb = new Heartbeat({ workspacePath: dir });
      expect(hb.isEnabled()).toBe(true);
    });

    it("should accept enabled=false in config", () => {
      const hb = new Heartbeat({ workspacePath: dir, enabled: false });
      expect(hb.isEnabled()).toBe(false);
    });
  });
});
