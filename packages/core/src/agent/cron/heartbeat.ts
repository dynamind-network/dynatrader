/**
 * Heartbeat — workspace health check
 *
 * Reads HEARTBEAT.md from workspace, checks task completion status,
 * and returns HEARTBEAT_OK if all done, or a status report if not.
 *
 * Usage:
 *   const hb = new Heartbeat({ workspacePath: '/path/to/workspace' });
 *   const result = hb.check();
 *   if (result.status === 'ok') { /* all clear *\/ }
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HeartbeatConfig {
  workspacePath: string;
  /** Enable/disable heartbeat checks (default: true) */
  enabled?: boolean;
}

export interface HeartbeatResult {
  status: "ok" | "attention" | "error";
  message: string;
  hasFile: boolean;
  tasksCount: number;
  completedCount: number;
  pendingCount: number;
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

export class Heartbeat {
  private workspacePath: string;
  private enabled: boolean;

  constructor(config: HeartbeatConfig) {
    this.workspacePath = config.workspacePath;
    this.enabled = config.enabled ?? true;
  }

  /**
   * Run a heartbeat check. Returns HEARTBEAT_OK if all tasks are done,
   * or a status report if something needs attention.
   */
  check(): HeartbeatResult {
    if (!this.enabled) {
      return {
        status: "ok",
        message: "HEARTBEAT_OK",
        hasFile: false,
        tasksCount: 0,
        completedCount: 0,
        pendingCount: 0,
      };
    }

    const heartbeatPath = join(this.workspacePath, "HEARTBEAT.md");

    if (!existsSync(heartbeatPath)) {
      return {
        status: "ok",
        message: "HEARTBEAT_OK",
        hasFile: false,
        tasksCount: 0,
        completedCount: 0,
        pendingCount: 0,
      };
    }

    try {
      const content = readFileSync(heartbeatPath, "utf-8");
      return this.parseHeartbeat(content);
    } catch {
      return {
        status: "error",
        message: "Failed to read HEARTBEAT.md",
        hasFile: true,
        tasksCount: 0,
        completedCount: 0,
        pendingCount: 0,
      };
    }
  }

  /**
   * Parse HEARTBEAT.md content and check task status.
   * Supports:
   *   - [x] completed task
   *   - [ ] pending task
   *   - * task (no checkbox, treated as pending)
   */
  private parseHeartbeat(content: string): HeartbeatResult {
    const lines = content.split("\n");
    let tasksCount = 0;
    let completedCount = 0;
    let pendingCount = 0;
    const pendingTasks: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();

      // Match checkbox tasks: "- [x] task", "* [ ] task", "[x] task", "[ ] task"
      const checkboxMatch = trimmed.match(
        /^[-*]?\s*\[([ xX])\]\s*(.*)/,
      );
      if (checkboxMatch) {
        tasksCount++;
        const mark = checkboxMatch[1];
        const taskText = checkboxMatch[2];
        if (mark.toLowerCase() === "x") {
          completedCount++;
        } else {
          pendingCount++;
          pendingTasks.push(taskText);
        }
      }
      // Check for bullet points without checkboxes (treated as pending)
      else if (/^[-*]\s+/.test(trimmed) && !trimmed.startsWith("#")) {
        tasksCount++;
        pendingCount++;
        pendingTasks.push(trimmed.replace(/^[-*]\s+/, ""));
      }
    }

    if (pendingCount === 0) {
      return {
        status: "ok",
        message: "HEARTBEAT_OK",
        hasFile: true,
        tasksCount,
        completedCount,
        pendingCount,
      };
    }

    // Build attention report
    const report = [
      `HEARTBEAT: ${pendingCount} task(s) need attention`,
      "",
      ...pendingTasks.map((t) => `- ${t}`),
      "",
      `Completed: ${completedCount}/${tasksCount}`,
    ].join("\n");

    return {
      status: "attention",
      message: report,
      hasFile: true,
      tasksCount,
      completedCount,
      pendingCount,
    };
  }

  /**
   * Generate a default HEARTBEAT.md if it doesn't exist.
   */
  ensureFile(): void {
    const heartbeatPath = join(this.workspacePath, "HEARTBEAT.md");
    if (!existsSync(heartbeatPath)) {
      writeFileSync(
        heartbeatPath,
        [
          "# HEARTBEAT.md",
          "",
          "This file is checked periodically by the heartbeat cron.",
          "Mark tasks as complete with [x] or leave them as [ ] for attention.",
          "",
          "## Tasks",
          "",
          "- [ ] Configure trading symbols",
          "- [ ] Set up risk parameters",
          "- [ ] Review first trade",
        ].join("\n"),
      );
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }
}
